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
//!
//! Playback and OS integration (stage 7.3): the [`tray`] icon controls playback while the window
//! is hidden, the close button keeps music playing in the background ([`window`]), the
//! [`network`] watcher tells the web app when stream URLs need resolving again, and
//! [`environment`] tells it which macOS it runs on.
//!
//! Updates (stage 7.5): release builds look for a newer version on GitHub Releases and offer it
//! ([`updater`]), through tauri-plugin-updater, which only Rust uses. They also carry the
//! third-party notices among their resources, which Settings → About shows ([`notices`]).
//!
//! The readable audio path (stage 7.6): the [`media`] scheme, `fxm-media:`, serves googlevideo
//! streams to the main window's `<audio>` elements through Rust, with CORS headers for the app,
//! so Web Audio can read YouTube audio for the equalizer.

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

pub mod environment;
mod evaluator;
#[cfg(target_os = "macos")]
mod fullscreen;
pub mod media;
pub mod network;
pub mod notices;
pub mod playback;
// The live smoke test's report listener: always compiled, so lints and tests cover it, but only
// started in the smoke build (`--features smoke`, apps/desktop/smoke).
#[cfg_attr(not(feature = "smoke"), allow(dead_code))]
mod smoke;
pub mod tray;
pub mod updater;
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
        // Opens links with target="_blank" in the default browser.
        .plugin(tauri_plugin_opener::init())
        // The isolated evaluator in a hidden webview of its own (stage 1.11, src/evaluator.rs).
        .plugin(evaluator::init())
        // Updates (src/updater.rs). Only Rust calls it: the web app's capability grants none of
        // its commands.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // googlevideo streams for the main window's <audio>, readable by Web Audio (src/media.rs).
        .register_asynchronous_uri_scheme_protocol(
            media::SCHEME,
            media::handler(media::MediaProxy::new(media::MediaPolicy::default())),
        );
    // macOS: Tauri's default app menu, with Window > FXM (⌘0) to bring a hidden window back.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(window::app_menu)
        .on_menu_event(|app, event| window::on_menu_event(app, event.id().as_ref()));
    // macOS: the smoke build runs unattended, often while someone works at the Mac, so it never
    // takes the focus from the app in front, and (in setup) shows no Dock icon or menu bar.
    #[cfg(all(target_os = "macos", feature = "smoke"))]
    let builder = builder.activate_ignoring_other_apps(false);
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
            // Release builds with FXM's updater key only; never the smoke build, which runs
            // unattended.
            #[cfg(not(feature = "smoke"))]
            updater::start(app.handle());
            // The live smoke test's build only (apps/desktop/smoke).
            #[cfg(feature = "smoke")]
            smoke::listen(app.handle());
            #[cfg(all(target_os = "macos", feature = "smoke"))]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
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
            notices::third_party_notices,
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

    #[test]
    fn the_app_has_the_version_of_its_package() {
        // tauri.conf.json reads it from ../package.json, which `make release-pr` sets with every
        // other package's: the updater compares it with the latest release's.
        let context = context();
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).expect("package.json");
        assert_eq!(
            context.package_info().version.to_string(),
            package["version"]
                .as_str()
                .expect("package.json has a version")
        );
    }

    #[test]
    fn updates_come_from_the_latest_release_and_must_name_their_version() {
        let context = context();
        let updater = &context.config().plugins.0["updater"];
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([
                "https://github.com/Pratyay-ops/FXM/releases/latest/download/latest.json"
            ])
        );
        // A signature must name the version latest.json announces, so an older release can't
        // pass for a newer one.
        assert_eq!(updater["requireSignedVersion"], true);
        for setting in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
            "allowDowngrades",
        ] {
            assert!(updater.get(setting).is_none(), "{setting} must stay off");
        }
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
