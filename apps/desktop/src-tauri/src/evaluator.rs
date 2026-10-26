//! The isolated evaluator's host on desktop (stage 1.11): where FXM runs YouTube's player script
//! and Google's BotGuard, which its own pages must not run.
//!
//! Tauri applies one app-wide content security policy to the pages it serves, and a `<meta>`
//! policy can only tighten it, so the main window's policy can't allow `'unsafe-eval'` for the
//! evaluator alone, and it never allows it. Instead this plugin opens a second, hidden webview
//! window on its own URI scheme, `fxm-eval://localhost/eval.html` (`http://fxm-eval.localhost/`
//! on Windows), and serves `apps/web/sandbox/eval.html` from it with that document's own policy:
//! only its inline script runs, it may compile scripts (`'unsafe-eval'`), and it may connect
//! nowhere (`connect-src 'none'`).
//!
//! What the window's page can't do:
//!
//! - call a command: no capability names its webview (`capabilities/default.json` grants the
//!   plugins and the app's own commands to `main`'s only). Tauri checks the app's own commands
//!   (`src/user_hosts.rs`) against the capabilities because `build.rs` lists them in an
//!   access-control manifest; without one, any local page could call them, and
//!   `apps/desktop/test/evaluator.test.ts` fails if an app command appears without one;
//! - leave its document: the window allows no navigation away from it and opens no new window,
//!   and `eval` refuses a window that shows anything else;
//! - outlive the app: it is destroyed with the main window, so closing that window still quits.
//!
//! The main window drives it through this plugin's three commands, which `packages/platform`'s
//! `createTauriEvaluator` calls:
//!
//! - `open` creates a new hidden window (destroying any earlier one): every document starts
//!   fresh, with an empty mailbox;
//! - `eval` runs a script in it and answers the script's value as JSON text
//!   (`eval_with_callback`), which is how the main window reads the document's mailbox;
//! - `close` destroys it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError, mpsc};
use std::time::Duration;

use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Runtime, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

/// The plugin's name: its commands are `plugin:fxm-evaluator|open`, `|eval` and `|close`.
pub const PLUGIN: &str = "fxm-evaluator";

/// The URI scheme the hidden webview loads the evaluator document from.
pub const SCHEME: &str = "fxm-eval";

/// The host wry gives the scheme on Windows: `http://fxm-eval.localhost/`.
pub const WINDOWS_HOST: &str = "fxm-eval.localhost";

/// The start of the label of every evaluator window, followed by a number that changes with
/// every `open`. No capability names these windows.
pub const WINDOW_PREFIX: &str = "fxm-evaluator-";

/// The path the document is served at.
pub const DOCUMENT_PATH: &str = "/eval.html";

/// The evaluator document, built by `packages/platform` (`pnpm --filter @fxm/platform
/// build:evaluator`). Its only script is inline and allowed by its hash.
pub const DOCUMENT: &str = include_str!("../../../web/sandbox/eval.html");

/// How long one `eval` may take. A script that throws never calls back on Windows, so the
/// command gives up instead of waiting forever.
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);

/// The start of the document's `<meta>` policy.
const META_POLICY: &str = r#"<meta http-equiv="Content-Security-Policy" content=""#;

/// The evaluator window that runs, if one does. Its label changes with every `open`, so a new
/// window never collides with an old one that is still going away.
#[derive(Default)]
struct Current {
    label: Mutex<Option<String>>,
    next: AtomicU64,
}

/// The policy the scheme serves the document with: `sandbox allow-scripts` (an opaque origin, as
/// on the web), then the document's own `<meta>` policy, so both name the same script hash.
pub fn policy() -> String {
    let start = DOCUMENT
        .find(META_POLICY)
        .map(|index| index + META_POLICY.len())
        .expect("eval.html has a <meta> content security policy");
    let length = DOCUMENT[start..]
        .find('"')
        .expect("eval.html's <meta> policy ends");
    format!(
        "sandbox allow-scripts; {}",
        &DOCUMENT[start..start + length]
    )
}

