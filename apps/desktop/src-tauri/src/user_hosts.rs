//! Hosts the user approved for FXM to contact besides its built-in services, such as an
//! Invidious instance or a Spotify secret source typed into Settings, and the command that
//! fetches from them (stage 7.2).
//!
//! tauri-plugin-http checks every request against the scope in `capabilities/default.json`,
//! which lists FXM's services and is fixed when the app is built: Tauri offers no way to change a
//! plugin's scope at runtime. So the web app sends requests for any other host here instead
//! (`createDesktopFetch` in `packages/platform/src/desktop.ts`), and [`user_host_fetch`] lets
//! through only:
//!
//! - hosts on the approved list. Page script may read the list and remove hosts, but only the
//!   user can add one, by choosing "Allow" in a native dialog that names it
//!   ([`approve_user_host`]). So no script can make this command reach a host the user didn't
//!   approve. That binds this command only: apps/desktop/README.md lists what else page script
//!   can reach;
//! - `GET` and `HEAD` requests over HTTPS to domain names, never IP addresses, without cookies,
//!   credentials or any header from the page, and never through a proxy: while the system or the
//!   environment sets one for the host, the request fails (`proxy-configured`) instead of going
//!   out from the user's own address;
//! - addresses on the public internet: a name that resolves only to loopback, private,
//!   link-local or other special-purpose addresses is refused after DNS resolution, so an
//!   approved name can't point this command at the user's own network;
//! - no redirect: the command hands a redirect back as it is, and the web app's transport follows
//!   it, to the same host only, through this command again;
//! - responses of at most [`MAX_BODY_BYTES`] within [`TIMEOUT`].
//!
//! Error messages name a host or an origin, never a whole URL: a query can carry the user's IP
//! address, signatures or search terms.

use std::{
    collections::HashSet,
    fmt, fs, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError, mpsc},
    time::{Duration, Instant},
};

use hyper_util::client::proxy::matcher::Matcher;
use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, PackageInfo, Runtime, State, WebviewWindow};
use tauri_plugin_http::reqwest::{
    self, Method, Url,
    dns::{Addrs, Name, Resolve, Resolving},
    header::HeaderValue,
    redirect::Policy,
};

use crate::window::in_front;

/// The file in the app's config folder that keeps the approved hosts.
pub const FILE_NAME: &str = "user-hosts.json";

/// The largest response body, in bytes: 8 MiB.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// How long a whole request may take, body included.
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// How long connecting may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long FXM waits, after the user answered one question about a host, before it asks
/// another: a script can't keep raising the dialog.
pub const PROMPT_INTERVAL: Duration = Duration::from_secs(10);

/// Name suffixes that never name a host on the public internet: special-use names (RFC 2606,
/// RFC 6761, RFC 6762, RFC 7686, RFC 8375) and the common private-network ones.
const PRIVATE_SUFFIXES: &[&str] = &[
    "localhost",
    "local",
    "internal",
    "home.arpa",
    "lan",
    "test",
    "invalid",
    "example",
    "onion",
];

/// Response headers the web app never gets: no cookie is ever stored or sent.
const DROPPED_HEADERS: &[&str] = &["set-cookie", "set-cookie2"];

/// The approval dialog's title.
const DIALOG_TITLE: &str = "Allow a new server?";

/// The button that approves a host.
const ALLOW: &str = "Allow";

/// The button that refuses it.
const DONT_ALLOW: &str = "Don't Allow";

/// FXM's own User-Agent, as MusicBrainz asks apps to name themselves, with the app's version.
fn user_agent(version: &str) -> String {
    format!("FXM/{version} ( https://github.com/Pratyay-ops/FXM )")
}

/// Why a command failed. The web app receives it as `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    /// What went wrong, for code: `invalid-host`, `not-focused`, `busy`, `too-soon`, `refused`,
    /// `dialog`, `storage`, `bad-request`, `not-approved`, `forbidden-address`,
    /// `proxy-configured`, `too-large` or `network`.
    pub code: &'static str,
    /// What went wrong, for people.
    pub message: String,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn storage(error: impl fmt::Display) -> Self {
        Self::new(
            "storage",
            format!("FXM could not save the hosts you approved: {error}"),
        )
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for CommandError {}

/// The approved form of a host the user typed: a public domain name in lower case (punycode for
/// international names), with `:port` unless the port is HTTPS's own 443. Refuses IP addresses,
/// single-label names, private-use names such as `nas.local`, and anything with a scheme, path,
/// user name or spaces.
pub fn normalize_host(input: &str) -> Result<String, CommandError> {
    let invalid = || {
        CommandError::new(
            "invalid-host",
            format!("{input:?} is not a public domain name (with an optional port)"),
        )
    };
    let host = input.trim();
    if host.is_empty()
        || host.len() > 260
        || host.contains(['/', '?', '#', '@', '\\'])
        || host.chars().any(char::is_whitespace)
    {
        return Err(invalid());
    }
    let url = Url::parse(&format!("https://{host}/")).map_err(|_| invalid())?;
    // `domain()` is `None` for an IP address.
    let domain = url.domain().ok_or_else(invalid)?;
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return Err(invalid());
    }
    let private = PRIVATE_SUFFIXES.iter().any(|suffix| {
        domain == *suffix
            || domain
                .strip_suffix(suffix)
                .is_some_and(|rest| rest.ends_with('.'))
    });
    if private {
        return Err(invalid());
    }
    Ok(match url.port() {
        Some(port) => format!("{domain}:{port}"),
        None => domain.to_owned(),
    })
}

