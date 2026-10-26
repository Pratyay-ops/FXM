//! The FXM desktop shell: the web app (apps/web, built with base `/`) in a Tauri webview.
//!
//! tauri-plugin-http is the web app's network (stage 7.2): the web app's `createDesktopFetch`
//! sends every request through it, within the scope in capabilities/default.json, so the app
//! needs no browser extension. Hosts the user adds in Settings go through the commands in
//! [`user_hosts`] instead.
//!
//! IPC payloads from a page pass the isolation hook in `../isolation` (Tauri's isolation pattern,
//! set in tauri.conf.json) before Rust reads them. Whatever the command, the hook keeps page
//! script from giving the HTTP plugin a proxy of its own or a forbidden header, except in a
//! start-up gap that the app's README describes.

use tauri::{AppHandle, Manager};
use tauri_plugin_window_state::StateFlags;

mod evaluator;
// The live smoke test's report listener: always compiled, so lints and tests cover it, but only
// started in the smoke build (`--features smoke`, apps/desktop/smoke).
#[cfg_attr(not(feature = "smoke"), allow(dead_code))]
mod smoke;
pub mod user_hosts;

/// Label of the main window in `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";

/// Builds and runs the app until its last window closes.
pub fn run() {
    tauri::Builder::default()
        // Registered first: a second launch only brings the running app to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // Size, position, maximized and full screen survive restarts. Visibility does not:
        // the app always opens with its window showing.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        // Requests are limited to the hosts in capabilities/default.json, and so are redirects
        // (`scopeRedirects` in tauri.conf.json).
        .plugin(tauri_plugin_http::init())
        // Opens links with target="_blank" in the default browser.
        .plugin(tauri_plugin_opener::init())
        // The isolated evaluator in a hidden webview of its own (stage 1.11, src/evaluator.rs).
        .plugin(evaluator::init())
        .setup(|app| {
            let file = app.path().app_config_dir()?.join(user_hosts::FILE_NAME);
            app.manage(user_hosts::UserHosts::load(file));
            // The live smoke test's build only (apps/desktop/smoke).
            #[cfg(feature = "smoke")]
            smoke::listen(app.handle());
            Ok(())
        })
        // Keep in step with COMMANDS in build.rs, which puts each behind a permission.
        .invoke_handler(tauri::generate_handler![
            user_hosts::user_hosts,
            user_hosts::approve_user_host,
            user_hosts::revoke_user_host,
            user_hosts::user_host_fetch,
        ])
        .run(context())
        .expect("error while running the FXM desktop app");
}

/// The app's configuration, icons and, in release builds, the embedded web app. The macro
/// may expand only once per crate (it defines a symbol on macOS), so tests share this.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // Best effort: a window that can't be raised is not worth crashing over.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::{MAIN_WINDOW, context};

    #[test]
    fn config_defines_the_main_window() {
        let context = context();
        let config = context.config();
        assert_eq!(config.identifier, "io.github.pratyayops.fxm");
        assert_eq!(config.product_name.as_deref(), Some("FXM"));
        let main = config
            .app
            .windows
            .iter()
            .find(|window| window.label == MAIN_WINDOW)
            .expect("tauri.conf.json has no window labelled \"main\"");
        assert_eq!(main.title, "FXM");
        assert_eq!(
            (main.min_width, main.min_height),
            (Some(360.0), Some(600.0))
        );
        assert!(config.app.security.csp.is_some(), "the CSP must stay on");
    }

    #[test]
    fn ipc_messages_pass_the_isolation_hook() {
        // Without the crate's `isolation` feature, Tauri would quietly fall back to the brownfield
        // pattern, and no message would pass the hook.
        let context = context();
        assert!(
            matches!(context.pattern(), tauri::Pattern::Isolation { .. }),
            "tauri.conf.json must set the isolation pattern, and Cargo.toml the feature"
        );
    }
}
