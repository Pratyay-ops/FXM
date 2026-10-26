//! The readable audio path (stage 7.6): the `fxm-media:` URI scheme, which serves googlevideo
//! streams to the main window's `<audio>` elements through Rust, so that Web Audio, and with it
//! the equalizer of stage 8.1, can read YouTube audio.
//!
//! googlevideo answers other sites without CORS headers, so the webview plays its URLs only as
//! opaque media, and Web Audio turns opaque media into silence. Rust reads googlevideo's bytes
//! anyway (the end-of-file probe of stage 1.4 does), so here it fetches them for the page and
//! serves them under the app's own scheme, with CORS headers for the app's own origin:
//!
//! ```text
//! <audio crossorigin="anonymous" src="fxm-media://localhost/<the googlevideo URL, encoded>">
//! ```
//!
//! `http://fxm-media.localhost/<…>` on Windows, as wry spells custom schemes there; Tauri's
//! `convertFileSrc(url, 'fxm-media')` builds the right form (`bridge/media.ts`).
//!
//! What it serves, and to whom:
//!
//! - **The main window's webview only.** A request from any other webview, such as stage 1.11's
//!   evaluator, gets 403. Only the app's own origins get CORS headers.
//! - **googlevideo stream URLs only** ([`is_stream_url`]): HTTPS, a host under `googlevideo.com`,
//!   the default port, no user name, the path `/videoplayback`. Redirects are followed only to
//!   such URLs, at most [`MAX_REDIRECTS`]. Those hosts are in the HTTP plugin's scope already, so
//!   page script reaches nothing here that it couldn't read through the plugin.
//! - **`GET`, with the page's `Range`.** A custom scheme's answer is handed to the webview whole,
//!   never streamed, so Rust fetches a file in blocks of [`CHUNK_BYTES`] (256 KiB), as ranged
//!   requests, and an answer never reaches past the block its range starts in: media elements
//!   ask again for the rest, as with Tauri's own asset protocol. The element gets nothing of a
//!   block until all of it has arrived, when it starts and after a seek past what is kept, so
//!   blocks are small: 256 KiB take 2 s at 1 Mbit/s, and arrive within the player's 15-second
//!   stall timeout on any link faster than about 140 kbit/s, about what a 128 kbit/s stream
//!   needs to play at all. Blocks are kept for a while ([`CACHE_BYTES`] in all, the least
//!   recently used go first), because media elements read in small, overlapping ranges: WebKit
//!   reads an MP4 file's fragment headers one by one, 8 bytes at a time, which would otherwise
//!   each be a request to googlevideo. A request without `Range` (WebKit asks for WebM files
//!   that way) gets the whole file, up to [`MAX_WHOLE_BYTES`], from the same blocks.
//! - **googlevideo's status as it is.** A 403 reaches the element as a 403, so the player's
//!   recovery (stage 2.3: re-resolve on 403, the probe rules of stage 1.4) sees what it sees
//!   without this path. A failed connection is 502. A request is given up with 504 when
//!   googlevideo sends nothing for [`READ_TIMEOUT`] (15 s), its answer's head included, or after
//!   [`REQUEST_TIMEOUT`] (2 minutes) in all: a slow link that keeps sending gets its block.
//! - **Nothing of the page's but `Range` and `User-Agent`.** No cookies, `Origin` or `Referer`
//!   reach googlevideo. The `User-Agent` is the webview's own, which googlevideo also gets when
//!   the page plays its URLs directly.
//! - **Never a page.** Tauri lets a document from any scheme the app registers call its IPC, with
//!   the main window's capabilities (`is_local_url` in tauri's `webview/mod.rs`), so an answer
//!   must never run as one. Every answer, errors included, carries
//!   `Content-Security-Policy: default-src 'none'; sandbox` ([`ANSWER_CSP`]) and `nosniff`, which
//!   media elements ignore, and a request for a page or a frame (its `Sec-Fetch-Dest`) gets 403
//!   before anything is fetched. Media types, an empty body on errors and `nosniff` already keep
//!   a webview from showing an answer as a page; the policy holds should one ever do so.
//!
//! The requests go through Rust's network, as the stream's resolution and probe did, so they
//! leave from the same address the URL is bound to, through the same proxy settings
//! (`system-proxy`). Error messages name a host, never a URL: a googlevideo URL's query carries
//! the user's IP address and signatures.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use percent_encoding::percent_decode_str;
use tauri::{
    Runtime, UriSchemeContext, UriSchemeResponder,
    async_runtime::Mutex as AsyncMutex,
    http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, header},
};
use tauri_plugin_http::reqwest::{self, Url, redirect::Policy};

/// The URI scheme: `fxm-media://localhost/…`, `http://fxm-media.localhost/…` on Windows.
pub const SCHEME: &str = "fxm-media";

/// The host wry gives the scheme on Windows: `http://fxm-media.localhost/`.
pub const WINDOWS_HOST: &str = "fxm-media.localhost";

/// The domain every stream host is under: `rr1---sn-….googlevideo.com`.
pub const STREAM_DOMAIN: &str = "googlevideo.com";

/// The path of every stream URL.
pub const STREAM_PATH: &str = "/videoplayback";

/// The size of the blocks Rust fetches, and so the most bytes one answer to a ranged request
/// carries: 256 KiB. The element asks for the rest in further requests. It waits for a whole
/// block before it gets any of it (see the module documentation), so this is small enough to
/// arrive within the player's 15-second stall timeout on a slow link, and large enough that the
/// blocks fold WebKit's many small reads into a few requests: about 16 for a 4 MB song.
pub const CHUNK_BYTES: u64 = 256 * 1024;

/// The largest file a request without `Range` gets: 128 MiB, more than two hours of Opus 251.
pub const MAX_WHOLE_BYTES: u64 = 128 * 1024 * 1024;

/// How many bytes of googlevideo's blocks are kept: 32 MiB, a few songs.
pub const CACHE_BYTES: usize = 32 * 1024 * 1024;

// A block arrives within the player's 15-second stall timeout (packages/player) at 160 kbit/s, a
// little more than a 128 kbit/s stream needs to play: see CHUNK_BYTES.
const _: () = assert!(CHUNK_BYTES * 8 < 15 * 160_000);

/// How long connecting to googlevideo may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long googlevideo may send nothing, from the request to its answer's head and then
/// between any two reads of the body: a request that gets no byte for that long has stalled.
pub const READ_TIMEOUT: Duration = Duration::from_secs(15);

/// How long one request to googlevideo may take in all, body included: only a cap for a server
/// that trickles. A block that arrives slower (256 KiB in 2 minutes, about 17 kbit/s) couldn't
/// keep any stream playing anyway.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// The `Content-Security-Policy` of every answer: nothing may load or run, should a webview ever
/// show one as a page (see the module documentation). Media elements ignore it.
pub const ANSWER_CSP: &str = "default-src 'none'; sandbox";

/// The `Sec-Fetch-Dest` values of the requests the scheme serves: media elements', and `empty`,
/// which no webview is known to send them but which is no page either. A request without the
/// header is served too: not every webview sends it to a custom scheme.
pub const MEDIA_DESTINATIONS: &[&str] = &["audio", "video", "empty"];

/// How many redirects one request may follow, each to a stream URL.
pub const MAX_REDIRECTS: usize = 5;

/// The origins of the app's own pages: `tauri://localhost` on macOS and Linux,
/// `http://tauri.localhost` on Windows (`https://` with `useHttpsScheme`).
pub const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// The web dev server's origin (`build > devUrl`), which debug builds also answer.
pub const DEV_ORIGIN: &str = "http://localhost:5260";

/// Whether `url` is a googlevideo stream URL this scheme serves: HTTPS, a host under
/// [`STREAM_DOMAIN`], the default port, no user name or password, the path [`STREAM_PATH`].
pub fn is_stream_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == STREAM_PATH
        && url.domain().is_some_and(|host| {
            host.strip_suffix(STREAM_DOMAIN)
                .is_some_and(|label| label.len() > 1 && label.ends_with('.'))
        })
}