/// A URL's host as the approved list spells it: the host, plus `:port` for a non-default port.
fn host_key(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

/// Whether `ip` is an address on the public internet: not unspecified, loopback, private,
/// shared (CGNAT), link-local, multicast, broadcast, reserved, documentation or benchmarking,
/// and not an IPv6 form of such an IPv4 address.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => is_public_v6(v6),
        },
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (b & 0xc0) == 64)
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b & 0xfe) == 18)
        || a >= 240)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    let embedded_v4 = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        // NAT64 (RFC 6052): the IPv4 address it stands for decides.
        return is_public_v4(embedded_v4(segments[6], segments[7]));
    }
    if segments[0] == 0x2002 {
        // 6to4 (RFC 3056): likewise.
        return is_public_v4(embedded_v4(segments[1], segments[2]));
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[..4] == [0x100, 0, 0, 0]
        || segments[..6] == [0, 0, 0, 0, 0, 0])
}

/// When FXM may ask the user about a host: one question at a time, the next one only
/// [`PROMPT_INTERVAL`] after the last answer, and never again in this session about a host the
/// user refused.
#[derive(Debug, Default)]
struct Prompts {
    /// Whether a question is open.
    open: bool,
    /// When the last question ended.
    last_answer: Option<Instant>,
    /// The hosts the user refused since FXM started.
    refused: HashSet<String>,
}

impl Prompts {
    /// Opens a question about `host` at `now`, or says why FXM won't ask.
    fn begin(&mut self, host: &str, now: Instant) -> Result<(), CommandError> {
        if self.refused.contains(host) {
            return Err(CommandError::new(
                "refused",
                format!(
                    "You chose not to allow {host}. FXM asks about it again after it restarts."
                ),
            ));
        }
        if self.open {
            return Err(CommandError::new(
                "busy",
                "FXM is already asking about another host",
            ));
        }
        if let Some(last) = self.last_answer
            && now.saturating_duration_since(last) < PROMPT_INTERVAL
        {
            return Err(CommandError::new(
                "too-soon",
                format!(
                    "FXM asks about at most one new host every {} seconds. Try again in a moment.",
                    PROMPT_INTERVAL.as_secs()
                ),
            ));
        }
        self.open = true;
        Ok(())
    }

    /// Closes the open question about `host` at `now`, with the user's answer, if there was one.
    fn end(&mut self, host: &str, approved: Option<bool>, now: Instant) {
        self.open = false;
        self.last_answer = Some(now);
        if approved == Some(false) {
            self.refused.insert(host.to_owned());
        }
    }
}

/// An open question about a host. Dropping it closes the question, however the command ends.
struct Question<'a> {
    prompts: &'a Mutex<Prompts>,
    host: String,
    approved: Option<bool>,
}

impl Drop for Question<'_> {
    fn drop(&mut self) {
        self.prompts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .end(&self.host, self.approved, Instant::now());
    }
}

/// The approved hosts, in memory and in [`FILE_NAME`] in the app's config folder.
pub struct UserHosts {
    file: Option<PathBuf>,
    hosts: Mutex<Vec<String>>,
    prompts: Mutex<Prompts>,
}

/// What [`FILE_NAME`] holds.
#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    hosts: Vec<String>,
}

impl UserHosts {
    /// Loads the approved hosts from `file`. A missing or unreadable file gives an empty list,
    /// and entries that are not hosts FXM accepts any more are dropped.
    pub fn load(file: PathBuf) -> Self {
        let mut hosts: Vec<String> = Vec::new();
        let stored = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok());
        for host in stored.map(|stored| stored.hosts).unwrap_or_default() {
            if let Ok(host) = normalize_host(&host)
                && !hosts.contains(&host)
            {
                hosts.push(host);
            }
        }
        Self {
            file: Some(file),
            hosts: Mutex::new(hosts),
            prompts: Mutex::default(),
        }
    }

    /// A list kept in memory only, with entries taken as they are.
    #[cfg(test)]
    fn in_memory(hosts: &[&str]) -> Self {
        Self {
            file: None,
            hosts: Mutex::new(hosts.iter().map(|host| (*host).to_owned()).collect()),
            prompts: Mutex::default(),
        }
    }

    /// The approved hosts.
    pub fn list(&self) -> Vec<String> {
        self.hosts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn contains(&self, host: &str) -> bool {
        self.list().iter().any(|approved| approved == host)
    }

    /// Changes the list, saving it before the change takes effect.
    fn update(&self, change: impl FnOnce(&mut Vec<String>)) -> Result<(), CommandError> {
        let mut hosts = self.hosts.lock().unwrap_or_else(PoisonError::into_inner);
        let mut next = hosts.clone();
        change(&mut next);
        if next != *hosts {
            self.save(&next)?;
            *hosts = next;
        }
        Ok(())
    }

    fn insert(&self, host: String) -> Result<(), CommandError> {
        self.update(|hosts| {
            if !hosts.contains(&host) {
                hosts.push(host);
            }
        })
    }

    fn remove(&self, host: &str) -> Result<(), CommandError> {
        self.update(|hosts| hosts.retain(|approved| approved != host))
    }

    /// Writes the list to a temporary file, then renames it over the old one.
    fn save(&self, hosts: &[String]) -> Result<(), CommandError> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let stored = Stored {
            version: 1,
            hosts: hosts.to_vec(),
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(CommandError::storage)?;
        if let Some(folder) = file.parent() {
            fs::create_dir_all(folder).map_err(CommandError::storage)?;
        }
        let partial = file.with_extension("json.partial");
        fs::write(&partial, json).map_err(CommandError::storage)?;
        fs::rename(&partial, file).map_err(CommandError::storage)
    }

    /// Opens a question about `host`, if FXM may ask now (see [`Prompts`]).
    fn ask(&self, host: &str) -> Result<Question<'_>, CommandError> {
        self.prompts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .begin(host, Instant::now())?;
        Ok(Question {
            prompts: &self.prompts,
            host: host.to_owned(),
            approved: None,
        })
    }
}

