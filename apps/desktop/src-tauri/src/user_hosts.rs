//! Hosts the user approved for FXM to contact besides its built-in services, such as an
//! Invidious instance or a Spotify secret source typed into Settings, and the command that
//! fetches from them (stage 7.2).
//!
//! tauri-plugin-http checks every request against the scope in `capabilities/default.json`,
//! which lists FXM's services and is fixed when the app is built: Tauri offers no way to change a
//! plugin's scope at runtime. So the web app sends requests for any other host here instead
//! (`createDesktopFetch` in `packages/platform/src/desktop.ts`), and this module lets through only:
//!
//! - hosts on the approved list. Page script may read the list and remove hosts, but only the
//!   user can add one, by saying yes in a native dialog that names it. So no script, such as a
//!   resolver module, can make FXM contact a host of its own choosing;
//! - `GET` and `HEAD` requests over HTTPS to domain names, never IP addresses, without cookies,
//!   credentials, a proxy or any header from the page;
//! - addresses on the public internet: a name that resolves only to loopback, private,
//!   link-local or other special-purpose addresses is refused after DNS resolution, so an
//!   approved name can't point FXM at the user's own network;
//! - at most [`MAX_REDIRECTS`] redirects, each checked like the first request, and responses of
//!   at most [`MAX_BODY_BYTES`] within [`TIMEOUT`].

use std::{
    fmt, fs, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    path::PathBuf,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_http::reqwest::{
    self, Method, Url,
    dns::{Addrs, Name, Resolve, Resolving},
    redirect::Policy,
};

/// The file in the app's config folder that keeps the approved hosts.
pub const FILE_NAME: &str = "user-hosts.json";

/// The most redirects one request follows.
pub const MAX_REDIRECTS: usize = 5;

/// The largest response body, in bytes: 8 MiB.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// How long a whole request may take, body included.
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// How long connecting may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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

/// FXM's own User-Agent, as MusicBrainz asks apps to name themselves.
fn user_agent() -> String {
    format!(
        "FXM/{} ( https://github.com/Pratyay-ops/FXM )",
        env!("CARGO_PKG_VERSION")
    )
}

/// Why a command failed. The web app receives it as `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    /// What went wrong, for code: `invalid-host`, `busy`, `storage`, `bad-request`,
    /// `not-approved`, `forbidden-address`, `too-large` or `network`.
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

/// The approved hosts, in memory and in [`FILE_NAME`] in the app's config folder.
pub struct UserHosts {
    file: Option<PathBuf>,
    hosts: Mutex<Vec<String>>,
    asking: AtomicBool,
}

/// What [`FILE_NAME`] holds.
#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    hosts: Vec<String>,
}

/// Clears [`UserHosts::asking`] when the dialog's command ends, however it ends.
struct Asking<'a>(&'a AtomicBool);

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
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
            asking: AtomicBool::new(false),
        }
    }

    /// A list kept in memory only, with entries taken as they are.
    #[cfg(test)]
    fn in_memory(hosts: &[&str]) -> Self {
        Self {
            file: None,
            hosts: Mutex::new(hosts.iter().map(|host| (*host).to_owned()).collect()),
            asking: AtomicBool::new(false),
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

    /// Marks a dialog as open, so a second one can't pile up behind it.
    fn begin_asking(&self) -> Result<Asking<'_>, CommandError> {
        if self.asking.swap(true, Ordering::AcqRel) {
            return Err(CommandError::new(
                "busy",
                "FXM is already asking about another host",
            ));
        }
        Ok(Asking(&self.asking))
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
#[tauri::command]
pub async fn approve_user_host<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    hosts: State<'_, UserHosts>,
    host: String,
) -> Result<Option<String>, CommandError> {
    let host = normalize_host(&host)?;
    if hosts.contains(&host) {
        return Ok(Some(host));
    }
    let _asking = hosts.begin_asking()?;
    if !ask_user(app, window, host.clone()).await {
        return Ok(None);
    }
    hosts.insert(host.clone())?;
    Ok(Some(host))
}

/// Shows the approval dialog and waits for the answer, off the main thread.
async fn ask_user<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, host: String) -> bool {
    let message = format!(
        "FXM wants to connect to {host}.\n\n\
         Allow it only if you added this server in FXM's settings yourself. FXM will only \
         download data from it, never your cookies or passwords, and you can remove it in \
         Settings at any time."
    );
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Allow a new server?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow".into(),
                "Don't Allow".into(),
            ))
            .parent(&window)
            .blocking_show()
    })
    .await
    .unwrap_or(false)
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
pub async fn user_host_fetch(
    hosts: State<'_, UserHosts>,
    request: UserHostRequest,
) -> Result<tauri::ipc::Response, CommandError> {
    let approved = hosts.list();
    let fetched = fetch(&request, &approved, &FetchPolicy::default()).await?;
    Ok(tauri::ipc::Response::new(fetched.encode()))
}

