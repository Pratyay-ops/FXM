//! The main window (stage 7.3): what its close button does, and bringing it back from the tray,
//! the Dock, the macOS Window menu or a second launch.

use std::{
    path::Path,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use rfd::{AsyncMessageDialog, MessageButtons, MessageLevel};
use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

use crate::{MAIN_WINDOW, tray};

/// What the close button of the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide the window: FXM keeps running, and playing, in the Dock and the menu bar (macOS).
    Hide,
    /// Take the window out of full screen, then hide it (macOS). Hiding a window in full screen
    /// would leave its Space behind, empty and black, until the user swipes away.
    ExitFullScreenThenHide,
    /// Hide the window to the tray: FXM keeps running, and playing, in the notification area
    /// (Windows) or the status area (Linux). The first time, a notice says so.
    HideToTray,
    /// Close the window, which quits FXM.
    Close,
}

/// What the close button does on `os` (`std::env::consts::OS`), given whether the desktop shows
/// FXM's tray icon ([`tray::is_shown`]) and whether the window is in full screen:
///
/// - **macOS:** hide, as Mac apps do. FXM stays in the Dock and the menu bar; clicking it in the
///   Dock or choosing Window > FXM (⌘0) brings the window back, and Quit (⌘Q, or the tray menu)
///   quits. In full screen the window leaves full screen first.
/// - **Windows and Linux:** hide to the tray, as tray apps do, whether or not music plays: the
///   tray icon brings the window back, and its menu quits. Where the desktop shows no tray
///   icon, close, which quits FXM: nothing would bring a hidden window back but launching FXM
///   again.
pub fn close_action(os: &str, tray: bool, fullscreen: bool) -> CloseAction {
    match os {
        "macos" if fullscreen => CloseAction::ExitFullScreenThenHide,
        "macos" => CloseAction::Hide,
        _ if tray => CloseAction::HideToTray,
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
    // The window is leaving full screen to be hidden: that hide is on its way.
    if app
        .try_state::<PendingHide>()
        .is_some_and(|pending| pending.is_pending(Instant::now()))
    {
        api.prevent_close();
        return;
    }
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    match close_action(std::env::consts::OS, tray::is_shown(app), fullscreen) {
        CloseAction::Hide => {
            api.prevent_close();
            // Best effort: a window that can't be hidden stays open.
            let _ = window.hide();
        }
        CloseAction::ExitFullScreenThenHide => {
            api.prevent_close();
            exit_full_screen_then_hide(window);
        }
        CloseAction::HideToTray => {
            api.prevent_close();
            let _ = window.hide();
            tell_about_the_tray_once(app);
        }
        CloseAction::Close => {}
    }
}

#[cfg(target_os = "macos")]
fn exit_full_screen_then_hide<R: Runtime>(window: &Window<R>) {
    crate::fullscreen::exit_then_hide(window);
}

/// Only macOS gets [`CloseAction::ExitFullScreenThenHide`].
#[cfg(not(target_os = "macos"))]
fn exit_full_screen_then_hide<R: Runtime>(window: &Window<R>) {
    let _ = window.hide();
}

/// How long the window may take to leave full screen before the hide waiting for it lapses.
pub const PENDING_HIDE_TIMEOUT: Duration = Duration::from_secs(5);

/// A hide that waits for the main window to leave full screen (macOS), kept in the app's state.
/// It lapses after [`PENDING_HIDE_TIMEOUT`], so a full-screen exit that never ends can neither
/// hide the window much later nor keep the close button from working.
#[derive(Debug, Default)]
pub struct PendingHide(Mutex<Option<Instant>>);

impl PendingHide {
    fn since(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts waiting, at `now`.
    pub fn start(&self, now: Instant) {
        *self.since() = Some(now);
    }

    /// Whether a hide is waiting at `now`.
    pub fn is_pending(&self, now: Instant) -> bool {
        self.since()
            .is_some_and(|since| now.duration_since(since) < PENDING_HIDE_TIMEOUT)
    }

    /// Ends the wait: `true` if a hide was waiting at `now`, which the caller then carries out.
    pub fn take(&self, now: Instant) -> bool {
        self.since()
            .take()
            .is_some_and(|since| now.duration_since(since) < PENDING_HIDE_TIMEOUT)
    }

    /// Drops the waiting hide: the user asked for the window.
    pub fn cancel(&self) {
        *self.since() = None;
    }
}

/// The file in the app's config folder whose presence says the tray notice was shown.
pub const TRAY_NOTICE_FILE: &str = "tray-notice-shown";

/// What the notice says on `os` the first time closing the window hides FXM to the tray.
pub fn tray_notice(os: &str) -> &'static str {
    match os {
        "windows" => {
            "Closing the window keeps FXM running in the notification area at the end of the \
             taskbar, so music can play on. Click FXM's icon there to bring the window back, or \
             right-click it and choose Quit FXM.\n\nIf you don't see the icon, click the arrow \
             (^) next to the clock."
        }
        _ => {
            "Closing the window keeps FXM running in your panel's status area, so music can play \
             on. Open the menu of FXM's icon there to bring the window back, or choose Quit FXM."
        }
    }
}

/// Whether `marker` didn't exist yet. Creates it, and its folder, so that the next run knows;
/// when that fails, it still says `true`, and the caller's once-per-run guard holds.
pub fn first_time(marker: &Path) -> bool {
    if marker.exists() {
        return false;
    }
    if let Some(folder) = marker.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker);
    true
}