/// The stream URL a request asks for: its path without the leading `/`, percent-decoded, as
/// `convertFileSrc` encoded it.
pub fn target_of(path: &str) -> Option<Url> {
    let encoded = path.strip_prefix('/')?;
    let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
    Url::parse(&decoded).ok()
}

/// A single byte range of a `Range` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteRange {
    /// `bytes=first-last`, or `bytes=first-` (`last` is `None`).
    From { first: u64, last: Option<u64> },
    /// `bytes=-length`: the last `length` bytes.
    Suffix(u64),
}

impl ByteRange {
    /// The range to ask googlevideo for: this one, cut to at most `chunk` bytes.
    fn capped(self, chunk: u64) -> Self {
        match self {
            Self::From { first, last } => {
                let cap = first.saturating_add(chunk - 1);
                Self::From {
                    first,
                    last: Some(last.map_or(cap, |last| last.min(cap))),
                }
            }
            Self::Suffix(length) => Self::Suffix(length.min(chunk)),
        }
    }

    /// The value of a `Range` header for it.
    fn header(self) -> String {
        match self {
            Self::From {
                first,
                last: Some(last),
            } => format!("bytes={first}-{last}"),
            Self::From { first, last: None } => format!("bytes={first}-"),
            Self::Suffix(length) => format!("bytes=-{length}"),
        }
    }
}

/// Reads a `Range` header: one range in bytes, the only kind media elements send. `None` for
/// anything else, which the scheme refuses.
pub fn parse_range(value: &str) -> Option<ByteRange> {
    let spec = value.trim().strip_prefix("bytes=")?.trim();
    let (first, last) = spec.split_once('-')?;
    let number = |text: &str| -> Option<u64> {
        let text = text.trim();
        (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
    };
    match (first.trim().is_empty(), last.trim().is_empty()) {
        (true, false) => number(last)
            .filter(|length| *length > 0)
            .map(ByteRange::Suffix),
        (false, true) => Some(ByteRange::From {
            first: number(first)?,
            last: None,
        }),
        (false, false) => {
            let (first, last) = (number(first)?, number(last)?);
            (first <= last).then_some(ByteRange::From {
                first,
                last: Some(last),
            })
        }
        (true, true) => None,
    }
}

/// A `Content-Range` of a 206 answer: `bytes first-last/length`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentRange {
    pub first: u64,
    pub last: u64,
    pub length: u64,
}

impl ContentRange {
    /// How many bytes it covers.
    fn bytes(self) -> u64 {
        self.last - self.first + 1
    }
}

/// Reads a `Content-Range` header of a 206 answer; `None` unless it is `bytes first-last/length`
/// with `first <= last < length`.
pub fn parse_content_range(value: &str) -> Option<ContentRange> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (span, length) = rest.split_once('/')?;
    let (first, last) = span.split_once('-')?;
    let range = ContentRange {
        first: first.trim().parse().ok()?,
        last: last.trim().parse().ok()?,
        length: length.trim().parse().ok()?,
    };
    (range.first <= range.last && range.last < range.length).then_some(range)
}

/// Whether `range` answers what was asked: from the asked start (or to the end of the file, for
/// a suffix), and no more than was asked.
fn answers(asked: ByteRange, range: ContentRange) -> bool {
    match asked {
        ByteRange::From { first, last } => {
            range.first == first && last.is_none_or(|last| range.last <= last)
        }
        ByteRange::Suffix(length) => range.last + 1 == range.length && range.bytes() <= length,
    }
}

/// What the scheme serves, and how much: [`MediaPolicy::default`] in the app, a local server's
/// in tests.
#[derive(Debug, Clone)]
pub struct MediaPolicy {
    /// Which URLs may be fetched, redirects included. Default: [`is_stream_url`].
    pub allowed: fn(&Url) -> bool,
    /// Whether only HTTPS may be used. Only tests turn it off, for a local server.
    pub https_only: bool,
    /// Whether the system's and the environment's proxy settings apply, as for the HTTP plugin.
    /// Tests turn it off, whatever the machine running them sets.
    pub system_proxy: bool,
    /// The most bytes one ranged answer carries: [`CHUNK_BYTES`].
    pub chunk_bytes: u64,
    /// The largest file served without `Range`: [`MAX_WHOLE_BYTES`].
    pub max_whole_bytes: u64,
    /// How many bytes of blocks are kept: [`CACHE_BYTES`].
    pub cache_bytes: usize,
    /// How long googlevideo may send nothing: [`READ_TIMEOUT`].
    pub read_timeout: Duration,
    /// How long one request to googlevideo may take in all: [`REQUEST_TIMEOUT`].
    pub request_timeout: Duration,
    /// The origins that get CORS headers: [`APP_ORIGINS`], plus [`DEV_ORIGIN`] in debug builds.
    pub origins: Vec<String>,
}

impl Default for MediaPolicy {
    fn default() -> Self {
        let mut origins: Vec<String> = APP_ORIGINS.iter().map(|&origin| origin.into()).collect();
        if cfg!(debug_assertions) {
            origins.push(DEV_ORIGIN.into());
        }
        Self {
            allowed: is_stream_url,
            https_only: true,
            system_proxy: true,
            chunk_bytes: CHUNK_BYTES,
            max_whole_bytes: MAX_WHOLE_BYTES,
            cache_bytes: CACHE_BYTES,
            read_timeout: READ_TIMEOUT,
            request_timeout: REQUEST_TIMEOUT,
            origins,
        }
    }
}

/// Why a request got no media.
#[derive(Debug)]
enum Failure {
    /// The scheme refuses the request itself.
    Refused(StatusCode, &'static str),
    /// googlevideo answered with an error, which the element gets as it is. A 416 keeps its
    /// `Content-Range` (`bytes */length`).
    Upstream(StatusCode, Option<HeaderValue>),
    /// googlevideo's answer can't be used, or googlevideo couldn't be reached.
    BadGateway(String),
    /// googlevideo didn't answer in time.
    Timeout,
}

impl Failure {
    fn status(&self) -> StatusCode {
        match self {
            Self::Refused(status, _) | Self::Upstream(status, _) => *status,
            Self::BadGateway(_) => StatusCode::BAD_GATEWAY,
            Self::Timeout => StatusCode::GATEWAY_TIMEOUT,
        }
    }

    fn from_request(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else {
            Self::BadGateway(describe_error(&error.without_url()))
        }
    }
}

/// An error and its causes on one line, e.g. `error sending request: client error (Connect): …`.
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

/// A URL's host, as error messages name it.
fn host_of(url: &Url) -> String {
    url.host_str().unwrap_or("?").to_owned()
}

/// The media a request gets.
#[derive(Debug)]
struct Media {
    status: StatusCode,
    content_type: HeaderValue,
    content_range: Option<String>,
    body: Vec<u8>,
}

/// The `Content-Type` of the media: googlevideo's, when it is an audio or video type, else
/// `application/octet-stream`.
fn media_type(headers: &HeaderMap) -> HeaderValue {
    headers
        .get(header::CONTENT_TYPE)
        .filter(|value| {
            value.to_str().is_ok_and(|text| {
                let text = text.trim().to_ascii_lowercase();
                text.starts_with("audio/") || text.starts_with("video/")
            })
        })
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"))
}

/// A block of a file: [`MediaPolicy::chunk_bytes`] bytes from a multiple of that size, or the
/// rest of the file.
struct Block {
    /// Its bytes.
    data: Vec<u8>,
    /// The whole file's length.
    length: u64,
    /// googlevideo's `Content-Type`, as [`media_type`] keeps it.
    content_type: HeaderValue,
}

/// Which block: the file's URL and the block's number.
type BlockKey = (Arc<str>, u64);

/// The blocks kept, least recently used first.
#[derive(Default)]
struct Blocks {
    entries: HashMap<BlockKey, Arc<Block>>,
    order: VecDeque<BlockKey>,
    bytes: usize,
}

impl Blocks {
    /// The block, now the most recently used, if it is kept.
    fn get(&mut self, key: &BlockKey) -> Option<Arc<Block>> {
        let block = self.entries.get(key)?.clone();
        if let Some(position) = self.order.iter().position(|kept| kept == key)
            && let Some(kept) = self.order.remove(position)
        {
            self.order.push_back(kept);
        }
        Some(block)
    }

