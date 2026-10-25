fn main() {
    // The app's own evaluator plugin (src/evaluator.rs): its commands need a permission, which
    // capabilities/default.json grants to the main window only.
    let evaluator = tauri_build::InlinedPlugin::new()
        .commands(&["open", "eval", "close"])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(tauri_build::Attributes::new().plugin("fxm-evaluator", evaluator))
        .expect("failed to run the Tauri build script");
}
