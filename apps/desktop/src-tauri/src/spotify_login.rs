//! The Spotify login window (stage 7.4): the user's own Spotify account in the desktop app,
//! without the login's cookie ever reaching page JavaScript.
//!
//! - **Logging in** (`login`) opens a window of its own on Spotify's login page,
//!   `accounts.spotify.com`, in a private webview: its cookies live in memory, apart from the main
//!   window's, and go when the window does. FXM never sees the password: the user types it into
//!   Spotify's page. While the window is open, Rust looks in its cookie store for Spotify's login
//!   cookie, `sp_dc`, which Spotify sets for `spotify.com` once the user is logged in. When it
//!   appears, Rust keeps it in the operating system's credential store (Keychain Services on
//!   macOS, the Credential Manager on Windows, the Secret Service on Linux), closes the window and
//!   tells the main window (`fxm-spotify-login`).
//! - **A token** (`token`): Rust calls `open.spotify.com/api/token` with the cookie and the query
//!   parameters the web app's Spotify provider computes (the TOTP), and answers the status and
//!   only the token's fields: the access token, its expiry, whether it is anonymous, and whether
//!   the TOTP's version expired. The cookie goes on this one request only, never through the HTTP
//!   plugin, so Spotify needs no `unsafe-headers` for it. At most ten requests a minute, as FXM
//!   Connect's bridge allows.
//! - **Logging out** (`logout`) deletes the cookie from the credential store and from FXM's
//!   memory, and clears and closes the login window if it is open.
//!
//! The login window gets no capability, so its pages can call no command. It loads only `https:`
//! pages (and the `about:` and `blob:` frames pages make), opens no other window, and
//! its title names the site it shows, as an address bar would.
//!
//! The cookie is read from the credential store once per run, then kept in memory, zeroed when it
//! is dropped. It is never logged, and messages never carry it or a token.
//!
//! Error codes (`CommandError`): `logged-out`, `keychain` (the credential store failed or is
//! missing), `rate-limited`, `network`, `too-large`, `bad-request`, `not-focused` and `window`.

use std::{
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
    plugin::{Builder, TauriPlugin},
    webview::{Cookie, NewWindowResponse, PageLoadEvent},
};
use tauri_plugin_http::reqwest::{
    self,
    header::{ACCEPT, COOKIE, HeaderValue},
    redirect::Policy,
};
use zeroize::Zeroizing;

use crate::{MAIN_WINDOW, user_hosts::CommandError};

/// The plugin's name: its commands are `plugin:fxm-spotify|login` and so on.
pub const PLUGIN: &str = "fxm-spotify";

/// The login window's label. No capability names it.
pub const LOGIN_WINDOW: &str = "spotify-login";

/// Spotify's login page, which goes on to the web player once the user is logged in.
pub const LOGIN_URL: &str =
    "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F";

/// The web player's token endpoint.
pub const TOKEN_URL: &str = "https://open.spotify.com/api/token";

/// Spotify's login cookie.
pub const COOKIE_NAME: &str = "sp_dc";

/// The site the login cookie belongs to: `spotify.com` or a host under it.
pub const COOKIE_SITE: &str = "spotify.com";

/// The event the main window receives when the login changed, with [`LoginState`].
pub const LOGIN_EVENT: &str = "fxm-spotify-login";

/// The account name of the login's entry in the credential store, under the app's identifier.
pub const CREDENTIAL_ACCOUNT: &str = "spotify-login";

/// How long one token request may take.
pub const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);

/// The largest token answer FXM reads.
pub const MAX_TOKEN_RESPONSE_BYTES: usize = 64 * 1024;

/// At most this many token requests in [`RATE_WINDOW`], as FXM Connect's bridge allows.
pub const RATE_LIMIT: usize = 10;

/// The window of [`RATE_LIMIT`].
pub const RATE_WINDOW: Duration = Duration::from_secs(60);

/// How often Rust looks for the login cookie while the login window is open.
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// The browser User-Agent for when the web app sends none it can use: a desktop Chrome, as
/// `FALLBACK_BROWSER_USER_AGENT` in `packages/platform/src/desktop.ts`.
pub const FALLBACK_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/// The fields of the token endpoint's answer that reach the web app: what the Spotify provider
/// reads (`packages/sources/src/spotify/token.ts`), and nothing else.
pub const TOKEN_FIELDS: &[&str] = &[
    "accessToken",
    "accessTokenExpirationTimestampMs",
    "isAnonymous",
    "totpVerExpired",
];

/// The login window's title, before and between pages.
const WINDOW_TITLE: &str = "Log in to Spotify";

/// Whether the user is logged in to Spotify in FXM, as the main window hears it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginState {
    /// Whether FXM keeps a login cookie.
    pub logged_in: bool,
}

/// Where the login cookie is kept between runs.
pub trait SecretStore: Send + Sync {
    /// The cookie, or `None` when there is none.
    fn read(&self) -> Result<Option<Zeroizing<String>>, CommandError>;
    /// Keeps `secret`, replacing any earlier one.
    fn write(&self, secret: &str) -> Result<(), CommandError>;
    /// Deletes the cookie. Deleting none is fine.
    fn delete(&self) -> Result<(), CommandError>;
}

