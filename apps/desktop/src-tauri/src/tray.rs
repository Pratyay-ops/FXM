//! The tray icon (stage 7.3): the macOS menu bar, the Windows notification area, the Linux
//! status area. Its menu controls playback while FXM's window is hidden, brings the window back
//! and quits FXM.
//!
//! Rust builds it, so it is there before the page has loaded and keeps working if the page
//! hangs. The web app's capability leaves out `core:tray` and `core:menu`, so page script can
//! neither change it nor add tray icons or menus of its own.
//!
//! - Play/Pause, Next and Previous go to the web app's player as a [`MEDIA_ACTION_EVENT`]
//!   event, and what the menu shows comes back through the `set_now_playing` command
//!   ([`crate::playback`]): the track, and whether it plays, is paused or stopped on an error.
//!   After an error the first line shows the window, which says what went wrong.
//! - A click on the icon shows the window on Windows; on macOS it opens the menu, as menu bar
//!   items do, and Linux status areas always open the menu.

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

use crate::{
    MAIN_WINDOW,
    playback::{NowPlaying, menu_text},
    window::show_main_window,
};

/// The id of FXM's tray icon.
pub const TRAY_ID: &str = "fxm";

/// The event the web app's player receives for a media action from the tray, with a
/// [`MediaAction`] as its payload.
pub const MEDIA_ACTION_EVENT: &str = "fxm-media-action";

/// The ids of the tray menu's items. Prefixed, so no item of another menu can share one: the
/// menu event handler sees the events of every menu, the macOS app menu's included.
pub mod item {
    /// The current track and what the player does with it, or that nothing plays. Disabled, so
    /// it only informs, unless playback stopped on an error: then it shows the window.
    pub const NOW_PLAYING: &str = "fxm-tray-now-playing";
    /// Play or pause.
    pub const PLAY_PAUSE: &str = "fxm-tray-play-pause";
    /// The next track.
    pub const NEXT: &str = "fxm-tray-next";
    /// The previous track, or the start of this one.
    pub const PREVIOUS: &str = "fxm-tray-previous";
    /// Shows and focuses the window.
    pub const SHOW: &str = "fxm-tray-show";
    /// Quits FXM.
    pub const QUIT: &str = "fxm-tray-quit";
}

/// What the tray asks the web app's player to do. Serialized in lower case: `"toggle"`,
/// `"next"`, `"previous"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaAction {
    /// Play or pause.
    Toggle,
    /// Skip to the next track.
    Next,
    /// Go back: the player restarts the track when it is more than 3 s in.
    Previous,
}

impl MediaAction {
    /// The action of a tray menu item, if it has one.
    pub fn from_item(id: &str) -> Option<Self> {
        match id {
            item::PLAY_PAUSE => Some(Self::Toggle),
            item::NEXT => Some(Self::Next),
            item::PREVIOUS => Some(Self::Previous),
            _ => None,
        }
    }
}

/// The tray icon and the menu items that follow playback, kept in the app's state while the
/// tray exists.
pub struct Tray<R: Runtime> {
    icon: TrayIcon<R>,
    now_playing: MenuItem<R>,
    play_pause: MenuItem<R>,
    next: MenuItem<R>,
    previous: MenuItem<R>,
}

impl<R: Runtime> Tray<R> {
    /// Shows `now` in the menu and the tooltip. The media items are disabled while nothing is
    /// queued, and the first line is enabled only when playback stopped on an error.
    pub fn show(&self, now: &NowPlaying) -> tauri::Result<()> {
        self.now_playing.set_text(menu_text(&now.summary()))?;
        self.now_playing.set_enabled(now.needs_attention())?;
        self.play_pause.set_text(now.play_pause_label())?;
        for media in [&self.play_pause, &self.next, &self.previous] {
            media.set_enabled(now.has_track())?;
        }
        self.icon.set_tooltip(Some(now.tooltip()))
    }
}

/// Builds the tray icon and its menu and keeps them in the app's state. Fails where the system
/// has no tray, such as Linux without an AppIndicator library: FXM then runs without one, and
/// its close button quits it (see [`crate::window::close_action`]).
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if !tray_supported() {
        return Err(tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no AppIndicator library (libayatana-appindicator3 or libappindicator3) is installed",
        )));
    }
    let now = NowPlaying::default();
    let text = |id: &str, text: &str, enabled: bool| {
        MenuItem::with_id(app, id, text, enabled, None::<&str>)
    };
    let now_playing = text(item::NOW_PLAYING, &menu_text(&now.summary()), false)?;
    let play_pause = text(item::PLAY_PAUSE, now.play_pause_label(), false)?;
    let next = text(item::NEXT, "Next", false)?;
    let previous = text(item::PREVIOUS, "Previous", false)?;
    let show = text(item::SHOW, "Show FXM", true)?;
    let quit = text(item::QUIT, "Quit FXM", true)?;
    let menu = Menu::with_items(
        app,
        &[
            &now_playing,
            &PredefinedMenuItem::separator(app)?,
            &play_pause,
            &next,
            &previous,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &quit,
        ],
    )?;
    let icon = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon())
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(now.tooltip())
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| on_icon_event(tray.app_handle(), &event))
        .build(app)?;
    app.manage(Tray {
        icon,
        now_playing,
        play_pause,
        next,
        previous,
    });
    Ok(())
}

/// The icon on macOS: a template image, the FXM bars, which macOS draws in the menu bar's own
/// colour.
#[cfg(target_os = "macos")]
fn icon() -> Image<'static> {
    tauri::include_image!("tray/36x36.png")
}

