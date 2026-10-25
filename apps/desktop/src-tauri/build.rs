/// The app's own commands (src/user_hosts.rs), as `generate_handler!` in src/lib.rs registers
/// them. Listing them gives each an `allow-<command>` permission, and makes Tauri check every app
/// command against the capabilities as it does plugin commands: without an app manifest, any
/// local webview could call them, even one granted no capability.
const COMMANDS: &[&str] = &[
    "user_hosts",
    "approve_user_host",
    "revoke_user_host",
    "user_host_fetch",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