/// The operating system's credential store, through the keyring crate: an entry named after the
/// app's identifier, so the smoke build's own identifier never touches the app's login.
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    /// The store for the app identified as `service` (`io.github.pratyayops.fxm`).
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, CommandError> {
        keyring::Entry::new(&self.service, CREDENTIAL_ACCOUNT).map_err(keychain_error)
    }
}

impl SecretStore for KeychainStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, CommandError> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keychain_error(error)),
        }
    }

    fn write(&self, secret: &str) -> Result<(), CommandError> {
        self.entry()?.set_password(secret).map_err(keychain_error)
    }

    fn delete(&self) -> Result<(), CommandError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keychain_error(error)),
        }
    }
}

/// The [`CommandError`] for a failure of the credential store. Only the error's text, which never
/// holds the secret (`BadEncoding` and `BadDataFormat` keep their bytes out of it).
fn keychain_error(error: keyring::Error) -> CommandError {
    CommandError::new(
        "keychain",
        format!("FXM could not use the system's credential store for your Spotify login: {error}"),
    )
}

/// The login cookie as FXM last read or set it.
enum Cached {
    /// Not read from the credential store yet.
    Unknown,
    /// There is none.
    Absent,
    /// The cookie's value.
    Present(Zeroizing<String>),
}

/// At most `max` requests in any `window`.
#[derive(Debug)]
struct RateLimiter {
    max: usize,
    window: Duration,
    times: Vec<Instant>,
}

impl RateLimiter {
    fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            times: Vec::new(),
        }
    }

    /// Takes a slot at `now`, or says how long until one frees up.
    fn acquire(&mut self, now: Instant) -> Result<(), Duration> {
        self.times
            .retain(|time| now.saturating_duration_since(*time) < self.window);
        if self.times.len() >= self.max {
            let oldest = self.times[self.times.len() - self.max];
            return Err(self
                .window
                .saturating_sub(now.saturating_duration_since(oldest)));
        }
        self.times.push(now);
        Ok(())
    }
}

/// The query parameters of a token request, in the forms FXM Connect's bridge accepts
/// (`SPOTIFY_TOKEN_PARAM_FORMS` in `packages/platform/src/connect.ts`).
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenParams {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    product_type: Option<String>,
    #[serde(default)]
    totp: Option<String>,
    #[serde(default)]
    totp_server: Option<String>,
    #[serde(default)]
    totp_ver: Option<String>,
}

/// A letter, then up to 31 letters, digits, `_` or `-`.
fn is_word(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
        && value.len() <= 32
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Between `min` and `max` digits.
fn is_digits(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Whether a token parameter's value has the form Spotify takes.
type ParamCheck = fn(&str) -> bool;

impl TokenParams {
    /// The parameters given, in a fixed order, each checked; refuses one in another form.
    pub fn pairs(&self) -> Result<Vec<(&'static str, &str)>, CommandError> {
        let fields: [(&'static str, &Option<String>, ParamCheck); 5] = [
            ("reason", &self.reason, is_word),
            ("productType", &self.product_type, is_word),
            ("totp", &self.totp, |value| is_digits(value, 6, 10)),
            ("totpServer", &self.totp_server, |value| {
                is_digits(value, 6, 10)
            }),
            ("totpVer", &self.totp_ver, |value| is_digits(value, 1, 4)),
        ];
        let mut pairs = Vec::new();
        for (name, value, valid) in fields {
            if let Some(value) = value {
                if !valid(value) {
                    return Err(CommandError::new(
                        "bad-request",
                        format!("The token request's {name} is not in the form Spotify takes"),
                    ));
                }
                pairs.push((name, value.as_str()));
            }
        }
        Ok(pairs)
    }
}

/// What the token endpoint answered: its status and only the token's fields of its JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TokenAnswer {
    /// The HTTP status.
    pub status: u16,
    /// The [`TOKEN_FIELDS`] of the JSON body; `null` when the body was not a JSON object.
    pub json: Value,
}

/// Only the [`TOKEN_FIELDS`] of a token answer's JSON.
pub fn token_json(value: Value) -> Value {
    let Value::Object(mut fields) = value else {
        return Value::Null;
    };
    let kept: Map<String, Value> = TOKEN_FIELDS
        .iter()
        .filter_map(|name| {
            fields
                .remove(*name)
                .map(|value| ((*name).to_owned(), value))
        })
        .collect();
    Value::Object(kept)
}

/// The User-Agent for Spotify: `requested` when it reads as a browser's, as
/// `desktopBrowserUserAgent` in `packages/platform/src/desktop.ts` makes it, else
/// [`FALLBACK_USER_AGENT`].
pub fn browser_agent(requested: Option<&str>) -> String {
    requested
        .filter(|agent| {
            agent.starts_with("Mozilla/5.0 (")
                && agent.len() <= 512
                && agent.bytes().all(|byte| (0x20..0x7f).contains(&byte))
        })
        .map_or_else(|| FALLBACK_USER_AGENT.to_owned(), str::to_owned)
}

/// Whether `domain` is `spotify.com` or a host under it.
fn is_spotify_site(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == COOKIE_SITE || domain.ends_with(&format!(".{COOKIE_SITE}"))
}

/// Whether `value` can go in a `Cookie` header as it is: printable ASCII without spaces, quotes,
/// commas, semicolons or backslashes, at most 4 KiB.
fn is_cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value
            .bytes()
            .all(|byte| (0x21..0x7f).contains(&byte) && !b"\";,\\".contains(&byte))
}

/// The login cookie among the login window's cookies: `sp_dc` for `spotify.com`, with a value
/// that can go in a header.
pub fn login_cookie(cookies: &[Cookie<'_>]) -> Option<String> {
    cookies
        .iter()
        .find(|cookie| {
            cookie.name() == COOKIE_NAME
                && cookie.domain().is_some_and(is_spotify_site)
                && is_cookie_value(cookie.value())
        })
        .map(|cookie| cookie.value().to_owned())
}

/// Whether the login window may load `url`: `https:` pages, and the `about:` and `blob:` frames
/// that pages make (a `blob:` URL carries the site that made it). Never FXM's own schemes, files,
/// plain `http:`, or `data:`, whose page would name no site at all. WebKit asks about frames too,
/// so the rule can't tell a page from a frame.
pub fn allowed_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "about" | "blob")
}