/// The icon on Windows and Linux: the FXM tile edge to edge with three bold bars, drawn on a
/// 16 px grid (assets/tray-color.svg), so it stays sharp at the notification area's 16 px. The
/// app icon, drawn on the macOS icon grid with margins, shrinks to a blur there.
#[cfg(not(target_os = "macos"))]
fn icon() -> Image<'static> {
    tauri::include_image!("tray/color/32x32.png")
}

/// Whether the desktop shows FXM's tray icon: the icon was built, and on Linux a status notifier
/// host, the panel that draws such icons, is running. The close button hides the window to the
/// tray only then ([`crate::window::close_action`]).
pub fn is_shown<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Tray<R>>().is_some() && host_shows_icons()
}

/// The AppIndicator libraries tray-icon may load, in the order libappindicator-sys 0.9 tries
/// them with its default `backcompat` feature: the versioned names, then the unversioned ones
/// that some AppImages bundle alone.
#[cfg(target_os = "linux")]
const APPINDICATOR_LIBRARIES: [&str; 4] = [
    "libayatana-appindicator3.so.1",
    "libappindicator3.so.1",
    "libayatana-appindicator3.so",
    "libappindicator3.so",
];

/// Whether the system can show a tray icon. On Linux tray-icon loads an AppIndicator library
/// when the icon is built, and panics when there is none.
#[cfg(target_os = "linux")]
fn tray_supported() -> bool {
    APPINDICATOR_LIBRARIES
        .into_iter()
        // SAFETY: the libraries are the ones tray-icon itself loads, and they are unloaded again
        // at once; loading them runs only their own initialisers.
        .any(|library| unsafe { libloading::Library::new(library) }.is_ok())
}

#[cfg(not(target_os = "linux"))]
fn tray_supported() -> bool {
    true
}

/// Linux: whether a status notifier host is registered with the session's
/// `org.kde.StatusNotifierWatcher`, which AppIndicator icons go through. GNOME has none without
/// its AppIndicator extension, and there the library is often installed while no icon shows.
/// Asked at each close, since a panel can start or stop at any time; without an answer (no
/// watcher, no session bus) the icon counts as not shown, and closing quits.
#[cfg(target_os = "linux")]
fn host_shows_icons() -> bool {
    use gio::glib::{ToVariant, VariantTy};
    // How long the session bus may take to answer.
    const TIMEOUT_MS: i32 = 500;
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
        return false;
    };
    let property = (
        "org.kde.StatusNotifierWatcher",
        "IsStatusNotifierHostRegistered",
    );
    bus.call_sync(
        Some("org.kde.StatusNotifierWatcher"),
        "/StatusNotifierWatcher",
        "org.freedesktop.DBus.Properties",
        "Get",
        Some(&property.to_variant()),
        VariantTy::new("(v)").ok(),
        // Never starts a watcher that isn't running: it would have no host either.
        gio::DBusCallFlags::NO_AUTO_START,
        TIMEOUT_MS,
        gio::Cancellable::NONE,
    )
    .ok()
    .and_then(|reply| reply.child_value(0).as_variant())
    .and_then(|registered| registered.get::<bool>())
    .unwrap_or(false)
}

/// Windows always has its notification area, and macOS its menu bar.
#[cfg(not(target_os = "linux"))]
fn host_shows_icons() -> bool {
    true
}

/// Handles a click on one of the tray menu's items. Called for the items of every menu, so
/// anything that isn't the tray's is ignored.
fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        // The first line is enabled, and so clickable, only after an error: the window says why.
        item::SHOW | item::NOW_PLAYING => show_main_window(app),
        item::QUIT => app.exit(0),
        _ => {
            if let Some(action) = MediaAction::from_item(id) {
                // Best effort: the page may still be loading, and then has no player to act.
                let _ = app.emit_to(MAIN_WINDOW, MEDIA_ACTION_EVENT, action);
            }
        }
    }
}

/// Shows the window on a left click on the icon, except on macOS, where a click opens the menu.
fn on_icon_event<R: Runtime>(app: &AppHandle<R>, event: &TrayIconEvent) {
    if cfg!(target_os = "macos") {
        return;
    }
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        show_main_window(app);
    }
}

#[cfg(test)]
mod tests {
    use super::{MediaAction, item};

    #[test]
    fn media_items_map_to_their_actions_and_the_rest_to_none() {
        assert_eq!(
            MediaAction::from_item(item::PLAY_PAUSE),
            Some(MediaAction::Toggle)
        );
        assert_eq!(MediaAction::from_item(item::NEXT), Some(MediaAction::Next));
        assert_eq!(
            MediaAction::from_item(item::PREVIOUS),
            Some(MediaAction::Previous)
        );
        for other in [item::NOW_PLAYING, item::SHOW, item::QUIT, "quit", ""] {
            assert_eq!(MediaAction::from_item(other), None, "{other}");
        }
    }

    #[test]
    fn media_actions_reach_the_web_app_in_lower_case() {
        let json = |action| serde_json::to_string(&action).expect("serializable");
        assert_eq!(json(MediaAction::Toggle), r#""toggle""#);
        assert_eq!(json(MediaAction::Next), r#""next""#);
        assert_eq!(json(MediaAction::Previous), r#""previous""#);
    }

    #[test]
    fn item_ids_are_distinct_and_prefixed() {
        let ids = [
            item::NOW_PLAYING,
            item::PLAY_PAUSE,
            item::NEXT,
            item::PREVIOUS,
            item::SHOW,
            item::QUIT,
        ];
        for (index, id) in ids.iter().enumerate() {
            assert!(id.starts_with("fxm-tray-"), "{id}");
            assert!(!ids[index + 1..].contains(id), "{id} twice");
        }
    }
}