/// The hosts the user approved.
#[tauri::command]
pub fn user_hosts(hosts: State<'_, UserHosts>) -> Vec<String> {
    hosts.list()
}

/// Asks the user, in a native dialog over the main window, whether FXM may contact `host`.
/// Resolves with the host as it was stored once approved (or already on the list), or `null` if
/// the user said no.
///
/// It asks only while the window is visible and focused, and never brings it forward itself: a
/// script can't pull FXM in front of another app, or time the question for a key the user is
/// about to press in FXM. "Don't Allow" is the answer that Return gives where the system has
/// such a default (macOS and Windows), and only a click on "Allow" approves. One question at a
/// time, the next only [`PROMPT_INTERVAL`] after the last answer, and none again in this session
/// about a host the user refused.
#[tauri::command]
pub async fn approve_user_host<R: Runtime>(
    window: WebviewWindow<R>,
    hosts: State<'_, UserHosts>,
    host: String,
) -> Result<Option<String>, CommandError> {
    let host = normalize_host(&host)?;
    if hosts.contains(&host) {
        return Ok(Some(host));
    }
    if !in_front(&window) {
        return Err(CommandError::new(
            "not-focused",
            "FXM asks about a new host only while its window is in front",
        ));
    }
    let mut question = hosts.ask(&host)?;
    let approved = ask_user(&window, &host).await?;
    question.approved = Some(approved);
    if !approved {
        return Ok(None);
    }
    hosts.insert(host.clone())?;
    Ok(Some(host))
}

/// The dialog's buttons. "Don't Allow" comes first where the first button is the one Return
/// presses: NSAlert's on macOS, the task dialog's default on Windows. GTK (Linux and the BSDs)
/// reports custom buttons only as OK and Cancel, and closing the dialog as Cancel too, so there
/// "Allow" is the OK button: nothing but a click on it can approve.
fn approval_buttons() -> MessageButtons {
    if cfg!(any(target_os = "macos", windows)) {
        MessageButtons::OkCancelCustom(DONT_ALLOW.into(), ALLOW.into())
    } else {
        MessageButtons::OkCancelCustom(ALLOW.into(), DONT_ALLOW.into())
    }
}

/// Whether the dialog's answer approves: "Allow", and nothing else. Closing the dialog refuses.
fn approves(answer: &MessageDialogResult) -> bool {
    match answer {
        MessageDialogResult::Custom(label) => label == ALLOW,
        // GTK's OK button, which is "Allow" there (see `approval_buttons`).
        MessageDialogResult::Ok => !cfg!(any(target_os = "macos", windows)),
        _ => false,
    }
}

/// The question the dialog asks about `host`.
fn question_text(host: &str) -> String {
    format!(
        "FXM wants to connect to {host}.\n\n\
         Allow it only if you added this server in FXM's settings yourself. FXM will only \
         download data from it, never send it your cookies or passwords, and you can remove it \
         in Settings at any time."
    )
}

/// Shows the approval dialog over `window` and waits for the answer. rfd builds the dialog on
/// the main thread, as tauri-plugin-dialog does, and the answer arrives without blocking it.
async fn ask_user<R: Runtime>(window: &WebviewWindow<R>, host: &str) -> Result<bool, CommandError> {
    let failed = || CommandError::new("dialog", "FXM could not show its question");
    let (sender, receiver) = mpsc::sync_channel(1);
    let parent = window.clone();
    let text = question_text(host);
    window
        .run_on_main_thread(move || {
            let answer = AsyncMessageDialog::new()
                .set_level(MessageLevel::Warning)
                .set_title(DIALOG_TITLE)
                .set_description(text)
                .set_buttons(approval_buttons())
                .set_parent(&parent)
                .show();
            let _ = sender.send(answer);
        })
        .map_err(|_| failed())?;
    let answer = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?;
    Ok(approves(&answer.await))
}

/// Removes `host` from the approved hosts.
#[tauri::command]
pub fn revoke_user_host(hosts: State<'_, UserHosts>, host: String) -> Result<(), CommandError> {
    let host = normalize_host(&host)?;
    hosts.remove(&host)
}

/// A request for an approved host, as the web app sends it.
#[derive(Debug, Deserialize)]
pub struct UserHostRequest {
    url: String,
    method: String,
}

/// Fetches from an approved host. The answer is a 4-byte big-endian length, that many bytes of
/// JSON (`{ status, statusText, url, headers }`), then the body.
#[tauri::command]
pub async fn user_host_fetch<R: Runtime>(
    app: AppHandle<R>,
    hosts: State<'_, UserHosts>,
    request: UserHostRequest,
) -> Result<tauri::ipc::Response, CommandError> {
    let approved = hosts.list();
    let policy = FetchPolicy::for_app(app.package_info());
    let fetched = fetch(&request, &approved, &policy).await?;
    Ok(tauri::ipc::Response::new(fetched.encode()))
}