/// The login window's title for the page at `url`: it names the site, as an address bar would;
/// for a `blob:` page, the site that made it.
pub fn window_title(url: &Url) -> String {
    let site = match url.scheme() {
        "https" => url.host_str().map(str::to_owned),
        "blob" => Url::parse(url.path())
            .ok()
            .filter(|inner| inner.scheme() == "https")
            .and_then(|inner| inner.host_str().map(str::to_owned)),
        _ => None,
    };
    match site {
        Some(host) => format!("{WINDOW_TITLE} – {host}"),
        None => WINDOW_TITLE.to_owned(),
    }
}

/// An error and its causes on one line, without the request's URL.
fn network_error(error: reqwest::Error) -> CommandError {
    if error.is_timeout() {
        return CommandError::new(
            "network",
            format!(
                "Spotify did not answer within {} seconds",
                TOKEN_TIMEOUT.as_secs()
            ),
        );
    }
    let error = error.without_url();
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    CommandError::new("network", format!("FXM could not reach Spotify: {text}"))
}

fn too_large() -> CommandError {
    CommandError::new(
        "too-large",
        format!(
            "Spotify's answer is larger than {} KiB",
            MAX_TOKEN_RESPONSE_BYTES / 1024
        ),
    )
}

/// Asks `url` for a token with the login cookie `cookie`: a `GET` with `pairs` as its query, the
/// cookie, `Accept: application/json` and `user_agent`, following no redirect and reading at most
/// [`MAX_TOKEN_RESPONSE_BYTES`] within [`TOKEN_TIMEOUT`].
async fn request_token(
    url: &str,
    cookie: &str,
    pairs: &[(&str, &str)],
    user_agent: &str,
) -> Result<TokenAnswer, CommandError> {
    let mut target =
        Url::parse(url).map_err(|_| CommandError::new("bad-request", "No token endpoint"))?;
    if !pairs.is_empty() {
        let mut query = target.query_pairs_mut();
        for (name, value) in pairs {
            query.append_pair(name, value);
        }
    }
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(TOKEN_TIMEOUT)
        .user_agent(user_agent)
        .build()
        .map_err(network_error)?;
    let header = Zeroizing::new(format!("{COOKIE_NAME}={cookie}"));
    let mut cookie_header = HeaderValue::from_str(&header)
        .map_err(|_| CommandError::new("logged-out", "The kept Spotify login is unusable"))?;
    cookie_header.set_sensitive(true);
    let mut response = client
        .get(target)
        .header(ACCEPT, "application/json")
        .header(COOKIE, cookie_header)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TOKEN_RESPONSE_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len() + chunk.len() > MAX_TOKEN_RESPONSE_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok(TokenAnswer {
        status,
        json: token_json(json),
    })
}

/// The user's Spotify login in the desktop app: the cookie, where it is kept, the token requests'
/// rate limit, and the callers waiting for the login window.
pub struct SpotifyLogin {
    store: Box<dyn SecretStore>,
    cookie: Mutex<Cached>,
    limiter: Mutex<RateLimiter>,
    /// The callers of `login` waiting for the login window to end.
    waiting: Mutex<Vec<tauri::async_runtime::Sender<bool>>>,
    /// Counts login windows, so a watcher knows when its window was replaced.
    generation: AtomicU64,
    token_url: String,
}

impl SpotifyLogin {
    /// The login kept in `store`.
    pub fn new(store: Box<dyn SecretStore>) -> Self {
        Self::with_token_url(store, TOKEN_URL)
    }

