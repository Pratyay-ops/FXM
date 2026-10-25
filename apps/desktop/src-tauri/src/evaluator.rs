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
//! No capability names the evaluator's window, so its page can't call any command. The main
//! window drives it through this plugin's three commands, which `packages/platform`'s
//! `createTauriEvaluator` calls:
//!
//! - `open` creates the hidden window;
//! - `eval` runs a script in it and answers the script's value as JSON text
//!   (`eval_with_callback`), which is how the main window reads the document's mailbox;
//! - `close` destroys it.

use std::sync::mpsc;
use std::time::Duration;

use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// The plugin's name: its commands are `plugin:fxm-evaluator|open`, `|eval` and `|close`.
pub const PLUGIN: &str = "fxm-evaluator";

/// The URI scheme the hidden webview loads the evaluator document from.
pub const SCHEME: &str = "fxm-eval";

/// The label of the hidden evaluator window. No capability names it.
pub const WINDOW: &str = "fxm-evaluator";

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

/// The document's URL. wry turns it into `http://fxm-eval.localhost/eval.html` on Windows.
fn document_url() -> WebviewUrl {
    WebviewUrl::CustomProtocol(
        format!("{SCHEME}://localhost{DOCUMENT_PATH}")
            .parse()
            .expect("a valid URL"),
    )
}

/// Creates the hidden evaluator window, unless it exists.
#[tauri::command]
async fn open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if app.get_webview_window(WINDOW).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, WINDOW, document_url())
        .title("FXM evaluator")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(320.0, 240.0)
        .build()
        .map(|_| ())
        .map_err(|error| format!("The evaluator window could not open: {error}"))
}

/// Runs `script` in the evaluator window and answers its value as JSON text.
#[tauri::command]
async fn eval<R: Runtime>(app: AppHandle<R>, script: String) -> Result<String, String> {
    let window = app
        .get_webview_window(WINDOW)
        .ok_or_else(|| "The evaluator window is not open".to_string())?;
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
async fn close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    match app.get_webview_window(WINDOW) {
        Some(window) => window.destroy().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// The evaluator plugin: the scheme handler and the three commands. Its permission
/// (`fxm-evaluator:default`) is granted to the main window only.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN)
        .register_uri_scheme_protocol(SCHEME, |_context, request| respond(&request))
        .invoke_handler(tauri::generate_handler![open, eval, close])
        .build()
}

#[cfg(test)]
mod tests {
    use super::{DOCUMENT, DOCUMENT_PATH, policy, respond};
    use tauri::http::{Method, Request, StatusCode, header};

    fn request(method: Method, path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(method)
            .uri(format!("fxm-eval://localhost{path}"))
            .body(Vec::new())
            .expect("a request")
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
}