/// The limits of [`fetch`].
#[derive(Debug, Clone)]
pub(crate) struct FetchPolicy {
    max_body: usize,
    timeout: Duration,
    /// Whether only HTTPS URLs on domain names that resolve to public addresses may be fetched.
    /// Only tests turn it off, to fetch from a local server.
    public_only: bool,
    /// The proxies the system and the environment set: a host they cover is refused.
    proxies: Arc<Matcher>,
    /// FXM's User-Agent, with the app's version ([`user_agent`]).
    user_agent: String,
}

impl FetchPolicy {
    /// The limits of the app's requests, which name its version: apps/desktop/package.json's,
    /// which `make release-pr` sets (`"version": "../package.json"` in tauri.conf.json), not
    /// Cargo.toml's, which stays 0.0.0.
    fn for_app(package: &PackageInfo) -> Self {
        Self::with_version(&package.version.to_string())
    }

    /// The limits of requests that name FXM `version`.
    fn with_version(version: &str) -> Self {
        Self {
            max_body: MAX_BODY_BYTES,
            timeout: TIMEOUT,
            public_only: true,
            // The same settings tauri-plugin-http's requests follow (its `system-proxy` feature).
            proxies: Arc::new(Matcher::from_system()),
            user_agent: user_agent(version),
        }
    }
}