/// The limits of [`fetch`].
#[derive(Debug, Clone)]
pub(crate) struct FetchPolicy {
    max_body: usize,
    max_redirects: usize,
    timeout: Duration,
    /// Whether only HTTPS URLs on domain names that resolve to public addresses may be fetched.
    /// Only tests turn it off, to fetch from a local server.
    public_only: bool,
}

impl Default for FetchPolicy {
    fn default() -> Self {
        Self {
            max_body: MAX_BODY_BYTES,
            max_redirects: MAX_REDIRECTS,
            timeout: TIMEOUT,
            public_only: true,
        }
    }
}

/// Whether `url` may be fetched: an approved host over HTTPS, without credentials.
fn check_url(url: &Url, approved: &[String], policy: &FetchPolicy) -> Result<(), CommandError> {
    let scheme_allowed = url.scheme() == "https" || (!policy.public_only && url.scheme() == "http");
    if !scheme_allowed || !url.username().is_empty() || url.password().is_some() {
        return Err(CommandError::new(
            "bad-request",
            format!("{url} is not an HTTPS URL without a user name"),
        ));
    }
    if policy.public_only && url.domain().is_none() {
        return Err(CommandError::new(
            "forbidden-address",
            format!("{url} names an IP address, not a domain"),
        ));
    }
    let host = host_key(url).unwrap_or_default();
    if !approved.contains(&host) {
        return Err(CommandError::new(
            "not-approved",
            format!("{host} is not one of the hosts you approved in Settings"),
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
/// every redirect checked like the request itself.
fn client(approved: &[String], policy: &FetchPolicy) -> Result<reqwest::Client, CommandError> {
    let redirects = {
        let approved = approved.to_vec();
        let policy = policy.clone();
        Policy::custom(move |attempt| {
            if attempt.previous().len() > policy.max_redirects {
                return attempt.error(CommandError::new(
                    "network",
                    format!("more than {} redirects", policy.max_redirects),
                ));
            }
            match check_url(attempt.url(), &approved, &policy) {
                Ok(()) => attempt.follow(),
                Err(error) => attempt.error(error),
            }
        })
    };
    let mut builder = reqwest::Client::builder()
        .redirect(redirects)
        .timeout(policy.timeout)
        .connect_timeout(CONNECT_TIMEOUT.min(policy.timeout))
        .no_proxy()
        .user_agent(user_agent())
        .https_only(policy.public_only);
    if policy.public_only {
        builder = builder.dns_resolver(Arc::new(PublicAddresses));
    }
    builder
        .build()
        .map_err(|error| CommandError::new("network", error.to_string()))
}

/// The [`CommandError`] behind a failed request: one of ours from the redirect policy or the
/// resolver, else a `network` error.
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
        error.to_string()
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
            format!("{:?} is not an absolute URL", request.url),
        )
    })?;
    check_url(&url, approved, policy)?;
    let mut response = client(approved, policy)?
        .request(method, url)
        .send()
        .await
        .map_err(request_error)?;
    if response
        .content_length()
        .is_some_and(|length| length > policy.max_body as u64)
    {
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
            .filter_map(|(name, value)| {
                let value = String::from_utf8(value.as_bytes().to_vec()).ok()?;
                Some((name.as_str().to_owned(), value))
            })
            .collect(),
    };
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if body.len() + chunk.len() > policy.max_body {
            return Err(too_large(policy));
        }
        body.extend_from_slice(&chunk);
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
    fn only_one_dialog_at_a_time() {
        let hosts = UserHosts::in_memory(&[]);
        let first = hosts.begin_asking().unwrap();
        assert_eq!(hosts.begin_asking().err().unwrap().code, "busy");
        drop(first);
        assert!(hosts.begin_asking().is_ok());
    }

    /// A test server: `/redirect` answers a 302 to `location` (an absolute URL, or `/target`),
    /// `/big` sends more than the test's body limit, and anything else answers `hello` with a
    /// cookie. It records each request line and the request's headers.
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
                let response = match (path.as_str(), &location) {
                    ("/redirect", Some(location)) => format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    ),
                    ("/big", _) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{}",
                        "x".repeat(64)
                    ),
                    _ => "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: s=1\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".to_owned(),
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, seen)
    }

    fn local_policy() -> FetchPolicy {
        FetchPolicy {
            max_body: 32,
            public_only: false,
            ..FetchPolicy::default()
        }
    }

    fn get(url: &str, approved: &[String], policy: &FetchPolicy) -> Result<Fetched, CommandError> {
        let request = UserHostRequest {
            url: url.to_owned(),
            method: "GET".to_owned(),
        };
        tauri::async_runtime::block_on(fetch(&request, approved, policy))
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
        assert!(request.contains("user-agent: fxm/"), "{request}");
        assert!(!request.contains("cookie"), "{request}");
        assert!(!request.contains("origin"), "{request}");
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
    fn redirects_must_stay_on_approved_hosts() {
        let (target, target_seen) = serve(None);
        let (port, _) = serve(Some(format!("http://127.0.0.1:{target}/secret")));
        let approved = vec![format!("127.0.0.1:{port}")];
        let error = get(
            &format!("http://127.0.0.1:{port}/redirect"),
            &approved,
            &local_policy(),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "not-approved");
        assert!(target_seen.lock().unwrap().is_empty());

        let (port, _) = serve(Some("/target".to_owned()));
        let fetched = get(
            &format!("http://127.0.0.1:{port}/redirect"),
            &[format!("127.0.0.1:{port}")],
            &local_policy(),
        )
        .unwrap();
        assert_eq!(fetched.body, b"hello");
        assert_eq!(fetched.head.url, format!("http://127.0.0.1:{port}/target"));
    }

    #[test]
    fn redirect_loops_end() {
        let (port, seen) = serve(Some("/redirect".to_owned()));
        let error = get(
            &format!("http://127.0.0.1:{port}/redirect"),
            &[format!("127.0.0.1:{port}")],
            &local_policy(),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "network");
        assert_eq!(seen.lock().unwrap().len(), MAX_REDIRECTS + 1);
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
    fn only_get_and_head_over_https_without_credentials() {
        let approved = ["inv.example.org".to_owned()];
        let policy = FetchPolicy::default();
        let post = UserHostRequest {
            url: "https://inv.example.org/".into(),
            method: "POST".into(),
        };
        let error = tauri::async_runtime::block_on(fetch(&post, &approved, &policy))
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
    fn ip_addresses_and_private_names_never_get_a_request() {
        let (port, seen) = serve(None);
        // Even when such an entry is on the list, the public-only policy refuses it.
        let approved = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
        let policy = FetchPolicy::default();
        let by_address = get(&format!("https://127.0.0.1:{port}/"), &approved, &policy);
        assert_eq!(by_address.err().unwrap().code, "forbidden-address");
        // localhost resolves to loopback only, which the resolver drops.
        let by_name = get(&format!("https://localhost:{port}/"), &approved, &policy);
        assert_eq!(by_name.err().unwrap().code, "forbidden-address");
        assert!(seen.lock().unwrap().is_empty());
    }
}