/// Answers a request to the evaluator's scheme: the document at [`DOCUMENT_PATH`], with its
/// policy, and nothing else.
pub fn respond(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(b"Not found".to_vec())
            .expect("a static response")
    };
    if request.method() != Method::GET || request.uri().path() != DOCUMENT_PATH {
        return not_found();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, policy())
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(DOCUMENT.as_bytes().to_vec())
        .expect("a static response")
}

/// Whether `url` is the evaluator document: on its scheme (`fxm-eval://localhost`) or in the
/// form wry gives that scheme on Windows (`http://fxm-eval.localhost`), at [`DOCUMENT_PATH`].
/// The fragment doesn't matter: it stays the same document.
pub fn is_document_url(url: &Url) -> bool {
    let own_scheme = url.scheme() == SCHEME && url.host_str() == Some("localhost");
    let windows_form =
        matches!(url.scheme(), "http" | "https") && url.host_str() == Some(WINDOWS_HOST);
    (own_scheme || windows_form) && url.port().is_none() && url.path() == DOCUMENT_PATH
}

/// Whether `event` of the window labelled `label` is the end of the app's main window, which the
/// evaluator window must not outlive: Tauri quits only once no window is left, hidden ones
/// included.
pub fn ends_main_window(label: &str, event: &WindowEvent) -> bool {
    label == crate::MAIN_WINDOW && matches!(event, WindowEvent::Destroyed)
}

/// The document's URL. wry turns it into `http://fxm-eval.localhost/eval.html` on Windows.
fn document_url() -> WebviewUrl {
    WebviewUrl::CustomProtocol(
        format!("{SCHEME}://localhost{DOCUMENT_PATH}")
            .parse()
            .expect("a valid URL"),
    )
}

/// The running evaluator window, if there is one.
fn current_window<R: Runtime>(app: &AppHandle<R>, current: &Current) -> Option<WebviewWindow<R>> {
    let label = current
        .label
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()?;
    app.get_webview_window(&label)
}

/// Destroys every evaluator window: the running one, and any that an `open` overtaken by
/// another left behind, which would otherwise keep the app running.
fn destroy<R: Runtime>(app: &AppHandle<R>, current: &Current) {
    current
        .label
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    for (label, window) in app.webview_windows() {
        if label.starts_with(WINDOW_PREFIX) {
            // Best effort: the window is forgotten either way.
            let _ = window.destroy();
        }
    }
}

/// Creates a new hidden evaluator window, destroying any earlier one.
#[tauri::command]
async fn open<R: Runtime>(app: AppHandle<R>, current: State<'_, Current>) -> Result<(), String> {
    destroy(&app, &current);
    let label = format!(
        "{WINDOW_PREFIX}{}",
        current.next.fetch_add(1, Ordering::Relaxed)
    );
    WebviewWindowBuilder::new(&app, &label, document_url())
        .title("FXM evaluator")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(320.0, 240.0)
        // A hidden page that WebKit suspends stops answering, as the smoke test's hidden window
        // did (stages 7.2 and 7.3), and the player resolves its next track while FXM is hidden.
        // macOS 14 and later; Windows and Linux have no such switch.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // Its document stays its document: no navigation away from it, and no new windows. (Its
        // policy's sandbox already refuses popups.)
        .on_navigation(is_document_url)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
        .map_err(|error| format!("The evaluator window could not open: {error}"))?;
    *current.label.lock().unwrap_or_else(PoisonError::into_inner) = Some(label);
    Ok(())
}

