//! The FXM desktop shell: the web app (apps/web, built with base `/`) in a Tauri webview.
//!
//! tauri-plugin-http is the web app's network (stage 7.2): the web app's `createDesktopFetch`
//! sends every request through it, within the scope in capabilities/default.json, so the app
//! needs no browser extension. Hosts the user adds in Settings go through the commands in
//! [`user_hosts`] instead.
//!
//! Playback and OS integration (stage 7.3): the [`tray`] icon controls playback while the window
//! is hidden, the close button keeps music playing in the background ([`window`]), the
//! [`network`] watcher tells the web app when stream URLs need resolving again, and
//! [`environment`] tells it which macOS it runs on.

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

pub mod environment;
#[cfg(target_os = "macos")]
mod fullscreen;
pub mod network;
pub mod playback;
// The live smoke test's report listener: always compiled, so lints and tests cover it, but only
// started in the smoke build (`--features smoke`, apps/desktop/smoke).
#[cfg_attr(not(feature = "smoke"), allow(dead_code))]
mod smoke;
pub mod tray;
pub mod user_hosts;
pub mod window;

/// Label of the main window in `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";

/// Builds and runs the app until it quits.
pub fn run() {
    let builder = tauri::Builder::default();
    // Registered first: a second launch only brings the running app to the front, including a
    // window hidden in the tray. Left out of the smoke build, whose runs from different checkouts
    // may overlap on one machine: the plugin would hand one run over to the other's app and show
    // that app's hidden window.
    #[cfg(not(feature = "smoke"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        window::show_main_window(app);
    }));
    let builder = builder
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
        // Only Rust opens dialogs: the web app has no dialog permission.
        .plugin(tauri_plugin_dialog::init())
        // Opens links with target="_blank" in the default browser.
        .plugin(tauri_plugin_opener::init());
    // macOS: Tauri's default app menu, with Window > FXM (⌘0) to bring a hidden window back.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(window::app_menu)
        .on_menu_event(|app, event| window::on_menu_event(app, event.id().as_ref()));
    let app = builder
        .setup(|app| {
            let file = app.path().app_config_dir()?.join(user_hosts::FILE_NAME);
            app.manage(user_hosts::UserHosts::load(file));
            app.manage(window::PendingHide::default());
            // The smoke build leaves the tray out: it runs unattended, without touching the
            // menu bar or the notification area.
            #[cfg(not(feature = "smoke"))]
            if let Err(error) = tray::create(app.handle()) {
                // FXM works without a tray icon; its close button then quits it.
                eprintln!("FXM runs without a tray icon: {error}");
            }
            network::watch(app.handle().clone());
            // The live smoke test's build only (apps/desktop/smoke).
            #[cfg(feature = "smoke")]
            smoke::listen(app.handle());
            Ok(())
        })
        .on_window_event(window::on_window_event)
        // Keep in step with COMMANDS in build.rs, which puts each behind a permission.
        .invoke_handler(tauri::generate_handler![
            user_hosts::user_hosts,
            user_hosts::approve_user_host,
            user_hosts::revoke_user_host,
            user_hosts::user_host_fetch,
            playback::set_now_playing,
            environment::desktop_environment,
        ])
        .build(context())
        .expect("error while building the FXM desktop app");
    app.run(|app, event| window::on_run_event(app, &event));
}

/// The app's configuration, icons and, in release builds, the embedded web app. The macro
/// may expand only once per crate (it defines a symbol on macOS), so tests share this.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
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
    fn the_main_window_keeps_running_in_the_background() {
        use tauri::utils::config::BackgroundThrottlingPolicy;
        let context = context();
        let main = context
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == MAIN_WINDOW)
            .expect("tauri.conf.json has no window labelled \"main\"");
        assert!(matches!(
            main.background_throttling,
            Some(BackgroundThrottlingPolicy::Disabled)
        ));
    }
}
