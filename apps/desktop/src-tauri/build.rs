/// The app's own commands (src/user_hosts.rs, src/playback.rs, src/environment.rs,
/// src/notices.rs), as `generate_handler!` in src/lib.rs registers them. Listing them gives
/// each an `allow-<command>` permission, and makes Tauri check every app command against the
/// capabilities as it does plugin commands: without an app manifest, any local webview could
/// call them, even one granted no capability.
const COMMANDS: &[&str] = &[
    "user_hosts",
    "approve_user_host",
    "revoke_user_host",
    "user_host_fetch",
    "set_now_playing",
    "desktop_environment",
    "third_party_notices",
];

fn main() {
    // `generate_context!` embeds the isolation hook (../isolation) when the crate compiles, so a
    // change to the hook has to recompile it.
    println!("cargo:rerun-if-changed=../isolation");
    // The app's own evaluator plugin (src/evaluator.rs): its commands need a permission, which
    // capabilities/default.json grants to the main window only.
    let evaluator = tauri_build::InlinedPlugin::new()
        .commands(&["open", "eval", "close"])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    // Downloads on disk (src/downloads.rs) and the Spotify login (src/spotify_login.rs), stage
    // 7.4: their commands too need a permission, which capabilities/default.json grants to the
    // main window only.
    let downloads = tauri_build::InlinedPlugin::new()
        .commands(&[
            "open",
            "write",
            "truncate",
            "flush",
            "close",
            "remove",
            "list",
            "size",
            "read",
            "name",
            "folder",
            "choose_folder",
            "save_begin",
            "save_write",
            "save_end",
        ])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    let spotify = tauri_build::InlinedPlugin::new()
        .commands(&["status", "login", "logout", "token"])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))
            .plugin("fxm-evaluator", evaluator)
            .plugin("fxm-downloads", downloads)
            .plugin("fxm-spotify", spotify),
    )
    .expect("failed to run tauri-build");
}