    fn with_token_url(store: Box<dyn SecretStore>, token_url: &str) -> Self {
        Self {
            store,
            cookie: Mutex::new(Cached::Unknown),
            limiter: Mutex::new(RateLimiter::new(RATE_LIMIT, RATE_WINDOW)),
            waiting: Mutex::default(),
            generation: AtomicU64::new(0),
            token_url: token_url.to_owned(),
        }
    }

    fn cached(&self) -> MutexGuard<'_, Cached> {
        self.cookie.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The cookie, read from the store on first use. Blocks while the store answers.
    fn cookie(&self) -> Result<Option<Zeroizing<String>>, CommandError> {
        let mut cached = self.cached();
        if matches!(*cached, Cached::Unknown) {
            *cached = match self.store.read()? {
                Some(secret) if is_cookie_value(&secret) => Cached::Present(secret),
                _ => Cached::Absent,
            };
        }
        Ok(match &*cached {
            Cached::Present(secret) => Some(secret.clone()),
            _ => None,
        })
    }

    /// Whether a login is kept. Blocks while the store answers.
    pub fn state(&self) -> Result<LoginState, CommandError> {
        Ok(LoginState {
            logged_in: self.cookie()?.is_some(),
        })
    }

    /// Keeps `cookie`, the one the login window got, in the store and in memory.
    pub fn keep(&self, cookie: &str) -> Result<(), CommandError> {
        if !is_cookie_value(cookie) {
            return Err(CommandError::new(
                "bad-request",
                "The login window's cookie is unusable",
            ));
        }
        self.store.write(cookie)?;
        *self.cached() = Cached::Present(Zeroizing::new(cookie.to_owned()));
        Ok(())
    }

    /// Forgets the login: deletes it from the store, and from memory even if that fails.
    pub fn forget(&self) -> Result<(), CommandError> {
        *self.cached() = Cached::Absent;
        self.store.delete()
    }

    /// Asks Spotify for a token with the kept login (see [`request_token`]).
    pub async fn token(
        &self,
        params: &TokenParams,
        user_agent: Option<&str>,
    ) -> Result<TokenAnswer, CommandError> {
        let pairs = params.pairs()?;
        let cookie = self.cookie()?.ok_or_else(|| {
            CommandError::new("logged-out", "You are not logged in to Spotify in FXM")
        })?;
        let limited = self
            .limiter
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .acquire(Instant::now());
        if let Err(wait) = limited {
            return Err(CommandError::new(
                "rate-limited",
                format!(
                    "FXM asks Spotify for at most {RATE_LIMIT} tokens a minute: try again in {} s",
                    wait.as_secs().max(1)
                ),
            ));
        }
        request_token(&self.token_url, &cookie, &pairs, &browser_agent(user_agent)).await
    }

    /// Registers a caller waiting for the login window to end.
    fn wait(&self) -> tauri::async_runtime::Receiver<bool> {
        let (sender, receiver) = tauri::async_runtime::channel(1);
        self.waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(sender);
        receiver
    }

    /// Tells every waiting caller how the login window ended.
    fn finish(&self, logged_in: bool) {
        let waiting =
            std::mem::take(&mut *self.waiting.lock().unwrap_or_else(PoisonError::into_inner));
        for sender in waiting {
            let _ = sender.try_send(logged_in);
        }
    }
}

/// The plugin's state.
type Shared = Arc<SpotifyLogin>;

/// Runs `work` on a thread for blocking work: the credential store may take a while.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::new("keychain", error.to_string()))?
}

/// Tells the main window whether the user is logged in now.
fn announce<R: Runtime>(app: &AppHandle<R>, logged_in: bool) {
    // Best effort: the page may be loading.
    let _ = app.emit_to(MAIN_WINDOW, LOGIN_EVENT, LoginState { logged_in });
}

/// Whether a login is kept.
#[tauri::command]
async fn status(spotify: State<'_, Shared>) -> Result<LoginState, CommandError> {
    let spotify = spotify.inner().clone();
    blocking(move || spotify.state()).await
}

/// Whether `window` is visible, not minimized, and has the focus.
fn in_front<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(true)
        && window.is_focused().unwrap_or(false)
}

/// Opens the login window, or brings it forward when it is open, and waits until it ends:
/// answers whether the user logged in. Only from the main window while it is in front
/// (`not-focused`). `user_agent` is the browser agent the window's pages see.
#[tauri::command]
async fn login<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    spotify: State<'_, Shared>,
    user_agent: Option<String>,
) -> Result<LoginState, CommandError> {
    if window.label() != MAIN_WINDOW || !in_front(&window) {
        return Err(CommandError::new(
            "not-focused",
            "FXM opens Spotify's login only while its window is in front",
        ));
    }
    let shared = spotify.inner().clone();
    let mut finished = shared.wait();
    if let Some(open) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = open.unminimize();
        let _ = open.show();
        let _ = open.set_focus();
    } else if let Err(error) = open_login_window(&app, &shared, user_agent.as_deref()) {
        shared.finish(false);
        return Err(error);
    }
    let logged_in = finished.recv().await.unwrap_or(false);
    Ok(LoginState { logged_in })
}

