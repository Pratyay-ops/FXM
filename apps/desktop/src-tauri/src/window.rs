//! The main window (stage 7.3): what its close button does, and bringing it back from the tray,
//! the Dock or a second launch.

use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

use crate::{MAIN_WINDOW, playback::Playback, tray::Tray};

/// What the close button of the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide the window: FXM keeps running, and playing, in the background.
    Hide,
    /// Close the window, which quits FXM.
    Close,
}

/// What the close button does on `os` (`std::env::consts::OS`), given whether FXM has a tray
/// icon and whether music plays:
///
/// - **macOS:** hide, as Mac apps do. FXM stays in the Dock and the menu bar; clicking it in the
///   Dock brings the window back, and Quit (⌘Q, or the tray menu) quits.
/// - **Windows and Linux:** hide while music plays and the tray icon is there to bring the window
///   back, so closing the window never stops the music; otherwise close, which quits FXM. On a
///   Linux desktop that shows no tray icons even though the library is installed (GNOME without
///   an AppIndicator extension), launching FXM again shows the window.
pub fn close_action(os: &str, tray: bool, playing: bool) -> CloseAction {
    match os {
        "macos" => CloseAction::Hide,
        _ if tray && playing => CloseAction::Hide,
        _ => CloseAction::Close,
    }
}

/// Handles the main window's events: a close request hides it when [`close_action`] says so.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != MAIN_WINDOW {
        return;
    }
    let app = window.app_handle();
    let tray = app.try_state::<Tray<R>>().is_some();
    let playing = app
        .try_state::<Playback>()
        .is_some_and(|playback| playback.is_playing());
    if close_action(std::env::consts::OS, tray, playing) == CloseAction::Hide {
        api.prevent_close();
        // Best effort: a window that can't be hidden stays open.
        let _ = window.hide();
    }
}

/// Handles the app's run events. On macOS, clicking FXM in the Dock while its window is hidden
/// brings the window back.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen {
        has_visible_windows: false,
        ..
    } = event
    {
        show_main_window(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Shows the main window, restores it if minimized and focuses it.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // Best effort: a window that can't be raised is not worth crashing over.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::{CloseAction, close_action};

    #[test]
    fn macos_hides_the_window_like_any_mac_app() {
        for (tray, playing) in [(true, true), (true, false), (false, true), (false, false)] {
            assert_eq!(close_action("macos", tray, playing), CloseAction::Hide);
        }
    }

    #[test]
    fn windows_and_linux_hide_to_the_tray_only_while_music_plays() {
        for os in ["windows", "linux"] {
            assert_eq!(close_action(os, true, true), CloseAction::Hide, "{os}");
            assert_eq!(close_action(os, true, false), CloseAction::Close, "{os}");
        }
    }

    #[test]
    fn without_a_tray_icon_closing_quits_rather_than_hiding_for_good() {
        for os in ["windows", "linux"] {
            assert_eq!(close_action(os, false, true), CloseAction::Close, "{os}");
        }
    }
}