    /// Keeps `block`, then drops the least recently used blocks beyond `limit` bytes.
    fn insert(&mut self, key: BlockKey, block: Arc<Block>, limit: usize) {
        if let Some(old) = self.entries.insert(key.clone(), block.clone()) {
            self.bytes -= old.data.len();
            self.order.retain(|kept| kept != &key);
        }
        self.bytes += block.data.len();
        self.order.push_back(key);
        while self.bytes > limit {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(dropped) = self.entries.remove(&oldest) {
                self.bytes -= dropped.data.len();
            }
        }
    }

    /// The length of the file at `url`, if a block of it is kept.
    fn length_of(&self, url: &str) -> Option<u64> {
        self.entries
            .iter()
            .find(|((kept, _), _)| &**kept == url)
            .map(|(_, block)| block.length)
    }
}

/// Serves the scheme: one HTTP client for every request, so connections to googlevideo are kept
/// and reused, and the blocks googlevideo sent lately.
pub struct MediaProxy {
    client: reqwest::Client,
    policy: MediaPolicy,
    blocks: Mutex<Blocks>,
    /// One lock per block being fetched, so that reads of it at once fetch it once.
    fetching: Mutex<HashMap<BlockKey, Arc<AsyncMutex<()>>>>,
}

impl MediaProxy {
    /// A proxy with `policy`. Fails only when the HTTP client can't be built.
    pub fn new(policy: MediaPolicy) -> Result<Self, String> {
        let allowed = policy.allowed;
        let redirects = Policy::custom(move |attempt| {
            if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if allowed(attempt.url()) {
                attempt.follow()
            } else {
                // The 3xx comes back as it is, and the request fails (`MediaProxy::fetch`).
                attempt.stop()
            }
        });
        // An idle timeout, not a total one: a slow link that keeps sending gets its block, and
        // the total only caps a server that trickles.
        let mut builder = reqwest::Client::builder()
            .redirect(redirects)
            .connect_timeout(CONNECT_TIMEOUT.min(policy.read_timeout))
            .read_timeout(policy.read_timeout)
            .timeout(policy.request_timeout)
            .https_only(policy.https_only)
            // The bytes exactly as googlevideo sends them, as for the probe.
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd();
        if !policy.system_proxy {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            policy,
            blocks: Mutex::default(),
            fetching: Mutex::default(),
        })
    }

    /// Answers a request to the scheme (see the module documentation).
    pub async fn serve(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let cors = self.cors_origin(request.headers());
        let response = match self.media(request).await {
            Ok(media) => {
                let mut response = Response::builder()
                    .status(media.status)
                    .header(header::CONTENT_TYPE, media.content_type)
                    .header(header::ACCEPT_RANGES, "bytes");
                if let Some(range) = media.content_range {
                    response = response.header(header::CONTENT_RANGE, range);
                }
                response.body(media.body)
            }
            Err(failure) => {
                match &failure {
                    Failure::Refused(status, reason) => eprintln!("{SCHEME}: {status} ({reason})"),
                    Failure::BadGateway(reason) => eprintln!("{SCHEME}: 502 ({reason})"),
                    Failure::Upstream(..) | Failure::Timeout => {}
                }
                let mut response = Response::builder().status(failure.status());
                if let Failure::Upstream(_, Some(range)) = &failure {
                    response = response.header(header::CONTENT_RANGE, range);
                }
                response.body(Vec::new())
            }
        };
        let mut response = response.expect("a response of valid parts");
        let headers = response.headers_mut();
        never_a_page(headers);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        if let Some(origin) = cors {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            headers.insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("Content-Range"),
            );
        }
        response
    }

    /// The request's `Origin`, when it is one of the app's own: it gets CORS headers.
    fn cors_origin(&self, headers: &HeaderMap) -> Option<HeaderValue> {
        let origin = headers.get(header::ORIGIN)?;
        let text = origin.to_str().ok()?;
        self.policy
            .origins
            .iter()
            .any(|allowed| allowed == text)
            .then(|| origin.clone())
    }

    /// The media for a request, or why there is none.
    async fn media(&self, request: &Request<Vec<u8>>) -> Result<Media, Failure> {
        if request.method() != Method::GET {
            return Err(Failure::Refused(
                StatusCode::METHOD_NOT_ALLOWED,
                "only GET requests",
            ));
        }
        if !is_media_request(request.headers()) {
            return Err(Failure::Refused(
                StatusCode::FORBIDDEN,
                "not a media element's request",
            ));
        }
        let target = target_of(request.uri().path())
            .ok_or(Failure::Refused(StatusCode::BAD_REQUEST, "not a URL"))?;
        if !(self.policy.allowed)(&target) {
            return Err(Failure::Refused(
                StatusCode::FORBIDDEN,
                "not a googlevideo stream URL",
            ));
        }
        let user_agent = request.headers().get(header::USER_AGENT);
        match request.headers().get(header::RANGE) {
            Some(value) => {
                let range = value
                    .to_str()
                    .ok()
                    .and_then(parse_range)
                    .ok_or(Failure::Refused(
                        StatusCode::BAD_REQUEST,
                        "unsupported Range",
                    ))?;
                self.ranged(&target, range, user_agent).await
            }
            None => self.whole(&target, user_agent).await,
        }
    }

    /// Asks googlevideo for `range` of `target`.
    async fn fetch(
        &self,
        target: &Url,
        range: ByteRange,
        user_agent: Option<&HeaderValue>,
    ) -> Result<reqwest::Response, Failure> {
        let mut request = self
            .client
            .get(target.clone())
            .header(header::RANGE, range.header())
            .header(header::ACCEPT_ENCODING, "identity");
        if let Some(agent) = user_agent {
            request = request.header(header::USER_AGENT, agent.clone());
        }
        let response = request.send().await.map_err(Failure::from_request)?;
        let status = response.status();
        // The smoke build's record of each request to googlevideo: its range and the status.
        #[cfg(feature = "smoke")]
        eprintln!(
            "{SCHEME}: googlevideo {} -> {}",
            range.header(),
            status.as_u16()
        );
        if status.is_redirection() {
            return Err(Failure::BadGateway(format!(
                "{} redirected outside googlevideo",
                host_of(target)
            )));
        }
        if status.is_client_error() || status.is_server_error() {
            let content_range = (status == StatusCode::RANGE_NOT_SATISFIABLE)
                .then(|| response.headers().get(header::CONTENT_RANGE).cloned())
                .flatten();
            return Err(Failure::Upstream(status, content_range));
        }
        if status != StatusCode::PARTIAL_CONTENT {
            return Err(Failure::BadGateway(format!(
                "{} answered {status} to a range",
                host_of(target)
            )));
        }
        Ok(response)
    }

    /// Block `index` of `target`: kept, or fetched once however many reads want it at once.
    async fn block(
        &self,
        target: &Url,
        index: u64,
        user_agent: Option<&HeaderValue>,
    ) -> Result<Arc<Block>, Failure> {
        let key: BlockKey = (Arc::from(target.as_str()), index);
        if let Some(block) = self.kept(&key) {
            return Ok(block);
        }
        let lock = self
            .fetching
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key.clone())
            .or_default()
            .clone();
        let _fetching = lock.lock().await;
        // Fetched while this read waited.
        if let Some(block) = self.kept(&key) {
            return Ok(block);
        }
        let fetched = self
            .fetch_block(target, index, user_agent)
            .await
            .map(Arc::new);
        if let Ok(block) = &fetched {
            self.blocks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(key.clone(), block.clone(), self.policy.cache_bytes);
        }
        self.fetching
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key);
        fetched
    }

    fn kept(&self, key: &BlockKey) -> Option<Arc<Block>> {
        self.blocks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
    }

    /// Asks googlevideo for block `index` of `target`, which must come back whole: all of it, or
    /// all the rest of the file.
    async fn fetch_block(
        &self,
        target: &Url,
        index: u64,
        user_agent: Option<&HeaderValue>,
    ) -> Result<Block, Failure> {
        let size = self.policy.chunk_bytes;
        let first = index.saturating_mul(size);
        let last = first.saturating_add(size - 1);
        let asked = ByteRange::From {
            first,
            last: Some(last),
        };
        let response = self.fetch(target, asked, user_agent).await?;
        let content_type = media_type(response.headers());
        let (range, data) = read_part(response, asked).await?;
        if range.last != last.min(range.length - 1) {
            return Err(Failure::BadGateway(format!(
                "{} answered part of a range",
                host_of(target)
            )));
        }
        Ok(Block {
            data,
            length: range.length,
            content_type,
        })
    }

    /// A range: from its start to its end or the end of the block it starts in, whichever comes
    /// first; a 206. A suffix range (which media elements don't send) is fetched as it is.
    async fn ranged(
        &self,
        target: &Url,
        range: ByteRange,
        user_agent: Option<&HeaderValue>,
    ) -> Result<Media, Failure> {
        let ByteRange::From { first, last } = range else {
            return self.suffix(target, range, user_agent).await;
        };
        let past_end = |length: u64| {
            Failure::Upstream(
                StatusCode::RANGE_NOT_SATISFIABLE,
                HeaderValue::from_str(&format!("bytes */{length}")).ok(),
            )
        };
        let known = self
            .blocks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .length_of(target.as_str());
        if let Some(length) = known
            && first >= length
        {
            return Err(past_end(length));
        }
        let size = self.policy.chunk_bytes;
        let index = first / size;
        let block = self.block(target, index, user_agent).await?;
        let start = index * size;
        let block_last = start + block.data.len() as u64 - 1;
        if first > block_last {
            return Err(past_end(block.length));
        }
        let end = last.map_or(block_last, |last| last.min(block_last));
        let body = block.data[(first - start) as usize..=(end - start) as usize].to_vec();
        Ok(Media {
            status: StatusCode::PARTIAL_CONTENT,
            content_type: block.content_type.clone(),
            content_range: Some(format!("bytes {first}-{end}/{}", block.length)),
            body,
        })
    }

    /// A suffix range, at most [`MediaPolicy::chunk_bytes`] of it, straight from googlevideo.
    async fn suffix(
        &self,
        target: &Url,
        range: ByteRange,
        user_agent: Option<&HeaderValue>,
    ) -> Result<Media, Failure> {
        let asked = range.capped(self.policy.chunk_bytes);
        let response = self.fetch(target, asked, user_agent).await?;
        let content_type = media_type(response.headers());
        let (range, body) = read_part(response, asked).await?;
        Ok(Media {
            status: StatusCode::PARTIAL_CONTENT,
            content_type,
            content_range: Some(format!(
                "bytes {}-{}/{}",
                range.first, range.last, range.length
            )),
            body,
        })
    }

    /// The whole file, from its blocks, up to [`MediaPolicy::max_whole_bytes`]: a 200.
    async fn whole(
        &self,
        target: &Url,
        user_agent: Option<&HeaderValue>,
    ) -> Result<Media, Failure> {
        let host = host_of(target);
        let unusable = |what: &str| Failure::BadGateway(format!("{host} {what}"));
        let first = self.block(target, 0, user_agent).await?;
        let length = first.length;
        if length > self.policy.max_whole_bytes {
            return Err(unusable("has a file over the size limit"));
        }
        let capacity = usize::try_from(length).map_err(|_| unusable("has a file too large"))?;
        let mut body = Vec::with_capacity(capacity);
        body.extend_from_slice(&first.data);
        for index in 1..length.div_ceil(self.policy.chunk_bytes) {
            let block = self.block(target, index, user_agent).await?;
            if block.length != length {
                return Err(unusable("changed the file's length"));
            }
            body.extend_from_slice(&block.data);
        }
        if body.len() as u64 != length {
            return Err(unusable("sent another length than its file's"));
        }
        Ok(Media {
            status: StatusCode::OK,
            content_type: first.content_type.clone(),
            content_range: None,
            body,
        })
    }
}