/// Opens the login window and starts watching its cookies.
fn open_login_window<R: Runtime>(
    app: &AppHandle<R>,
    spotify: &Shared,
    user_agent: Option<&str>,
) -> Result<(), CommandError> {
    let url: Url = LOGIN_URL.parse().expect("a valid URL");
    let generation = spotify.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let window = WebviewWindowBuilder::new(app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title(WINDOW_TITLE)
        .inner_size(480.0, 760.0)
        .min_inner_size(360.0, 560.0)
        .center()
        .focused(true)
        // Its cookies stay in memory, apart from the main window's, and go with the window.
        .incognito(true)
        .user_agent(&browser_agent(user_agent))
        .on_navigation(allowed_navigation)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = window.set_title(&window_title(payload.url()));
            }
        })
        .build()
        .map_err(|error| {
            CommandError::new(
                "window",
                format!("FXM could not open Spotify's login: {error}"),
            )
        })?;
    let closed = spotify.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed)
            && closed.generation.load(Ordering::Acquire) == generation
        {
            closed.finish(false);
        }
    });
    watch_login(app.clone(), spotify.clone(), generation);
    Ok(())
}

/// Looks for the login cookie in the login window's cookie store every [`POLL_INTERVAL`], on a
/// thread of its own (WebView2 deadlocks when its cookies are read on the main thread), for as
/// long as the window of `generation` is open. Once the cookie is there, keeps it, closes the
/// window and tells the main window.
fn watch_login<R: Runtime>(app: AppHandle<R>, spotify: Shared, generation: u64) {
    let watcher = spotify.clone();
    let spawned = thread::Builder::new()
        .name("fxm-spotify-login".into())
        .spawn(move || {
            let spotify = watcher;
            loop {
                thread::sleep(POLL_INTERVAL);
                if spotify.generation.load(Ordering::Acquire) != generation {
                    return;
                }
                let Some(window) = app.get_webview_window(LOGIN_WINDOW) else {
                    return;
                };
                let Ok(cookies) = window.cookies() else {
                    continue;
                };
                let Some(cookie) = login_cookie(&cookies).map(Zeroizing::new) else {
                    continue;
                };
                let kept = spotify.keep(&cookie).is_ok();
                if kept {
                    announce(&app, true);
                }
                // Before the window goes, whose end would tell the callers it was cancelled.
                spotify.finish(kept);
                let _ = window.destroy();
                return;
            }
        });
    if spawned.is_err() {
        spotify.finish(false);
    }
}

/// Forgets the login: deletes the cookie from the credential store and from memory, and clears and
/// closes the login window if it is open.
#[tauri::command]
async fn logout<R: Runtime>(
    app: AppHandle<R>,
    spotify: State<'_, Shared>,
) -> Result<(), CommandError> {
    let shared = spotify.inner().clone();
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.clear_all_browsing_data();
        let _ = window.destroy();
    }
    shared.finish(false);
    let forgotten = blocking(move || shared.forget()).await;
    announce(&app, false);
    forgotten
}

/// Asks Spotify for a token with the kept login, and answers the status and the token's fields.
#[tauri::command]
async fn token(
    spotify: State<'_, Shared>,
    params: TokenParams,
    user_agent: Option<String>,
) -> Result<TokenAnswer, CommandError> {
    let shared = spotify.inner().clone();
    // The first read of the credential store blocks; later ones answer from memory.
    let reader = shared.clone();
    blocking(move || reader.cookie().map(|_| ())).await?;
    shared.token(&params, user_agent.as_deref()).await
}