/// Runs `script` in the evaluator window and answers its value as JSON text.
#[tauri::command]
async fn eval<R: Runtime>(
    app: AppHandle<R>,
    current: State<'_, Current>,
    script: String,
) -> Result<String, String> {
    let window = current_window(&app, &current)
        .ok_or_else(|| "The evaluator window is not open".to_string())?;
    // A window that shows anything but its document is not read: it is destroyed.
    if !window.url().is_ok_and(|url| is_document_url(&url)) {
        destroy(&app, &current);
        return Err("The evaluator window left its document".to_string());
    }
    let (sender, receiver) = mpsc::channel();
    window
        .eval_with_callback(script, move |value| {
            let _ = sender.send(value);
        })
        .map_err(|error| format!("The evaluator could not run the script: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(EVAL_TIMEOUT))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "The evaluator did not answer in time".to_string())
}

/// Destroys the evaluator window, if it is open.
#[tauri::command]
async fn close<R: Runtime>(app: AppHandle<R>, current: State<'_, Current>) -> Result<(), String> {
    destroy(&app, &current);
    Ok(())
}

/// The evaluator plugin: the scheme handler and the three commands. Its permission
/// (`fxm-evaluator:default`) is granted to the main window only.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN)
        .setup(|app, _api| {
            app.manage(Current::default());
            Ok(())
        })
        .register_uri_scheme_protocol(SCHEME, |_context, request| respond(&request))
        .invoke_handler(tauri::generate_handler![open, eval, close])
        .on_event(|app, event| {
            if let RunEvent::WindowEvent { label, event, .. } = event
                && ends_main_window(label, event)
                && let Some(current) = app.try_state::<Current>()
            {
                destroy(app, &current);
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{DOCUMENT, DOCUMENT_PATH, ends_main_window, is_document_url, policy, respond};
    use tauri::http::{Method, Request, StatusCode, header};
    use tauri::{Url, WindowEvent};

    fn request(method: Method, path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(method)
            .uri(format!("fxm-eval://localhost{path}"))
            .body(Vec::new())
            .expect("a request")
    }

    fn url(text: &str) -> Url {
        text.parse().expect("a URL")
    }

    #[test]
    fn serves_the_document_with_its_own_policy() {
        let response = respond(&request(Method::GET, DOCUMENT_PATH));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), DOCUMENT.as_bytes());
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .expect("an ASCII policy");
        assert_eq!(csp, policy());
        assert_eq!(
            response.headers()[header::REFERRER_POLICY],
            "no-referrer",
            "googlevideo must not learn where requests come from"
        );
    }

    #[test]
    fn the_policy_allows_only_the_inline_script_and_no_connections() {
        let csp = policy();
        assert!(csp.starts_with("sandbox allow-scripts; default-src 'none'; "));
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("'unsafe-eval'"));
        assert!(!csp.contains("'unsafe-inline'"));
        let hash = csp
            .split_whitespace()
            .find(|source| source.starts_with("'sha256-"))
            .expect("a script hash");
        assert!(
            DOCUMENT.contains(hash),
            "the document's <meta> policy names the same hash"
        );
    }

    #[test]
    fn serves_nothing_else() {
        assert_eq!(
            respond(&request(Method::GET, "/other.html")).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(&request(Method::POST, DOCUMENT_PATH)).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn the_window_may_show_its_document_only() {
        assert!(is_document_url(&url("fxm-eval://localhost/eval.html")));
        assert!(is_document_url(&url("fxm-eval://localhost/eval.html#part")));
        assert!(is_document_url(&url("http://fxm-eval.localhost/eval.html")));
        assert!(is_document_url(&url(
            "https://fxm-eval.localhost/eval.html"
        )));
        for other in [
            "https://evil.test/?leak=video",
            "fxm-eval://localhost/other.html",
            "fxm-eval://evil.test/eval.html",
            "http://fxm-eval.localhost:8080/eval.html",
            "http://fxm-eval.localhost.evil.test/eval.html",
            "tauri://localhost/eval.html",
            "about:blank",
        ] {
            assert!(!is_document_url(&url(other)), "{other} must be refused");
        }
    }

    #[test]
    fn goes_with_the_main_window() {
        assert!(ends_main_window(
            crate::MAIN_WINDOW,
            &WindowEvent::Destroyed
        ));
        assert!(!ends_main_window(
            "fxm-evaluator-0",
            &WindowEvent::Destroyed
        ));
        assert!(!ends_main_window(
            crate::MAIN_WINDOW,
            &WindowEvent::Focused(false)
        ));
    }
}