/// Whether `url` may be fetched: an approved host over HTTPS, without credentials, that no proxy
/// covers.
fn check_url(url: &Url, approved: &[String], policy: &FetchPolicy) -> Result<(), CommandError> {
    let host = host_key(url).unwrap_or_default();
    let scheme_allowed = url.scheme() == "https" || (!policy.public_only && url.scheme() == "http");
    if !scheme_allowed {
        return Err(CommandError::new(
            "bad-request",
            format!(
                "{}: requests can't go to hosts you added: only HTTPS",
                url.scheme()
            ),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CommandError::new(
            "bad-request",
            format!("an address with a user name or password can't go to {host}"),
        ));
    }
    if policy.public_only && url.domain().is_none() {
        return Err(CommandError::new(
            "forbidden-address",
            format!("{host} is an IP address: FXM contacts hosts you added only by domain name"),
        ));
    }
    if !approved.contains(&host) {
        return Err(CommandError::new(
            "not-approved",
            format!("{host} is not one of the hosts you approved in Settings"),
        ));
    }
    check_proxy(url, &host, &policy.proxies)
}

/// Fails while a proxy covers `url`. Requests to hosts the user added never use one, so a user
/// who set a proxy to hide their address would otherwise reveal it to that host.
fn check_proxy(url: &Url, host: &str, proxies: &Matcher) -> Result<(), CommandError> {
    let covered = url
        .as_str()
        .parse::<tauri::http::Uri>()
        .is_ok_and(|uri| proxies.intercept(&uri).is_some());
    if covered {
        return Err(CommandError::new(
            "proxy-configured",
            format!(
                "Your system sends web requests through a proxy, and FXM contacts servers you \
                 added only directly, so it didn't contact {host}"
            ),
        ));
    }
    Ok(())
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// A DNS resolver that keeps only public addresses (see [`is_public`]), and fails when none is
/// left, so a name can't lead FXM into the user's own network.
struct PublicAddresses;

impl Resolve for PublicAddresses {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let lookup = host.clone();
            let found = tauri::async_runtime::spawn_blocking(move || {
                (lookup.as_str(), 0)
                    .to_socket_addrs()
                    .map(Iterator::collect::<Vec<SocketAddr>>)
            })
            .await
            .map_err(|error| -> BoxError { Box::new(io::Error::other(error.to_string())) })?
            .map_err(|error| -> BoxError { Box::new(error) })?;
            let public: Vec<SocketAddr> = found
                .into_iter()
                .filter(|address| is_public(address.ip()))
                .collect();
            if public.is_empty() {
                return Err(Box::new(CommandError::new(
                    "forbidden-address",
                    format!("{host} does not lead to an address on the public internet"),
                )) as BoxError);
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// The client for one request: no cookies, no proxy, FXM's User-Agent, the policy's limits, and
/// no redirects. A redirect comes back as it is, with its `Location`: the web app's transport
/// follows it, checking the next hop against its rules, and sends it through [`fetch`] again.
fn client(policy: &FetchPolicy) -> Result<reqwest::Client, CommandError> {
    let mut builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(policy.timeout)
        .connect_timeout(CONNECT_TIMEOUT.min(policy.timeout))
        .no_proxy()
        .user_agent(policy.user_agent.as_str())
        .https_only(policy.public_only);
    if policy.public_only {
        builder = builder.dns_resolver(Arc::new(PublicAddresses));
    }
    builder
        .build()
        .map_err(|error| CommandError::new("network", error.to_string()))
}

/// An error and its causes on one line, e.g. `error sending request: client error (Connect):
/// dns error: …`.
fn describe_error(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

/// The [`CommandError`] behind a failed request: one of ours from the resolver, else a `network`
/// error, described without the request's URL.
fn request_error(error: reqwest::Error) -> CommandError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    while let Some(current) = source {
        if let Some(ours) = current.downcast_ref::<CommandError>() {
            return ours.clone();
        }
        source = current.source();
    }
    let message = if error.is_timeout() {
        format!("the request timed out after {} seconds", TIMEOUT.as_secs())
    } else {
        describe_error(&error.without_url())
    };
    CommandError::new("network", message)
}

fn too_large(policy: &FetchPolicy) -> CommandError {
    CommandError::new(
        "too-large",
        format!(
            "the response is larger than {} MiB",
            policy.max_body / (1024 * 1024)
        ),
    )
}

/// Whether a response's announced length rules it out before its body is read. A `HEAD` response
/// has no body whatever its `Content-Length` says, which hyper reports as the body's size over
/// HTTP/2 all the same.
fn announced_too_large(method: &Method, content_length: Option<u64>, max_body: usize) -> bool {
    *method != Method::HEAD && content_length.is_some_and(|length| length > max_body as u64)
}

/// A header value as browsers give it to page script: each byte as one character, U+0000 to
/// U+00FF. So every value, UTF-8 or not, is a byte string that `Headers` accepts.
fn header_text(value: &HeaderValue) -> String {
    value
        .as_bytes()
        .iter()
        .map(|&byte| char::from(byte))
        .collect()
}

/// The head of a fetched response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Head {
    status: u16,
    status_text: String,
    url: String,
    headers: Vec<(String, String)>,
}

/// A fetched response.
#[derive(Debug)]
pub(crate) struct Fetched {
    head: Head,
    body: Vec<u8>,
}

impl Fetched {
    /// The bytes the web app decodes (`decodeUserHostResponse`).
    fn encode(&self) -> Vec<u8> {
        let head = serde_json::to_vec(&self.head).expect("the head serializes");
        let length = u32::try_from(head.len()).expect("the head is far below 4 GiB");
        let mut bytes = Vec::with_capacity(4 + head.len() + self.body.len());
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(&head);
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

/// Fetches `request` within `policy`, from a host on `approved` only.
pub(crate) async fn fetch(
    request: &UserHostRequest,
    approved: &[String],
    policy: &FetchPolicy,
) -> Result<Fetched, CommandError> {
    let method = match request.method.as_str() {
        "GET" => Method::GET,
        "HEAD" => Method::HEAD,
        other => {
            return Err(CommandError::new(
                "bad-request",
                format!("{other} requests can't go to hosts you added: only GET and HEAD"),
            ));
        }
    };
    let url = Url::parse(&request.url).map_err(|_| {
        CommandError::new(
            "bad-request",
            "the request's address is not an absolute URL",
        )
    })?;
    check_url(&url, approved, policy)?;
    let mut response = client(policy)?
        .request(method.clone(), url)
        .send()
        .await
        .map_err(request_error)?;
    if announced_too_large(&method, response.content_length(), policy.max_body) {
        return Err(too_large(policy));
    }
    let status = response.status();
    let head = Head {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        url: response.url().to_string(),
        headers: response
            .headers()
            .iter()
            .filter(|(name, _)| !DROPPED_HEADERS.contains(&name.as_str()))
            .map(|(name, value)| (name.as_str().to_owned(), header_text(value)))
            .collect(),
    };
    let mut body = Vec::new();
    if method != Method::HEAD {
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            if body.len() + chunk.len() > policy.max_body {
                return Err(too_large(policy));
            }
            body.extend_from_slice(&chunk);
        }
    }
    Ok(Fetched { head, body })
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
    };

    use super::*;

    #[test]
    fn hosts_are_public_domain_names_in_one_spelling() {
        let cases = [
            ("invidious.example.org", "invidious.example.org"),
            ("  Inv.Example.ORG ", "inv.example.org"),
            ("inv.example.org:443", "inv.example.org"),
            ("inv.example.org:8443", "inv.example.org:8443"),
            ("bücher.example.org", "xn--bcher-kva.example.org"),
            ("gist.githubusercontent.com", "gist.githubusercontent.com"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_host(input).as_deref(), Ok(expected), "{input}");
        }
    }

    #[test]
    fn hosts_that_are_not_public_domain_names_are_refused() {
        for input in [
            "",
            "localhost",
            "app.localhost",
            "nas.local",
            "router.lan",
            "printer.home.arpa",
            "metadata.google.internal",
            "intranet",
            "127.0.0.1",
            "10.0.0.8:3000",
            "[::1]",
            "example.org.",
            "https://example.org",
            "example.org/path",
            "user@example.org",
            "exa mple.org",
            "example.org?x",
        ] {
            let error = normalize_host(input).expect_err(input);
            assert_eq!(error.code, "invalid-host", "{input}");
        }
    }

    #[test]
    fn only_public_addresses_count_as_public() {
        for public in [
            "8.8.8.8",
            "151.101.1.69",
            "2a00:1450:4001:80b::200e",
            "64:ff9b::808:808",
        ] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
        for private in [
            "0.0.0.0",
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.1",
            "64:ff9b::a00:1",
            "2002:c0a8:101::1",
            "100::1",
            "::127.0.0.1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "fxm-user-hosts-{}-{name}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&folder);
        folder.join(FILE_NAME)
    }

    #[test]
    fn the_list_survives_a_restart() {
        let file = temp_file("restart");
        let hosts = UserHosts::load(file.clone());
        assert!(hosts.list().is_empty());
        hosts.insert("inv.example.org".into()).unwrap();
        hosts.insert("gist.example.org".into()).unwrap();
        hosts.insert("inv.example.org".into()).unwrap();
        hosts.remove("gist.example.org").unwrap();
        assert_eq!(UserHosts::load(file.clone()).list(), ["inv.example.org"]);
        assert!(!file.with_extension("json.partial").exists());
        fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_damaged_list_loads_as_what_is_still_valid() {
        let file = temp_file("damaged");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "not json").unwrap();
        assert!(UserHosts::load(file.clone()).list().is_empty());
        fs::write(
            &file,
            r#"{"version":1,"hosts":["Inv.Example.org","127.0.0.1","inv.example.org"]}"#,
        )
        .unwrap();
        assert_eq!(UserHosts::load(file.clone()).list(), ["inv.example.org"]);
        fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_list_that_cannot_be_saved_does_not_change() {
        let file = temp_file("blocked");
        // A file where the folder should be makes saving fail.
        fs::create_dir_all(file.parent().unwrap().parent().unwrap()).unwrap();
        fs::write(file.parent().unwrap(), "in the way").unwrap();
        let hosts = UserHosts::load(file.clone());
        let error = hosts.insert("inv.example.org".into()).unwrap_err();
        assert_eq!(error.code, "storage");
        assert!(hosts.list().is_empty());
        fs::remove_file(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn only_one_question_at_a_time() {
        let hosts = UserHosts::in_memory(&[]);
        let first = hosts.ask("a.example.org").unwrap();
        assert_eq!(hosts.ask("b.example.org").err().unwrap().code, "busy");
        drop(first);
        // The question ended just now, so the next one has to wait.
        assert_eq!(hosts.ask("b.example.org").err().unwrap().code, "too-soon");
    }

    #[test]
    fn questions_wait_out_the_interval_after_each_answer() {
        let start = Instant::now();
        let mut prompts = Prompts::default();
        prompts.begin("a.example.org", start).unwrap();
        prompts.end("a.example.org", Some(true), start + Duration::from_secs(3));
        let answered = start + Duration::from_secs(3);
        for wait in [0, 1, PROMPT_INTERVAL.as_secs() - 1] {
            let error = prompts
                .begin("b.example.org", answered + Duration::from_secs(wait))
                .unwrap_err();
            assert_eq!(error.code, "too-soon", "after {wait} s");
        }
        prompts
            .begin("b.example.org", answered + PROMPT_INTERVAL)
            .unwrap();
        // A question that ended without an answer counts too.
        prompts.end("b.example.org", None, answered + PROMPT_INTERVAL);
        let error = prompts
            .begin("b.example.org", answered + PROMPT_INTERVAL)
            .unwrap_err();
        assert_eq!(error.code, "too-soon");
    }

    #[test]
    fn a_refused_host_is_not_asked_about_again_this_session() {
        let start = Instant::now();
        let mut prompts = Prompts::default();
        prompts.begin("evil.example.org", start).unwrap();
        prompts.end("evil.example.org", Some(false), start);
        let later = start + PROMPT_INTERVAL * 100;
        let error = prompts.begin("evil.example.org", later).unwrap_err();
        assert_eq!(error.code, "refused");
        assert!(error.message.contains("evil.example.org"));
        // Other hosts may still be asked about.
        prompts.begin("inv.example.org", later).unwrap();
    }

    #[test]
    fn only_a_click_on_allow_approves() {
        assert!(approves(&MessageDialogResult::Custom(ALLOW.into())));
        assert!(!approves(&MessageDialogResult::Custom(DONT_ALLOW.into())));
        // Closing the dialog, or Escape, on every system.
        assert!(!approves(&MessageDialogResult::Cancel));
        assert!(!approves(&MessageDialogResult::No));
        // OK stands for "Allow" only on GTK, where it is the "Allow" button.
        assert_eq!(
            approves(&MessageDialogResult::Ok),
            !cfg!(any(target_os = "macos", windows))
        );
    }

    #[test]
    fn dont_allow_is_the_button_return_presses_on_macos_and_windows() {
        let MessageButtons::OkCancelCustom(first, second) = approval_buttons() else {
            panic!("the dialog has two buttons of its own");
        };
        if cfg!(any(target_os = "macos", windows)) {
            assert_eq!((first.as_str(), second.as_str()), (DONT_ALLOW, ALLOW));
        } else {
            // GTK's OK button, the only answer that can't also mean "closed".
            assert_eq!((first.as_str(), second.as_str()), (ALLOW, DONT_ALLOW));
        }
    }

    #[test]
    fn the_question_names_the_host() {
        assert!(question_text("inv.example.org").contains("inv.example.org"));
    }

    /// A test server: `/redirect` answers a 302 to `location`, `/big` sends more than the test's
    /// body limit, `/head` announces a large body to a HEAD request, `/utf8` sends a header with
    /// UTF-8 bytes, and anything else answers `hello` with a cookie. It records each request line
    /// and the request's headers.
    fn serve(location: Option<String>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if matches!(line.as_str(), "" | "\r\n" | "\n") {
                        break;
                    }
                    request.push_str(&line);
                }
                let path = request.split(' ').nth(1).unwrap_or("/").to_owned();
                log.lock().unwrap().push(request);
                let response: Vec<u8> = match (path.as_str(), &location) {
                    ("/redirect", Some(location)) => format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .into_bytes(),
                    ("/big", _) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{}",
                        "x".repeat(64)
                    )
                    .into_bytes(),
                    ("/head", _) => {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 52428800\r\nConnection: close\r\n\r\n"
                            .to_vec()
                    }
                    ("/utf8", _) => [
                        b"HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=\"".as_slice(),
                        "日本.mp3".as_bytes(),
                        b"\"\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".as_slice(),
                    ]
                    .concat(),
                    _ => b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: s=1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".to_vec(),
                };
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        (port, seen)
    }

    /// No proxy, whatever the machine running the tests sets.
    fn no_proxies() -> Arc<Matcher> {
        Arc::new(Matcher::builder().build())
    }

    fn local_policy() -> FetchPolicy {
        FetchPolicy {
            max_body: 32,
            public_only: false,
            proxies: no_proxies(),
            ..FetchPolicy::with_version("1.2.3")
        }
    }

    fn public_policy() -> FetchPolicy {
        FetchPolicy {
            proxies: no_proxies(),
            ..FetchPolicy::with_version("1.2.3")
        }
    }

    fn send(
        method: &str,
        url: &str,
        approved: &[String],
        policy: &FetchPolicy,
    ) -> Result<Fetched, CommandError> {
        let request = UserHostRequest {
            url: url.to_owned(),
            method: method.to_owned(),
        };
        tauri::async_runtime::block_on(fetch(&request, approved, policy))
    }

    fn get(url: &str, approved: &[String], policy: &FetchPolicy) -> Result<Fetched, CommandError> {
        send("GET", url, approved, policy)
    }

    #[test]
    fn an_approved_host_answers_without_cookies() {
        let (port, seen) = serve(None);
        let approved = vec![format!("127.0.0.1:{port}")];
        let fetched = get(
            &format!("http://127.0.0.1:{port}/api/v1/stats"),
            &approved,
            &local_policy(),
        )
        .unwrap();
        assert_eq!(fetched.head.status, 200);
        assert_eq!(fetched.head.status_text, "OK");
        assert_eq!(fetched.body, b"hello");
        assert!(
            fetched
                .head
                .headers
                .iter()
                .all(|(name, _)| name != "set-cookie")
        );
        assert!(
            fetched
                .head
                .headers
                .contains(&("content-type".into(), "text/plain".into()))
        );
        let request = seen.lock().unwrap()[0].to_lowercase();
        assert!(request.starts_with("get /api/v1/stats "), "{request}");
        assert!(
            request.contains("user-agent: fxm/1.2.3 ( https://github.com/pratyay-ops/fxm )"),
            "{request}"
        );
        assert!(!request.contains("cookie"), "{request}");
        assert!(!request.contains("origin"), "{request}");
    }

    #[test]
    fn requests_name_the_version_of_the_app() {
        // tauri.conf.json takes it from apps/desktop/package.json, which every release sets;
        // Cargo.toml's stays 0.0.0.
        let context = crate::context();
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).expect("package.json");
        let version = package["version"]
            .as_str()
            .expect("package.json has a version");
        assert_eq!(
            FetchPolicy::for_app(context.package_info()).user_agent,
            format!("FXM/{version} ( https://github.com/Pratyay-ops/FXM )")
        );
    }

    #[test]
    fn the_answer_is_a_length_a_json_head_and_the_body() {
        let fetched = Fetched {
            head: Head {
                status: 404,
                status_text: "Not Found".into(),
                url: "https://inv.example.org/x".into(),
                headers: vec![("content-type".into(), "text/plain".into())],
            },
            body: vec![1, 2, 3],
        };
        let bytes = fetched.encode();
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        let head: serde_json::Value = serde_json::from_slice(&bytes[4..4 + length]).unwrap();
        assert_eq!(
            head,
            serde_json::json!({
                "status": 404,
                "statusText": "Not Found",
                "url": "https://inv.example.org/x",
                "headers": [["content-type", "text/plain"]],
            })
        );
        assert_eq!(&bytes[4 + length..], [1, 2, 3]);
    }

    #[test]
    fn header_bytes_become_one_character_each() {
        // The UTF-8 bytes of 日 (E6 97 A5) and a byte that is not UTF-8 at all (FF).
        let value = HeaderValue::from_bytes(&[b'a', 0xe6, 0x97, 0xa5, 0xff]).unwrap();
        assert_eq!(header_text(&value), "a\u{e6}\u{97}\u{a5}\u{ff}");
        assert!(header_text(&value).chars().all(|c| u32::from(c) <= 0xff));
    }

    #[test]
    fn a_utf8_header_reaches_the_web_app_as_its_bytes() {
        let (port, _) = serve(None);
        let fetched = get(
            &format!("http://127.0.0.1:{port}/utf8"),
            &[format!("127.0.0.1:{port}")],
            &local_policy(),
        )
        .unwrap();
        let (_, value) = fetched
            .head
            .headers
            .iter()
            .find(|(name, _)| name == "content-disposition")
            .unwrap();
        let bytes: Vec<u8> = value.chars().map(|c| u8::try_from(c).unwrap()).collect();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "attachment; filename=\"日本.mp3\""
        );
    }

    #[test]
    fn hosts_not_on_the_list_are_refused_before_any_request() {
        let (port, seen) = serve(None);
        let error = get(
            &format!("http://127.0.0.1:{port}/"),
            &["inv.example.org".to_owned()],
            &local_policy(),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "not-approved");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn redirects_come_back_unfollowed() {
        let (target, target_seen) = serve(None);
        let (port, seen) = serve(Some(format!("http://127.0.0.1:{target}/secret")));
        let approved = vec![format!("127.0.0.1:{port}"), format!("127.0.0.1:{target}")];
        let fetched = get(
            &format!("http://127.0.0.1:{port}/redirect"),
            &approved,
            &local_policy(),
        )
        .unwrap();
        assert_eq!(fetched.head.status, 302);
        assert_eq!(
            fetched.head.url,
            format!("http://127.0.0.1:{port}/redirect")
        );
        assert!(fetched.head.headers.contains(&(
            "location".into(),
            format!("http://127.0.0.1:{target}/secret")
        )));
        assert_eq!(seen.lock().unwrap().len(), 1);
        // Not even to another approved host: the web app's transport decides where it may go.
        assert!(target_seen.lock().unwrap().is_empty());
    }

    #[test]
    fn large_answers_are_refused() {
        let (port, _) = serve(None);
        let error = get(
            &format!("http://127.0.0.1:{port}/big"),
            &[format!("127.0.0.1:{port}")],
            &local_policy(),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "too-large");
    }

    #[test]
    fn a_head_request_is_never_too_large() {
        let fifty_mib = 50 * 1024 * 1024;
        assert!(!announced_too_large(
            &Method::HEAD,
            Some(fifty_mib),
            MAX_BODY_BYTES
        ));
        assert!(announced_too_large(
            &Method::GET,
            Some(fifty_mib),
            MAX_BODY_BYTES
        ));
        assert!(!announced_too_large(&Method::GET, None, MAX_BODY_BYTES));

        let (port, _) = serve(None);
        let fetched = send(
            "HEAD",
            &format!("http://127.0.0.1:{port}/head"),
            &[format!("127.0.0.1:{port}")],
            &local_policy(),
        )
        .unwrap();
        assert_eq!(fetched.head.status, 200);
        assert!(fetched.body.is_empty());
    }

    #[test]
    fn only_get_and_head_over_https_without_credentials() {
        let approved = ["inv.example.org".to_owned()];
        let policy = public_policy();
        let error = send("POST", "https://inv.example.org/", &approved, &policy)
            .err()
            .unwrap();
        assert_eq!(error.code, "bad-request");
        for url in [
            "http://inv.example.org/",
            "https://user:pass@inv.example.org/",
            "inv.example.org/",
        ] {
            assert_eq!(
                get(url, &approved, &policy).err().unwrap().code,
                "bad-request"
            );
        }
    }

    #[test]
    fn messages_never_repeat_a_url_or_its_query() {
        let approved = ["inv.example.org".to_owned()];
        let policy = public_policy();
        for url in [
            "http://inv.example.org/watch?v=secret",
            "https://alice:hunter2@inv.example.org/watch?v=secret",
            "https://203.0.113.7/watch?v=secret",
            "https://other.example.org/watch?v=secret",
            "not a url?v=secret",
        ] {
            let message = get(url, &approved, &policy).err().unwrap().message;
            for leak in ["secret", "alice", "hunter2", "/watch"] {
                assert!(!message.contains(leak), "{url}: {message}");
            }
        }
    }

    #[test]
    fn ip_addresses_and_private_names_never_get_a_request() {
        let (port, seen) = serve(None);
        // Even when such an entry is on the list, the public-only policy refuses it.
        let approved = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
        let policy = public_policy();
        let by_address = get(&format!("https://127.0.0.1:{port}/"), &approved, &policy);
        assert_eq!(by_address.err().unwrap().code, "forbidden-address");
        // localhost resolves to loopback only, which the resolver drops.
        let by_name = get(&format!("https://localhost:{port}/"), &approved, &policy);
        assert_eq!(by_name.err().unwrap().code, "forbidden-address");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_host_a_proxy_covers_is_refused_before_any_request() {
        let (port, seen) = serve(None);
        let approved = [format!("127.0.0.1:{port}")];
        let proxied = FetchPolicy {
            proxies: Arc::new(
                Matcher::builder()
                    .http("http://proxy.example.org:3128")
                    .build(),
            ),
            ..local_policy()
        };
        let error = get(&format!("http://127.0.0.1:{port}/"), &approved, &proxied)
            .err()
            .unwrap();
        assert_eq!(error.code, "proxy-configured");
        assert!(error.message.contains(&format!("127.0.0.1:{port}")));
        assert!(seen.lock().unwrap().is_empty());
        // A host the proxy settings leave out goes through.
        let excepted = FetchPolicy {
            proxies: Arc::new(
                Matcher::builder()
                    .http("http://proxy.example.org:3128")
                    .no("127.0.0.1")
                    .build(),
            ),
            ..local_policy()
        };
        let fetched = get(&format!("http://127.0.0.1:{port}/"), &approved, &excepted).unwrap();
        assert_eq!(fetched.body, b"hello");
    }

    /// An error with an optional cause, like reqwest's and hyper's.
    #[derive(Debug)]
    struct Layer(&'static str, Option<Box<Layer>>);

    impl fmt::Display for Layer {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1
                .as_deref()
                .map(|cause| cause as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn errors_are_described_with_their_causes() {
        let chain = Layer(
            "error sending request",
            Some(Box::new(Layer(
                "client error (Connect)",
                Some(Box::new(Layer("dns error", None))),
            ))),
        );
        assert_eq!(
            describe_error(&chain),
            "error sending request: client error (Connect): dns error"
        );
        // A cause its error already names is not repeated.
        let named = Layer(
            "dns error: no record",
            Some(Box::new(Layer("no record", None))),
        );
        assert_eq!(describe_error(&named), "dns error: no record");
    }
}