/// The Spotify login plugin: its commands, which `fxm-spotify:default` grants to the main window
/// only. The login window goes with the main window, so closing that one still quits FXM where it
/// quits.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN)
        .setup(|app, _api| {
            let store = KeychainStore::new(app.config().identifier.clone());
            let shared: Shared = Arc::new(SpotifyLogin::new(Box::new(store)));
            app.manage(shared);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![status, login, logout, token])
        .on_event(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = event
                && label == MAIN_WINDOW
                && let Some(window) = app.get_webview_window(LOGIN_WINDOW)
            {
                let _ = window.destroy();
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader, Write as _},
        net::TcpListener,
    };

    use super::*;

    /// A credential store in memory.
    #[derive(Default)]
    struct MemoryStore {
        secret: Mutex<Option<String>>,
        reads: AtomicU64,
        fail: bool,
    }

    impl SecretStore for Arc<MemoryStore> {
        fn read(&self) -> Result<Option<Zeroizing<String>>, CommandError> {
            self.reads.fetch_add(1, Ordering::Relaxed);
            if self.fail {
                return Err(CommandError::new("keychain", "no credential store"));
            }
            Ok(self.secret.lock().unwrap().clone().map(Zeroizing::new))
        }

        fn write(&self, secret: &str) -> Result<(), CommandError> {
            *self.secret.lock().unwrap() = Some(secret.to_owned());
            Ok(())
        }

        fn delete(&self) -> Result<(), CommandError> {
            *self.secret.lock().unwrap() = None;
            Ok(())
        }
    }

    const COOKIE: &str = "AQBfake-login-cookie_value";

    fn params() -> TokenParams {
        TokenParams {
            reason: Some("transport".into()),
            product_type: Some("web-player".into()),
            totp: Some("123456".into()),
            totp_server: Some("654321".into()),
            totp_ver: Some("61".into()),
        }
    }

    fn login_with(store: &Arc<MemoryStore>, url: &str) -> SpotifyLogin {
        SpotifyLogin::with_token_url(Box::new(store.clone()), url)
    }

    /// A test server answering every request with `response`, recording each request's head.
    fn serve(response: Vec<u8>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if matches!(line.as_str(), "" | "\r\n" | "\n") {
                        break;
                    }
                    head.push_str(&line);
                }
                log.lock().unwrap().push(head);
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        (port, seen)
    }

    fn http(status: &str, headers: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn token_params_take_the_forms_fxm_connect_accepts() {
        assert_eq!(
            params().pairs().unwrap(),
            [
                ("reason", "transport"),
                ("productType", "web-player"),
                ("totp", "123456"),
                ("totpServer", "654321"),
                ("totpVer", "61"),
            ]
        );
        assert!(TokenParams::default().pairs().unwrap().is_empty());
        let bad = [
            TokenParams {
                reason: Some("1abc".into()),
                ..params()
            },
            TokenParams {
                reason: Some("a b".into()),
                ..params()
            },
            TokenParams {
                reason: Some("a".repeat(33)),
                ..params()
            },
            TokenParams {
                product_type: Some("web&player".into()),
                ..params()
            },
            TokenParams {
                totp: Some("12345".into()),
                ..params()
            },
            TokenParams {
                totp: Some("12345678901".into()),
                ..params()
            },
            TokenParams {
                totp_server: Some("12a456".into()),
                ..params()
            },
            TokenParams {
                totp_ver: Some("12345".into()),
                ..params()
            },
            TokenParams {
                totp_ver: Some(String::new()),
                ..params()
            },
        ];
        for params in bad {
            assert_eq!(
                params.pairs().unwrap_err().code,
                "bad-request",
                "{params:?}"
            );
        }
        // Fields Spotify's token call doesn't take are refused outright.
        let parsed: Result<TokenParams, _> =
            serde_json::from_str(r#"{"reason":"transport","cookie":"x"}"#);
        assert!(parsed.is_err());
    }

    #[test]
    fn only_the_tokens_fields_reach_the_web_app() {
        let answer = serde_json::json!({
            "clientId": "client",
            "accessToken": "BQ-token",
            "accessTokenExpirationTimestampMs": 1_800_000_000_000_u64,
            "isAnonymous": false,
            "_notes": "Usage of this endpoint is not permitted",
            "cookie": "sp_dc=leak",
        });
        assert_eq!(
            token_json(answer),
            serde_json::json!({
                "accessToken": "BQ-token",
                "accessTokenExpirationTimestampMs": 1_800_000_000_000_u64,
                "isAnonymous": false,
            })
        );
        assert_eq!(
            token_json(serde_json::json!({ "totpVerExpired": true, "error": "x" })),
            serde_json::json!({ "totpVerExpired": true })
        );
        assert_eq!(token_json(serde_json::json!([1, 2])), Value::Null);
        assert_eq!(token_json(Value::Null), Value::Null);
    }

    #[test]
    fn spotify_sees_a_browser_agent() {
        let safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
        assert_eq!(browser_agent(Some(safari)), safari);
        for refused in [
            None,
            Some("FXM/0.6.0"),
            Some("tauri-plugin-http/2.8.2"),
            Some("Mozilla/5.0 (X)\r\nCookie: a=b"),
            Some(&*"Mozilla/5.0 (".repeat(50)),
        ] {
            assert_eq!(browser_agent(refused), FALLBACK_USER_AGENT, "{refused:?}");
        }
    }

    #[test]
    fn the_login_cookie_comes_from_spotify_only() {
        let cookie = |name: &str, value: &str, domain: &str| {
            Cookie::build((name.to_owned(), value.to_owned()))
                .domain(domain.to_owned())
                .build()
        };
        let found = [
            cookie("sp_t", "tracking", ".spotify.com"),
            cookie("sp_dc", COOKIE, ".spotify.com"),
        ];
        assert_eq!(login_cookie(&found).as_deref(), Some(COOKIE));
        assert_eq!(
            login_cookie(&[cookie("sp_dc", COOKIE, "accounts.spotify.com")]).as_deref(),
            Some(COOKIE)
        );
        for refused in [
            cookie("sp_dc", COOKIE, ".evil.com"),
            cookie("sp_dc", COOKIE, "spotify.com.evil.com"),
            cookie("sp_dc", COOKIE, "notspotify.com"),
            cookie("sp_dc", "", ".spotify.com"),
            cookie("sp_dc", "a;b", ".spotify.com"),
            cookie("sp_dc", "a b", ".spotify.com"),
            cookie("SP_DC", COOKIE, ".spotify.com"),
            cookie("sp_key", COOKIE, ".spotify.com"),
        ] {
            assert_eq!(
                login_cookie(std::slice::from_ref(&refused)),
                None,
                "{refused}"
            );
        }
        assert_eq!(login_cookie(&[]), None);
    }

    #[test]
    fn the_login_window_loads_https_pages_only() {
        let url = |text: &str| text.parse::<Url>().unwrap();
        for allowed in [
            LOGIN_URL,
            "https://open.spotify.com/",
            "https://challenge.spotify.com/c/abc",
            "https://www.google.com/recaptcha/api2/anchor",
            "about:blank",
            "about:srcdoc",
            "blob:https://accounts.spotify.com/1234",
        ] {
            assert!(allowed_navigation(&url(allowed)), "{allowed}");
        }
        for refused in [
            "http://accounts.spotify.com/login",
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "fxm-download://localhost/abc",
            "fxm-eval://localhost/eval.html",
            "file:///etc/passwd",
            "spotify:track:1",
            "javascript:alert(1)",
            "data:text/html,<h1>Log in</h1>",
        ] {
            assert!(!allowed_navigation(&url(refused)), "{refused}");
        }
    }

    #[test]
    fn the_window_title_names_the_site() {
        let title = |text: &str| window_title(&text.parse::<Url>().unwrap());
        assert_eq!(title(LOGIN_URL), "Log in to Spotify – accounts.spotify.com");
        assert_eq!(
            title("https://www.facebook.com/login"),
            "Log in to Spotify – www.facebook.com"
        );
        assert_eq!(
            title("blob:https://accounts.spotify.com/1234"),
            "Log in to Spotify – accounts.spotify.com"
        );
        assert_eq!(title("about:blank"), WINDOW_TITLE);
        assert_eq!(title("blob:null/1234"), WINDOW_TITLE);
    }

    #[test]
    fn logging_in_and_out_keeps_and_forgets_the_cookie() {
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, TOKEN_URL);
        assert_eq!(spotify.state().unwrap(), LoginState { logged_in: false });
        spotify.keep(COOKIE).unwrap();
        assert_eq!(store.secret.lock().unwrap().as_deref(), Some(COOKIE));
        assert_eq!(spotify.state().unwrap(), LoginState { logged_in: true });
        // A new run reads it from the store, once.
        let restarted = login_with(&store, TOKEN_URL);
        assert!(restarted.state().unwrap().logged_in);
        assert!(restarted.state().unwrap().logged_in);
        assert_eq!(store.reads.load(Ordering::Relaxed), 2);
        restarted.forget().unwrap();
        assert_eq!(*store.secret.lock().unwrap(), None);
        assert!(!restarted.state().unwrap().logged_in);
        assert_eq!(spotify.keep("bad value").unwrap_err().code, "bad-request");
    }

    #[test]
    fn a_failing_credential_store_says_so() {
        let store = Arc::new(MemoryStore {
            fail: true,
            ..MemoryStore::default()
        });
        let spotify = login_with(&store, TOKEN_URL);
        assert_eq!(spotify.state().unwrap_err().code, "keychain");
        assert_eq!(
            run(spotify.token(&params(), None)).unwrap_err().code,
            "keychain"
        );
    }

    #[test]
    fn credential_store_errors_never_carry_the_secret() {
        let error = keychain_error(keyring::Error::BadEncoding(COOKIE.as_bytes().to_vec()));
        assert_eq!(error.code, "keychain");
        assert!(!error.message.contains(COOKIE), "{}", error.message);
    }

    #[test]
    fn a_token_request_sends_the_cookie_and_answers_only_the_token() {
        let body = r#"{"clientId":"c","accessToken":"BQ-account","accessTokenExpirationTimestampMs":1800000000000,"isAnonymous":false}"#;
        let (port, seen) = serve(http(
            "200 OK",
            "Content-Type: application/json\r\nSet-Cookie: sp_dc=rotated; Domain=.spotify.com\r\n",
            body,
        ));
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, &format!("http://127.0.0.1:{port}/api/token"));
        spotify.keep(COOKIE).unwrap();
        let safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
        let answer = run(spotify.token(&params(), Some(safari))).unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(
            answer.json,
            serde_json::json!({
                "accessToken": "BQ-account",
                "accessTokenExpirationTimestampMs": 1_800_000_000_000_u64,
                "isAnonymous": false,
            })
        );
        let head = seen.lock().unwrap()[0].clone();
        let lower = head.to_lowercase();
        assert!(
            lower.starts_with(
                "get /api/token?reason=transport&producttype=web-player&totp=123456&totpserver=654321&totpver=61 "
            ),
            "{head}"
        );
        assert!(
            head.contains(&format!("cookie: {COOKIE_NAME}={COOKIE}\r\n")),
            "{head}"
        );
        assert!(
            lower.contains(&format!("user-agent: {}\r\n", safari.to_lowercase())),
            "{head}"
        );
        assert!(lower.contains("accept: application/json\r\n"), "{head}");
        assert!(!lower.contains("origin:"), "{head}");
        // A cookie Spotify sets on the way is never kept.
        assert_eq!(store.secret.lock().unwrap().as_deref(), Some(COOKIE));
    }

    #[test]
    fn without_a_login_no_request_goes_out() {
        let (port, seen) = serve(http("200 OK", "", "{}"));
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, &format!("http://127.0.0.1:{port}/api/token"));
        let error = run(spotify.token(&params(), None)).unwrap_err();
        assert_eq!(error.code, "logged-out");
        let bad = TokenParams {
            totp: Some("x".into()),
            ..params()
        };
        spotify.keep(COOKIE).unwrap();
        assert_eq!(
            run(spotify.token(&bad, None)).unwrap_err().code,
            "bad-request"
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn spotifys_refusals_and_odd_answers_come_back_as_they_are() {
        let (port, _) = serve(http(
            "400 Bad Request",
            "",
            r#"{"totpVerExpired":true,"error":"x"}"#,
        ));
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, &format!("http://127.0.0.1:{port}/api/token"));
        spotify.keep(COOKIE).unwrap();
        let answer = run(spotify.token(&params(), None)).unwrap();
        assert_eq!(answer.status, 400);
        assert_eq!(answer.json, serde_json::json!({ "totpVerExpired": true }));
        let (port, _) = serve(http("200 OK", "", "<html>not json</html>"));
        let spotify = login_with(&store, &format!("http://127.0.0.1:{port}/api/token"));
        let answer = run(spotify.token(&params(), None)).unwrap();
        assert_eq!((answer.status, answer.json), (200, Value::Null));
    }

    #[test]
    fn redirects_are_not_followed_with_the_cookie() {
        let (target, target_seen) = serve(http("200 OK", "", "{}"));
        let (port, _) = serve(http(
            "302 Found",
            &format!("Location: http://127.0.0.1:{target}/elsewhere\r\n"),
            "",
        ));
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, &format!("http://127.0.0.1:{port}/api/token"));
        spotify.keep(COOKIE).unwrap();
        let answer = run(spotify.token(&params(), None)).unwrap();
        assert_eq!(answer.status, 302);
        assert!(target_seen.lock().unwrap().is_empty());
    }

    #[test]
    fn large_answers_are_refused() {
        let (port, _) = serve(http(
            "200 OK",
            "",
            &"x".repeat(MAX_TOKEN_RESPONSE_BYTES + 1),
        ));
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, &format!("http://127.0.0.1:{port}/api/token"));
        spotify.keep(COOKIE).unwrap();
        assert_eq!(
            run(spotify.token(&params(), None)).unwrap_err().code,
            "too-large"
        );
    }

    #[test]
    fn a_closed_endpoint_is_a_network_error_without_the_url() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, &format!("http://127.0.0.1:{port}/api/token"));
        spotify.keep(COOKIE).unwrap();
        let error = run(spotify.token(&params(), None)).unwrap_err();
        assert_eq!(error.code, "network");
        assert!(!error.message.contains("totp"), "{}", error.message);
        assert!(!error.message.contains(COOKIE), "{}", error.message);
    }

    #[test]
    fn at_most_ten_token_requests_a_minute() {
        let start = Instant::now();
        let mut limiter = RateLimiter::new(RATE_LIMIT, RATE_WINDOW);
        for second in 0..RATE_LIMIT as u64 {
            limiter
                .acquire(start + Duration::from_secs(second))
                .unwrap();
        }
        let wait = limiter
            .acquire(start + Duration::from_secs(10))
            .unwrap_err();
        assert_eq!(wait, Duration::from_secs(50));
        limiter.acquire(start + RATE_WINDOW).unwrap();
        // Through the command's path, the eleventh request in a row is refused before it goes out.
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, "http://127.0.0.1:9/api/token");
        spotify.keep(COOKIE).unwrap();
        for _ in 0..RATE_LIMIT {
            let _ = spotify.limiter.lock().unwrap().acquire(Instant::now());
        }
        assert_eq!(
            run(spotify.token(&params(), None)).unwrap_err().code,
            "rate-limited"
        );
    }

    #[test]
    fn waiting_callers_hear_how_the_window_ended() {
        let store = Arc::new(MemoryStore::default());
        let spotify = login_with(&store, TOKEN_URL);
        let mut first = spotify.wait();
        let mut second = spotify.wait();
        spotify.finish(true);
        assert_eq!(run(first.recv()), Some(true));
        assert_eq!(run(second.recv()), Some(true));
        // Finishing again tells no one: the window ended once.
        spotify.finish(false);
        let mut third = spotify.wait();
        spotify.finish(false);
        assert_eq!(run(third.recv()), Some(false));
    }
}
