/// The app's own commands (src/user_hosts.rs, src/playback.rs, src/environment.rs), as
/// `generate_handler!` in src/lib.rs registers them. Listing them gives each an
/// `allow-<command>` permission, and makes Tauri check every app command against the
/// capabilities as it does plugin commands: without an app manifest, any local webview could
/// call them, even one granted no capability.
const COMMANDS: &[&str] = &[
    "user_hosts",
    "approve_user_host",
    "revoke_user_host",
    "user_host_fetch",
    "set_now_playing",
    "desktop_environment",
];

fn main() {
    // `generate_context!` embeds the isolation hook (../isolation) when the crate compiles, so a
    // change to the hook has to recompile it.
    println!("cargo:rerun-if-changed=../isolation");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
