//! The FXM desktop shell: the web app (apps/web, built with base `/`) in a Tauri webview.
//!
//! This stage only wires up the plugins. Stage 7.2 makes tauri-plugin-http the fetch for
//! YouTube and Spotify, so the app will need no browser extension.

use tauri::{AppHandle, Manager};
use tauri_plugin_window_state::StateFlags;

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
        // Requests are limited to the hosts in capabilities/default.json.
        .plugin(tauri_plugin_http::init())
        // Opens links with target="_blank" in the default browser.
        .plugin(tauri_plugin_opener::init())
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
}