/// The body of a 206 answer to `asked`, with its `Content-Range`, after checking that the range
/// is the one asked for and that the body is exactly that long.
async fn read_part(
    response: reqwest::Response,
    asked: ByteRange,
) -> Result<(ContentRange, Vec<u8>), Failure> {
    let host = response.url().host_str().unwrap_or("?").to_owned();
    let range = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range)
        .filter(|range| answers(asked, *range))
        .ok_or_else(|| Failure::BadGateway(format!("{host} answered another range")))?;
    let body = read_body(response, range.bytes())
        .await?
        .filter(|body| body.len() as u64 == range.bytes())
        .ok_or_else(|| Failure::BadGateway(format!("{host} sent another length than its range")))?;
    Ok((range, body))
}

/// A response's body, or `None` when it is longer than `limit` bytes.
async fn read_body(
    mut response: reqwest::Response,
    limit: u64,
) -> Result<Option<Vec<u8>>, Failure> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Ok(None);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(Failure::from_request)? {
        if (body.len() + chunk.len()) as u64 > limit {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

/// Whether a webview may use the scheme: the main window's own only.
pub fn serves_webview(label: &str) -> bool {
    label == crate::MAIN_WINDOW
}

/// Whether a request may be a media element's: its `Sec-Fetch-Dest`, if it sends one, is one of
/// [`MEDIA_DESTINATIONS`]. A request for a page or a frame (`document`, `iframe`, …) is not.
pub fn is_media_request(headers: &HeaderMap) -> bool {
    headers.get_all("sec-fetch-dest").iter().all(|value| {
        value
            .to_str()
            .is_ok_and(|destination| MEDIA_DESTINATIONS.contains(&destination))
    })
}

/// The headers that keep every answer from running as a page, and from being kept: see the
/// module documentation.
fn never_a_page(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(ANSWER_CSP),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

/// A 403 for a webview that may not use the scheme, or a 503 when the proxy couldn't be built.
fn refusal(status: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("a static response");
    never_a_page(response.headers_mut());
    response
}

/// The scheme's handler for `tauri::Builder::register_asynchronous_uri_scheme_protocol`: answers
/// each request on Tauri's async runtime, with `proxy`, or with 503 when it couldn't be built.
pub fn handler<R: Runtime>(
    proxy: Result<MediaProxy, String>,
) -> impl Fn(UriSchemeContext<'_, R>, Request<Vec<u8>>, UriSchemeResponder) + Send + Sync + 'static
{
    let proxy = match proxy {
        Ok(proxy) => Some(Arc::new(proxy)),
        Err(error) => {
            eprintln!("{SCHEME}: the media proxy could not start: {error}");
            None
        }
    };
    move |context, request, responder| {
        if !serves_webview(context.webview_label()) {
            responder.respond(refusal(StatusCode::FORBIDDEN));
            return;
        }
        let Some(proxy) = proxy.clone() else {
            responder.respond(refusal(StatusCode::SERVICE_UNAVAILABLE));
            return;
        };
        tauri::async_runtime::spawn(async move {
            let response = proxy.serve(&request).await;
            #[cfg(feature = "smoke")]
            log_for_smoke(&request, &response);
            responder.respond(response);
        });
    }
}

/// The smoke build's record of each request: the `Range` asked for and the answer, never the URL.
#[cfg(feature = "smoke")]
fn log_for_smoke(request: &Request<Vec<u8>>, response: &Response<Vec<u8>>) {
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("none");
    let answered = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let cors = response
        .headers()
        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN);
    eprintln!(
        "{SCHEME}: Range {range} -> {} {answered} ({} bytes, CORS {cors})",
        response.status().as_u16(),
        response.body().len()
    );
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        sync::Mutex,
        thread,
    };

    use super::*;

    fn url(text: &str) -> Url {
        text.parse().expect("a URL")
    }

    /// A stream URL as stage 1.4 resolves one, with a query that carries an IP address.
    const STREAM: &str = "https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?expire=1&ip=203.0.113.7&itag=251&mime=audio%2Fwebm";

    /// What `convertFileSrc(url, 'fxm-media')` makes of `url`: `encodeURIComponent` in the path.
    fn scheme_path(target: &str) -> String {
        let encoded: String = target
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                    char::from(byte).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        format!("/{encoded}")
    }

    #[test]
    fn serves_googlevideo_stream_urls_only() {
        assert!(is_stream_url(&url(STREAM)));
        assert!(is_stream_url(&url(
            "https://rr1---sn-4g5e6nsk.googlevideo.com/videoplayback?itag=18"
        )));
        for other in [
            // Another scheme, port, user, path or host.
            "http://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?itag=251",
            "https://rr3---sn-ab5l6nrz.googlevideo.com:8443/videoplayback",
            "https://user:pass@rr3---sn-ab5l6nrz.googlevideo.com/videoplayback",
            "https://rr3---sn-ab5l6nrz.googlevideo.com/initplayback?itag=251",
            "https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback/x",
            "https://googlevideo.com/videoplayback",
            "https://evilgooglevideo.com/videoplayback",
            "https://rr3.googlevideo.com.evil.test/videoplayback",
            "https://www.youtube.com/videoplayback",
            "https://192.168.1.1/videoplayback",
        ] {
            assert!(!is_stream_url(&url(other)), "{other} must be refused");
        }
    }

    #[test]
    fn reads_the_url_that_convert_file_src_encoded() {
        assert_eq!(target_of(&scheme_path(STREAM)), Some(url(STREAM)));
        assert_eq!(target_of("/not%20a%20url"), None);
        assert_eq!(target_of("/%FF%FE"), None, "not UTF-8");
        assert_eq!(target_of(""), None);
    }

    #[test]
    fn reads_the_ranges_media_elements_send() {
        assert_eq!(
            parse_range("bytes=0-"),
            Some(ByteRange::From {
                first: 0,
                last: None
            })
        );
        assert_eq!(
            parse_range("bytes=0-1"),
            Some(ByteRange::From {
                first: 0,
                last: Some(1)
            })
        );
        assert_eq!(
            parse_range(" bytes=1048576-4194303 "),
            Some(ByteRange::From {
                first: 1_048_576,
                last: Some(4_194_303)
            })
        );
        assert_eq!(parse_range("bytes=-500"), Some(ByteRange::Suffix(500)));
        for refused in [
            "bytes=5-4",
            "bytes=-0",
            "bytes=-",
            "bytes=0-1,5-9",
            "bytes=a-",
            "bytes=+1-",
            "items=0-",
            "bytes 0-",
            "",
        ] {
            assert_eq!(parse_range(refused), None, "{refused}");
        }
    }

    #[test]
    fn asks_googlevideo_for_at_most_a_chunk() {
        let chunk = 1000;
        let from = |first, last| ByteRange::From { first, last };
        assert_eq!(from(0, None).capped(chunk), from(0, Some(999)));
        assert_eq!(from(0, Some(1)).capped(chunk), from(0, Some(1)));
        assert_eq!(from(5000, Some(9000)).capped(chunk), from(5000, Some(5999)));
        assert_eq!(ByteRange::Suffix(64).capped(chunk), ByteRange::Suffix(64));
        assert_eq!(
            ByteRange::Suffix(5000).capped(chunk),
            ByteRange::Suffix(1000)
        );
        assert_eq!(from(0, Some(999)).header(), "bytes=0-999");
        assert_eq!(from(7, None).header(), "bytes=7-");
        assert_eq!(ByteRange::Suffix(64).header(), "bytes=-64");
    }

    #[test]
    fn reads_content_ranges() {
        assert_eq!(
            parse_content_range("bytes 0-1048575/4123456"),
            Some(ContentRange {
                first: 0,
                last: 1_048_575,
                length: 4_123_456
            })
        );
        for refused in [
            "bytes */4123456",
            "bytes 5-4/10",
            "bytes 0-10/10",
            "bytes 0-1/*",
            "0-1/2",
        ] {
            assert_eq!(parse_content_range(refused), None, "{refused}");
        }
    }

    #[test]
    fn checks_that_an_answer_is_the_range_asked_for() {
        let range = |first, last, length| ContentRange {
            first,
            last,
            length,
        };
        let asked = ByteRange::From {
            first: 100,
            last: Some(199),
        };
        assert!(answers(asked, range(100, 199, 1000)));
        assert!(answers(asked, range(100, 150, 151)), "the end of the file");
        assert!(!answers(asked, range(0, 199, 1000)), "another start");
        assert!(!answers(asked, range(100, 200, 1000)), "more than asked");
        let suffix = ByteRange::Suffix(64);
        assert!(answers(suffix, range(936, 999, 1000)));
        assert!(!answers(suffix, range(900, 999, 1000)), "more than asked");
        assert!(!answers(suffix, range(900, 963, 1000)), "not the end");
    }

    #[test]
    fn only_the_main_window_may_use_the_scheme() {
        assert!(serves_webview(crate::MAIN_WINDOW));
        assert!(!serves_webview("fxm-evaluator-0"));
        assert!(!serves_webview(""));
    }

    #[test]
    fn answers_the_app_origins_with_cors_and_debug_builds_the_dev_server_too() {
        let origins = MediaPolicy::default().origins;
        for origin in APP_ORIGINS {
            assert!(origins.iter().any(|allowed| allowed == origin), "{origin}");
        }
        assert_eq!(
            origins.iter().any(|origin| origin == DEV_ORIGIN),
            cfg!(debug_assertions)
        );
        assert!(!origins.iter().any(|origin| origin == "null"));
    }

    #[test]
    fn the_scheme_is_in_the_media_policy_of_the_csp() {
        // The page may load media from the scheme in both of its forms, and nothing else changes.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let csp = config["app"]["security"]["csp"].as_str().expect("a CSP");
        let media = csp
            .split(';')
            .map(str::trim)
            .find_map(|directive| directive.strip_prefix("media-src "))
            .expect("a media-src directive");
        let sources: Vec<&str> = media.split_whitespace().collect();
        assert!(sources.contains(&format!("{SCHEME}:").as_str()));
        assert!(sources.contains(&format!("http://{WINDOWS_HOST}").as_str()));
    }

    // --- A local googlevideo -----------------------------------------------------------------

    /// The bytes of the test file: two and a half test chunks and 7 bytes, so it spans three.
    fn file() -> Vec<u8> {
        let length = 2 * TEST_CHUNK + TEST_CHUNK / 2 + 7;
        (0..length).map(|index| (index % 251) as u8).collect()
    }

    /// A request the server received: its request line and its headers, in lower case.
    #[derive(Debug, Clone)]
    struct Seen {
        line: String,
        headers: HashMap<String, String>,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name).map(String::as_str)
        }
    }

    /// A stand-in for googlevideo on 127.0.0.1, which records every request:
    ///
    /// - `/videoplayback` serves [`file`] with `audio/webm`: 206 for a range, 416 past its end,
    ///   200 without `Range`;
    /// - `/redirect?to=<port>` answers 302 to `/videoplayback` on that port;
    /// - `/forbidden` answers 403;
    /// - `/ignores-range` answers 200 with the whole file whatever the `Range`;
    /// - `/other-range` answers a range other than the one asked for;
    /// - `/short` announces a range and sends less, then closes;
    /// - `/html` serves the file's ranges as `text/html`;
    /// - `/stingy` serves at most 1000 bytes of any range asked for;
    /// - `/slow` answers after 3 s;
    /// - `/trickle` serves a range's body in [`TRICKLE_PIECES`] pieces, [`TRICKLE_GAP`] apart;
    /// - `/stall` sends half a range's body, then nothing for [`STALL`].
    fn serve() -> (u16, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
        let port = listener.local_addr().expect("an address").port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let log = log.clone();
                thread::spawn(move || answer(stream, &log));
            }
        });
        (port, seen)
    }

    fn answer(mut stream: TcpStream, log: &Mutex<Vec<Seen>>) {
        let mut reader = BufReader::new(stream.try_clone().expect("a clone"));
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let mut headers = HashMap::new();
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                headers.insert(name.trim().to_lowercase(), value.trim().to_owned());
            }
        }
        let seen = Seen {
            line: line.trim().to_owned(),
            headers,
        };
        log.lock().unwrap().push(seen.clone());
        let target = seen.line.split(' ').nth(1).unwrap_or("/").to_owned();
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        let file = file();
        let range = seen.header("range").and_then(parse_range);
        let partial = |content_type: &str, range: ByteRange| -> Vec<u8> {
            let length = file.len() as u64;
            let (first, last) = match range {
                ByteRange::From { first, last } => {
                    (first, last.unwrap_or(length - 1).min(length - 1))
                }
                ByteRange::Suffix(n) => (length - n.min(length), length - 1),
            };
            if first >= length {
                return format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .into_bytes();
            }
            let body = &file[first as usize..=last as usize];
            let mut response = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Type: {content_type}\r\nContent-Range: bytes {first}-{last}/{length}\r\nContent-Length: {}\r\nSet-Cookie: s=1\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            response.extend_from_slice(body);
            response
        };
        let whole = |content_type: &str| -> Vec<u8> {
            let mut response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                file.len()
            )
            .into_bytes();
            response.extend_from_slice(&file);
            response
        };
        let status = |line: &str| -> Vec<u8> {
            format!("HTTP/1.1 {line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        };
        let mut pacing = Pacing::AtOnce;
        let response = match (path, range) {
            ("/videoplayback", Some(range)) => partial("audio/webm", range),
            ("/videoplayback", None) => whole("audio/webm"),
            ("/trickle", Some(range)) => {
                pacing = Pacing::Trickle;
                partial("audio/webm", range)
            }
            ("/stall", Some(range)) => {
                pacing = Pacing::Stall;
                partial("audio/webm", range)
            }
            ("/html", Some(range)) => partial("text/html", range),
            ("/stingy", Some(ByteRange::From { first, last })) => {
                let last = last.unwrap_or(u64::MAX).min(first + 999);
                partial("audio/webm", ByteRange::From { first, last: Some(last) })
            }
            ("/redirect", _) => {
                let port = query.strip_prefix("to=").unwrap_or("1");
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/videoplayback\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .into_bytes()
            }
            ("/forbidden", _) => status("403 Forbidden"),
            ("/ignores-range", _) => whole("audio/webm"),
            ("/other-range", _) => partial("audio/webm", ByteRange::From { first: 1, last: Some(10) }),
            ("/short", _) => {
                b"HTTP/1.1 206 Partial Content\r\nContent-Type: audio/webm\r\nContent-Range: bytes 0-99/1000\r\nContent-Length: 100\r\nConnection: close\r\n\r\nonly a few".to_vec()
            }
            ("/slow", _) => {
                thread::sleep(Duration::from_secs(3));
                status("204 No Content")
            }
            _ => status("404 Not Found"),
        };
        write_paced(&mut stream, &response, pacing);
        // The answer ends here, which the client sees at once (a short body fails then, on every
        // system); the socket closes once the client is done, or after a moment.
        let _ = stream.shutdown(Shutdown::Write);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest);
    }

    /// How the test server sends an answer's body.
    #[derive(Debug, Clone, Copy)]
    enum Pacing {
        /// All at once.
        AtOnce,
        /// In [`TRICKLE_PIECES`] pieces, [`TRICKLE_GAP`] apart: slowly, but steadily.
        Trickle,
        /// Half of it, then nothing for [`STALL`], then the rest.
        Stall,
    }

    /// `/trickle` sends a body in 12 pieces, 250 ms apart: 3 s in all.
    const TRICKLE_PIECES: usize = 12;
    const TRICKLE_GAP: Duration = Duration::from_millis(250);

    /// `/stall` stops sending for 2 s halfway through a body.
    const STALL: Duration = Duration::from_secs(2);

    /// Writes `response`, its head at once and its body as `pacing` says.
    fn write_paced(stream: &mut TcpStream, response: &[u8], pacing: Pacing) {
        let head = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map_or(response.len(), |end| end + 4);
        let (head, body) = response.split_at(head);
        let _ = stream.write_all(head);
        match pacing {
            Pacing::AtOnce => {
                let _ = stream.write_all(body);
            }
            Pacing::Trickle => {
                for piece in body.chunks(body.len().div_ceil(TRICKLE_PIECES).max(1)) {
                    let _ = stream.flush();
                    thread::sleep(TRICKLE_GAP);
                    let _ = stream.write_all(piece);
                }
            }
            Pacing::Stall => {
                let (first, rest) = body.split_at(body.len() / 2);
                let _ = stream.write_all(first);
                let _ = stream.flush();
                thread::sleep(STALL);
                let _ = stream.write_all(rest);
            }
        }
        let _ = stream.flush();
    }

    /// The test chunk: the app's.
    const TEST_CHUNK: u64 = CHUNK_BYTES;

    /// Local URLs on 127.0.0.1 over plain HTTP, the test server's.
    fn local(url: &Url) -> bool {
        url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
    }

    fn policy() -> MediaPolicy {
        MediaPolicy {
            allowed: local,
            https_only: false,
            system_proxy: false,
            chunk_bytes: TEST_CHUNK,
            max_whole_bytes: 8 * 1024 * 1024,
            cache_bytes: 8 * 1024 * 1024,
            read_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(30),
            origins: APP_ORIGINS.iter().map(|&origin| origin.into()).collect(),
        }
    }

    fn proxy(policy: MediaPolicy) -> MediaProxy {
        MediaProxy::new(policy).expect("a client")
    }

    /// A request to the scheme for `target`, as the webview sends it.
    fn request(target: &str, headers: &[(&str, &str)]) -> Request<Vec<u8>> {
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri(format!("{SCHEME}://localhost{}", scheme_path(target)));
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Vec::new()).expect("a request")
    }

    fn send(proxy: &MediaProxy, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        tauri::async_runtime::block_on(proxy.serve(request))
    }

    fn header<'a>(response: &'a Response<Vec<u8>>, name: &str) -> Option<&'a str> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    const WEBKIT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

    #[test]
    fn serves_an_open_range_as_one_chunk_with_cors_for_the_app() {
        let (port, seen) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback?ip=203.0.113.7");
        let response = send(
            &proxy,
            &request(
                &target,
                &[
                    ("range", "bytes=0-"),
                    ("origin", "tauri://localhost"),
                    ("user-agent", WEBKIT),
                    ("cookie", "SID=secret"),
                    ("referer", "tauri://localhost/"),
                ],
            ),
        );
        let file = file();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &file[..TEST_CHUNK as usize]);
        assert_eq!(
            header(&response, "content-range"),
            Some(format!("bytes 0-{}/{}", TEST_CHUNK - 1, file.len()).as_str())
        );
        assert_eq!(header(&response, "content-type"), Some("audio/webm"));
        assert_eq!(header(&response, "accept-ranges"), Some("bytes"));
        assert_eq!(
            header(&response, "access-control-allow-origin"),
            Some("tauri://localhost")
        );
        assert_eq!(header(&response, "cache-control"), Some("no-store"));
        assert!(header(&response, "set-cookie").is_none());
        // googlevideo got the range cut to a chunk, the webview's User-Agent, and nothing else of
        // the page's.
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let upstream = &seen[0];
        assert!(
            upstream
                .line
                .starts_with("GET /videoplayback?ip=203.0.113.7 ")
        );
        assert_eq!(
            upstream.header("range"),
            Some(format!("bytes=0-{}", TEST_CHUNK - 1).as_str())
        );
        assert_eq!(upstream.header("user-agent"), Some(WEBKIT));
        assert_eq!(upstream.header("accept-encoding"), Some("identity"));
        for header in ["cookie", "origin", "referer", "authorization"] {
            assert!(
                upstream.header(header).is_none(),
                "{header} reached googlevideo"
            );
        }
    }

    #[test]
    fn serves_a_closed_range_as_asked_and_the_rest_from_where_the_element_asks() {
        let (port, _) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let file = file();
        let response = send(&proxy, &request(&target, &[("range", "bytes=0-1")]));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &file[..2]);
        let next = format!("bytes={TEST_CHUNK}-");
        let response = send(&proxy, &request(&target, &[("range", next.as_str())]));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let first = TEST_CHUNK as usize;
        assert_eq!(response.body().as_slice(), &file[first..first * 2]);
        // The last chunk ends with the file.
        let last = format!("bytes={}-", 2 * TEST_CHUNK);
        let response = send(&proxy, &request(&target, &[("range", last.as_str())]));
        assert_eq!(response.body().as_slice(), &file[2 * first..]);
        assert_eq!(
            header(&response, "content-range"),
            Some(format!("bytes {}-{}/{}", 2 * first, file.len() - 1, file.len()).as_str())
        );
    }

    #[test]
    fn serves_the_end_of_the_file_for_a_suffix_range() {
        let (port, _) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let response = send(&proxy, &request(&target, &[("range", "bytes=-100")]));
        let file = file();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &file[file.len() - 100..]);
    }

    #[test]
    fn serves_the_whole_file_without_a_range_one_chunk_at_a_time() {
        let (port, seen) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let response = send(
            &proxy,
            &request(&target, &[("origin", "http://tauri.localhost")]),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), &file());
        assert!(header(&response, "content-range").is_none());
        assert_eq!(
            header(&response, "access-control-allow-origin"),
            Some("http://tauri.localhost")
        );
        let ranges: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.header("range").unwrap_or("none").to_owned())
            .collect();
        assert_eq!(ranges, block_ranges(3));
    }

    /// The `Range`s of the first `count` blocks, as the proxy asks googlevideo for them.
    fn block_ranges(count: u64) -> Vec<String> {
        (0..count)
            .map(|index| {
                format!(
                    "bytes={}-{}",
                    index * TEST_CHUNK,
                    (index + 1) * TEST_CHUNK - 1
                )
            })
            .collect()
    }

    fn upstream_ranges(seen: &Mutex<Vec<Seen>>) -> Vec<String> {
        seen.lock()
            .unwrap()
            .iter()
            .map(|request| request.header("range").unwrap_or("none").to_owned())
            .collect()
    }

    #[test]
    fn serves_small_reads_from_one_fetch_of_their_block() {
        // WebKit reads an MP4 file's boxes and fragment headers a few bytes at a time.
        let (port, seen) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let file = file();
        for (first, last) in [
            (0, 1),
            (0, 7),
            (24, 31),
            (40, 139),
            (161_000, 161_007),
            (8, 23),
        ] {
            let range = format!("bytes={first}-{last}");
            let response = send(&proxy, &request(&target, &[("range", range.as_str())]));
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(response.body().as_slice(), &file[first..=last], "{range}");
            assert_eq!(
                header(&response, "content-range"),
                Some(format!("bytes {first}-{last}/{}", file.len()).as_str())
            );
        }
        assert_eq!(upstream_ranges(&seen), block_ranges(1));
        // The whole file reuses the block, and a read past its end needs no request.
        let response = send(&proxy, &request(&target, &[]));
        assert_eq!(response.body(), &file);
        let past = format!("bytes={}-", file.len());
        let response = send(&proxy, &request(&target, &[("range", past.as_str())]));
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            header(&response, "content-range"),
            Some(format!("bytes */{}", file.len()).as_str())
        );
        assert_eq!(upstream_ranges(&seen), block_ranges(3));
    }

    #[test]
    fn answers_a_range_across_blocks_up_to_the_end_of_its_first() {
        let (port, _) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let range = format!("bytes={}-{}", TEST_CHUNK - 10, TEST_CHUNK + 10);
        let response = send(&proxy, &request(&target, &[("range", range.as_str())]));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), 10);
        assert_eq!(
            header(&response, "content-range"),
            Some(
                format!(
                    "bytes {}-{}/{}",
                    TEST_CHUNK - 10,
                    TEST_CHUNK - 1,
                    file().len()
                )
                .as_str()
            )
        );
    }

    #[test]
    fn fetches_a_block_once_for_reads_of_it_at_the_same_time() {
        let (port, seen) = serve();
        let proxy = Arc::new(proxy(policy()));
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let reads: Vec<_> = (0..6)
            .map(|offset| {
                let proxy = proxy.clone();
                let request = request(&target, &[("range", &format!("bytes={offset}-"))]);
                tauri::async_runtime::spawn(async move { proxy.serve(&request).await })
            })
            .collect();
        for read in reads {
            let response = tauri::async_runtime::block_on(read).expect("a read");
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        }
        assert_eq!(upstream_ranges(&seen), block_ranges(1));
    }

    #[test]
    fn keeps_the_most_recently_used_blocks_only() {
        let (port, seen) = serve();
        let proxy = proxy(MediaPolicy {
            cache_bytes: 2 * TEST_CHUNK as usize,
            ..policy()
        });
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let read = |index: u64| {
            let range = format!("bytes={}-{}", index * TEST_CHUNK, index * TEST_CHUNK + 9);
            send(&proxy, &request(&target, &[("range", range.as_str())])).status()
        };
        // Blocks 0 and 1 fill the cache; reading 0 again makes 1 the least recently used.
        for index in [0, 1, 0, 2, 0, 1] {
            assert_eq!(read(index), StatusCode::PARTIAL_CONTENT);
        }
        let blocks: Vec<String> = block_ranges(3);
        assert_eq!(
            upstream_ranges(&seen),
            [&blocks[0], &blocks[1], &blocks[2], &blocks[1]].map(String::as_str)
        );
    }

    #[test]
    fn refuses_a_block_that_comes_back_short() {
        // A block is kept for later reads, so it must hold all it stands for.
        let (port, _) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/stingy");
        let response = send(&proxy, &request(&target, &[("range", "bytes=0-")]));
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let response = send(&proxy, &request(&target, &[]));
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn refuses_a_whole_file_over_the_limit_without_fetching_the_rest() {
        let (port, seen) = serve();
        let proxy = proxy(MediaPolicy {
            max_whole_bytes: 2 * TEST_CHUNK,
            ..policy()
        });
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let response = send(&proxy, &request(&target, &[]));
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(response.body().is_empty());
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn hands_googlevideo_errors_to_the_element_as_they_are() {
        let (port, _) = serve();
        let proxy = proxy(policy());
        let forbidden = format!("http://127.0.0.1:{port}/forbidden");
        let response = send(
            &proxy,
            &request(
                &forbidden,
                &[("range", "bytes=0-"), ("origin", "tauri://localhost")],
            ),
        );
        // A 403, as the element would get without this path, and readable by the page.
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());
        assert_eq!(
            header(&response, "access-control-allow-origin"),
            Some("tauri://localhost")
        );
        let past = format!("http://127.0.0.1:{port}/videoplayback");
        let response = send(&proxy, &request(&past, &[("range", "bytes=99999999-")]));
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            header(&response, "content-range"),
            Some(format!("bytes */{}", file().len()).as_str())
        );
    }

    #[test]
    fn follows_redirects_only_to_stream_urls() {
        let (target_port, target_seen) = serve();
        let (port, _) = serve();
        let proxy = proxy(policy());
        let redirect = format!("http://127.0.0.1:{port}/redirect?to={target_port}");
        let response = send(&proxy, &request(&redirect, &[("range", "bytes=0-99")]));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &file()[..100]);
        assert_eq!(target_seen.lock().unwrap().len(), 1);

        // A redirect off the allowed URLs isn't followed: the request fails.
        let (elsewhere, elsewhere_seen) = serve();
        let strict = MediaProxy::new(MediaPolicy {
            allowed: |url| local(url) && url.path() == "/redirect",
            ..policy()
        })
        .expect("a client");
        let redirect = format!("http://127.0.0.1:{port}/redirect?to={elsewhere}");
        let response = send(&strict, &request(&redirect, &[("range", "bytes=0-99")]));
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(elsewhere_seen.lock().unwrap().is_empty());
    }

    #[test]
    fn refuses_answers_that_are_not_the_range_asked_for() {
        let (port, _) = serve();
        let proxy = proxy(policy());
        for path in ["/ignores-range", "/other-range", "/short"] {
            let target = format!("http://127.0.0.1:{port}{path}");
            for range in [Some("bytes=0-"), Some("bytes=-100"), None] {
                let headers: Vec<(&str, &str)> =
                    range.map(|range| ("range", range)).into_iter().collect();
                let response = send(&proxy, &request(&target, &headers));
                assert_eq!(
                    response.status(),
                    StatusCode::BAD_GATEWAY,
                    "{path} {range:?}"
                );
                assert!(response.body().is_empty(), "{path} {range:?}");
            }
        }
    }

    #[test]
    fn serves_only_audio_and_video_types() {
        let (port, _) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/html");
        let response = send(&proxy, &request(&target, &[("range", "bytes=0-9")]));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            header(&response, "content-type"),
            Some("application/octet-stream")
        );
        assert_eq!(header(&response, "x-content-type-options"), Some("nosniff"));
    }

    #[test]
    fn times_out_with_504_when_no_answer_comes() {
        let (port, _) = serve();
        let proxy = proxy(MediaPolicy {
            read_timeout: Duration::from_millis(500),
            ..policy()
        });
        let target = format!("http://127.0.0.1:{port}/slow");
        let response = send(&proxy, &request(&target, &[("range", "bytes=0-")]));
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    }

    #[test]
    fn serves_a_block_that_arrives_slowly_but_steadily() {
        // A slow link: the block takes 3 s, three times the read timeout, in pieces 250 ms apart.
        // A timeout on the whole request of that length would have cut it short.
        let (port, _) = serve();
        let proxy = proxy(MediaPolicy {
            read_timeout: Duration::from_secs(1),
            ..policy()
        });
        let target = format!("http://127.0.0.1:{port}/trickle");
        let started = std::time::Instant::now();
        let response = send(&proxy, &request(&target, &[("range", "bytes=0-")]));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &file()[..TEST_CHUNK as usize]);
        assert!(started.elapsed() > Duration::from_secs(1));
    }

    #[test]
    fn gives_up_with_504_on_a_stall_or_past_the_cap() {
        let (port, _) = serve();
        // Half the block, then nothing for longer than the read timeout.
        let stalled = proxy(MediaPolicy {
            read_timeout: Duration::from_millis(500),
            ..policy()
        });
        let target = format!("http://127.0.0.1:{port}/stall");
        let response = send(&stalled, &request(&target, &[("range", "bytes=0-")]));
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert!(response.body().is_empty());
        // Steady, but slower than the cap on the whole request allows.
        let capped = proxy(MediaPolicy {
            read_timeout: Duration::from_secs(1),
            request_timeout: Duration::from_secs(1),
            ..policy()
        });
        let target = format!("http://127.0.0.1:{port}/trickle");
        let response = send(&capped, &request(&target, &[("range", "bytes=0-")]));
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    }

    #[test]
    fn no_answer_can_run_as_a_page() {
        let (port, seen) = serve();
        let proxy = proxy(policy());
        let stream = format!("http://127.0.0.1:{port}/videoplayback");
        let forbidden = format!("http://127.0.0.1:{port}/forbidden");
        let answers = [
            send(&proxy, &request(&stream, &[("range", "bytes=0-9")])),
            send(&proxy, &request(&forbidden, &[("range", "bytes=0-")])),
            send(
                &proxy,
                &request("https://example.com/", &[("range", "bytes=0-")]),
            ),
            refusal(StatusCode::FORBIDDEN),
            refusal(StatusCode::SERVICE_UNAVAILABLE),
        ];
        let statuses: Vec<u16> = answers
            .iter()
            .map(|answer| answer.status().as_u16())
            .collect();
        assert_eq!(statuses, [206, 403, 403, 403, 503]);
        for answer in &answers {
            assert_eq!(header(answer, "content-security-policy"), Some(ANSWER_CSP));
            assert_eq!(header(answer, "x-content-type-options"), Some("nosniff"));
            assert_eq!(header(answer, "cache-control"), Some("no-store"));
        }
        assert_eq!(seen.lock().unwrap().len(), 2, "example.com was never asked");
    }

    #[test]
    fn refuses_a_request_for_a_page_or_a_frame_before_any_fetch() {
        let (port, seen) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let ask = |destination: &str| {
            let headers = [("range", "bytes=0-9"), ("sec-fetch-dest", destination)];
            send(&proxy, &request(&target, &headers))
        };
        for destination in [
            "document", "iframe", "frame", "embed", "object", "script", "",
        ] {
            let response = ask(destination);
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{destination}");
            assert!(response.body().is_empty(), "{destination}");
        }
        assert!(seen.lock().unwrap().is_empty());
        for destination in MEDIA_DESTINATIONS {
            assert_eq!(
                ask(destination).status(),
                StatusCode::PARTIAL_CONTENT,
                "{destination}"
            );
        }
    }

    #[test]
    fn gives_cors_headers_to_the_app_origins_only() {
        let (port, _) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        for (origin, allowed) in [
            ("tauri://localhost", true),
            ("http://tauri.localhost", true),
            ("https://evil.example", false),
            ("null", false),
            ("http://localhost:5260", false),
        ] {
            let response = send(
                &proxy,
                &request(&target, &[("range", "bytes=0-9"), ("origin", origin)]),
            );
            assert_eq!(
                header(&response, "access-control-allow-origin").is_some(),
                allowed,
                "{origin}"
            );
            assert_eq!(header(&response, "vary"), Some("Origin"));
        }
        // A request without an Origin (a no-cors media load) still plays, without CORS headers.
        let response = send(&proxy, &request(&target, &[("range", "bytes=0-9")]));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert!(header(&response, "access-control-allow-origin").is_none());
    }

    #[test]
    fn refuses_requests_it_does_not_serve_before_any_fetch() {
        let (port, seen) = serve();
        let proxy = proxy(policy());
        let target = format!("http://127.0.0.1:{port}/videoplayback");
        let post = Request::builder()
            .method(Method::POST)
            .uri(format!("{SCHEME}://localhost{}", scheme_path(&target)))
            .body(Vec::new())
            .unwrap();
        assert_eq!(send(&proxy, &post).status(), StatusCode::METHOD_NOT_ALLOWED);
        let response = send(&proxy, &request(&target, &[("range", "bytes=0-1,5-9")]));
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let not_a_url = Request::builder()
            .uri(format!("{SCHEME}://localhost/not%20a%20url"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(send(&proxy, &not_a_url).status(), StatusCode::BAD_REQUEST);
        assert!(seen.lock().unwrap().is_empty());

        // The app's own policy refuses anything but googlevideo's stream URLs.
        let app = MediaProxy::new(MediaPolicy {
            system_proxy: false,
            ..MediaPolicy::default()
        })
        .expect("a client");
        for refused in [
            target.as_str(),
            "https://www.youtube.com/youtubei/v1/player",
            "https://archive.org/download/x/x.mp3",
        ] {
            let response = send(&app, &request(refused, &[("range", "bytes=0-")]));
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{refused}");
        }
        assert!(seen.lock().unwrap().is_empty());
    }
}