/// Tells the user, the first time closing the window hides FXM to the tray, that it keeps
/// running there and how to bring it back or quit it: a new app's notification-area icon often
/// lands in the overflow on Windows, so the music would play on with nothing in sight.
/// Remembered in [`TRAY_NOTICE_FILE`]; shown at most once per run when that can't be written.
///
/// The notice comes from rfd directly, built on the main thread as tauri-plugin-dialog builds it:
/// the app leaves that plugin out (see Cargo.toml). Nothing waits for the answer.
fn tell_about_the_tray_once<R: Runtime>(app: &AppHandle<R>) {
    static TOLD: AtomicBool = AtomicBool::new(false);
    if TOLD.swap(true, Ordering::AcqRel) {
        return;
    }
    let Ok(folder) = app.path().app_config_dir() else {
        return;
    };
    if !first_time(&folder.join(TRAY_NOTICE_FILE)) {
        return;
    }
    let text = tray_notice(std::env::consts::OS);
    // Best effort: the window is already hidden, and FXM keeps running without the notice.
    let _ = app.run_on_main_thread(move || {
        let answer = AsyncMessageDialog::new()
            .set_level(MessageLevel::Info)
            .set_title("FXM is still running")
            .set_description(text)
            .set_buttons(MessageButtons::Ok)
            .show();
        tauri::async_runtime::spawn(answer);
    });
}

/// The id of Window > FXM in the macOS app menu.
pub const SHOW_MENU_ITEM: &str = "fxm-window-show";

/// macOS: Tauri's default app menu with Window > FXM (⌘0), which brings the main window back,
/// as Window > Calendar does in Calendar. The default menu has nothing for a hidden window, so
/// without it the keyboard could reach the window only through the Dock. Rust builds the menu,
/// so the web app's capability still leaves out `core:menu`.
#[cfg(target_os = "macos")]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, WINDOW_SUBMENU_ID};
    let menu = Menu::default(app)?;
    if let Some(window_menu) = menu
        .get(WINDOW_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned())
    {
        window_menu.append_items(&[
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SHOW_MENU_ITEM, "FXM", true, Some("CmdOrCtrl+0"))?,
        ])?;
    }
    Ok(menu)
}

/// Handles a click on an item of the app menu. Called for the items of every menu, so anything
/// else is ignored.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == SHOW_MENU_ITEM {
        show_main_window(app);
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

/// Shows the main window, restores it if minimized and focuses it. A hide still waiting for the
/// window to leave full screen is dropped: the user asked for the window.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(pending) = app.try_state::<PendingHide>() {
        pending.cancel();
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // Best effort: a window that can't be raised is not worth crashing over.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        CloseAction, PENDING_HIDE_TIMEOUT, PendingHide, TRAY_NOTICE_FILE, close_action, first_time,
        tray_notice,
    };

    #[test]
    fn macos_hides_the_window_like_any_mac_app() {
        for tray in [true, false] {
            assert_eq!(close_action("macos", tray, false), CloseAction::Hide);
        }
    }

    #[test]
    fn macos_leaves_full_screen_before_it_hides_the_window() {
        for tray in [true, false] {
            assert_eq!(
                close_action("macos", tray, true),
                CloseAction::ExitFullScreenThenHide
            );
        }
    }

    #[test]
    fn windows_and_linux_hide_to_the_tray_where_the_desktop_shows_it() {
        for os in ["windows", "linux"] {
            for fullscreen in [false, true] {
                assert_eq!(
                    close_action(os, true, fullscreen),
                    CloseAction::HideToTray,
                    "{os}"
                );
            }
        }
    }

    #[test]
    fn without_a_tray_icon_closing_quits_rather_than_hiding_for_good() {
        for os in ["windows", "linux"] {
            for fullscreen in [false, true] {
                assert_eq!(close_action(os, false, fullscreen), CloseAction::Close);
            }
        }
    }

    #[test]
    fn a_pending_hide_is_carried_out_once() {
        let pending = PendingHide::default();
        let start = Instant::now();
        assert!(!pending.is_pending(start));
        assert!(!pending.take(start));
        pending.start(start);
        let later = start + Duration::from_millis(700);
        assert!(pending.is_pending(later));
        assert!(pending.take(later));
        assert!(!pending.is_pending(later));
        assert!(!pending.take(later));
    }

    #[test]
    fn a_pending_hide_lapses_and_can_be_dropped() {
        let pending = PendingHide::default();
        let start = Instant::now();
        pending.start(start);
        let late = start + PENDING_HIDE_TIMEOUT;
        assert!(!pending.is_pending(late), "a close works again");
        assert!(
            !pending.take(late),
            "and a late exit doesn't hide the window"
        );
        pending.start(start);
        pending.cancel();
        assert!(!pending.take(start + Duration::from_millis(1)));
    }

    #[test]
    fn the_tray_notice_says_where_fxm_went_and_how_to_quit() {
        let windows = tray_notice("windows");
        assert!(windows.contains("notification area") && windows.contains("Quit FXM"));
        assert!(windows.contains("arrow"), "the overflow flyout");
        let linux = tray_notice("linux");
        assert!(linux.contains("status area") && linux.contains("Quit FXM"));
    }

    #[test]
    fn the_tray_notice_is_shown_the_first_time_only() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        let folder =
            std::env::temp_dir().join(format!("fxm-tray-notice-{}-{nanos}", std::process::id()));
        let marker = folder.join("config").join(TRAY_NOTICE_FILE);
        assert!(first_time(&marker));
        assert!(marker.exists());
        assert!(!first_time(&marker));
        let _ = std::fs::remove_dir_all(&folder);
    }
}
