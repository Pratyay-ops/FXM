//! What the web app tells the desktop shell about playback (stage 7.3), and the text the tray
//! shows for it.
//!
//! The web app's player sends [`NowPlaying`] with the `set_now_playing` command whenever it
//! changes. The tray menu's labels follow it ([`crate::tray`]), and so does the close button,
//! which keeps FXM running in the tray while music plays ([`crate::window`]).

use std::sync::{
    Mutex, PoisonError,
    atomic::{AtomicBool, Ordering},
};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::tray::Tray;

/// The most characters the tray menu shows of the current track.
pub const MENU_TEXT_MAX_CHARS: usize = 60;

/// The most UTF-16 code units of a tooltip: Windows keeps 127 plus a terminating NUL, and
/// tray-icon cuts longer text without one.
pub const TOOLTIP_MAX_UNITS: usize = 120;

/// The most characters of a title or artist the shell keeps.
pub const FIELD_MAX_CHARS: usize = 300;

/// What the tray shows when no track is queued.
pub const NOTHING_PLAYING: &str = "Nothing playing";

/// What the web app's player is doing, as the tray shows it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NowPlaying {
    /// Whether audio plays or is about to: the player is `playing` or `loading`.
    pub playing: bool,
    /// The current track's title, when the queue has one.
    #[serde(default)]
    pub title: Option<String>,
    /// The current track's artists, as one line.
    #[serde(default)]
    pub artist: Option<String>,
}

impl NowPlaying {
    /// The same state with its text made safe to show: no control characters such as line
    /// breaks, no surrounding spaces, at most [`FIELD_MAX_CHARS`] each, and no empty fields. A
    /// queue without a title has no track, so it plays nothing.
    pub fn sanitized(self) -> Self {
        let title = self.title.as_deref().and_then(clean_field);
        let artist = title
            .as_ref()
            .and(self.artist.as_deref())
            .and_then(clean_field);
        Self {
            playing: self.playing && title.is_some(),
            title,
            artist,
        }
    }

    /// Whether the queue has a current track, which the media items of the menu act on.
    pub fn has_track(&self) -> bool {
        self.title.is_some()
    }

    /// The label of the play/pause item: what choosing it does.
    pub fn play_pause_label(&self) -> &'static str {
        if self.playing { "Pause" } else { "Play" }
    }

    /// The current track as one line, `Title – Artist`, at most [`MENU_TEXT_MAX_CHARS`]
    /// characters, or [`NOTHING_PLAYING`].
    pub fn summary(&self) -> String {
        match self.track_line() {
            Some(line) => truncate_chars(&line, MENU_TEXT_MAX_CHARS),
            None => NOTHING_PLAYING.to_owned(),
        }
    }

    /// The tray icon's tooltip: `FXM`, or `FXM: Title – Artist` while a track is queued, at most
    /// [`TOOLTIP_MAX_UNITS`] UTF-16 code units.
    pub fn tooltip(&self) -> String {
        match self.track_line() {
            Some(line) => truncate_utf16(&format!("FXM: {line}"), TOOLTIP_MAX_UNITS),
            None => "FXM".to_owned(),
        }
    }

    /// `Title – Artist`, or the title alone, while a track is queued.
    fn track_line(&self) -> Option<String> {
        let title = self.title.as_deref()?;
        Some(match self.artist.as_deref() {
            Some(artist) => format!("{title} – {artist}"),
            None => title.to_owned(),
        })
    }
}

/// `text` as a menu item shows it: menus read `&` as a mnemonic marker, so each is doubled.
pub fn menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

/// A title or artist without control characters, trimmed and capped; `None` when nothing is
/// left.
fn clean_field(value: &str) -> Option<String> {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| truncate_chars(trimmed, FIELD_MAX_CHARS))
}

/// `text` cut to at most `max` characters, ending in `…` when it was cut.
pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// `text` cut to at most `max` UTF-16 code units, ending in `…` when it was cut.
pub fn truncate_utf16(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.to_owned();
    }
    let mut kept = String::new();
    let mut units = 0;
    for character in text.chars() {
        // Leave room for the ellipsis, which is one code unit.
        if units + character.len_utf16() > max.saturating_sub(1) {
            break;
        }
        units += character.len_utf16();
        kept.push(character);
    }
    format!("{}…", kept.trim_end())
}

/// The latest [`NowPlaying`] from the web app.
#[derive(Debug, Default)]
pub struct Playback {
    playing: AtomicBool,
    now: Mutex<NowPlaying>,
}

impl Playback {
    /// Whether music plays, as the web app last said.
    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Acquire)
    }

    /// What the web app last said.
    pub fn now(&self) -> NowPlaying {
        self.now
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Records `now`, sanitized, and returns it.
    pub fn set(&self, now: NowPlaying) -> NowPlaying {
        let now = now.sanitized();
        self.playing.store(now.playing, Ordering::Release);
        *self.now.lock().unwrap_or_else(PoisonError::into_inner) = now.clone();
        now
    }
}

/// Tells the shell what the web app's player is doing: the tray menu shows it, and while music
/// plays the close button hides the window instead of quitting.
#[tauri::command]
pub fn set_now_playing<R: Runtime>(
    app: AppHandle<R>,
    playback: State<'_, Playback>,
    now: NowPlaying,
) {
    let now = playback.set(now);
    if let Some(tray) = app.try_state::<Tray<R>>() {
        // Best effort: a menu that can't be updated is not worth failing the player over.
        let _ = tray.show(&now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now(playing: bool, title: Option<&str>, artist: Option<&str>) -> NowPlaying {
        NowPlaying {
            playing,
            title: title.map(str::to_owned),
            artist: artist.map(str::to_owned),
        }
    }

    #[test]
    fn reads_the_web_apps_camel_case_state_and_refuses_unknown_fields() {
        let parsed: NowPlaying =
            serde_json::from_str(r#"{"playing":true,"title":"Creep","artist":"Radiohead"}"#)
                .expect("valid state");
        assert_eq!(parsed, now(true, Some("Creep"), Some("Radiohead")));
        let empty: NowPlaying = serde_json::from_str(r#"{"playing":false}"#).expect("valid state");
        assert_eq!(empty, NowPlaying::default());
        assert!(serde_json::from_str::<NowPlaying>(r#"{"playing":true,"url":"x"}"#).is_err());
    }

    #[test]
    fn sanitizing_drops_control_characters_spaces_and_empty_fields() {
        let clean = now(true, Some("  Line\none\t"), Some("\u{7}")).sanitized();
        assert_eq!(clean, now(true, Some("Line one"), None));
        let long = "a".repeat(FIELD_MAX_CHARS + 50);
        let capped = now(false, Some(&long), None).sanitized();
        assert_eq!(
            capped.title.map(|title| title.chars().count()),
            Some(FIELD_MAX_CHARS)
        );
    }

    #[test]
    fn a_queue_without_a_title_plays_nothing_and_has_no_artist() {
        assert_eq!(
            now(true, Some("   "), Some("Radiohead")).sanitized(),
            NowPlaying::default()
        );
        assert!(!NowPlaying::default().has_track());
        assert!(now(false, Some("Creep"), None).sanitized().has_track());
    }

    #[test]
    fn the_play_pause_item_says_what_it_does() {
        assert_eq!(now(true, Some("Creep"), None).play_pause_label(), "Pause");
        assert_eq!(now(false, Some("Creep"), None).play_pause_label(), "Play");
    }

    #[test]
    fn the_summary_names_the_track_or_says_nothing_plays() {
        assert_eq!(
            now(true, Some("Creep"), Some("Radiohead")).summary(),
            "Creep – Radiohead"
        );
        assert_eq!(now(true, Some("Creep"), None).summary(), "Creep");
        assert_eq!(NowPlaying::default().summary(), NOTHING_PLAYING);
        let long = now(true, Some(&"a".repeat(100)), None).summary();
        assert_eq!(long.chars().count(), MENU_TEXT_MAX_CHARS);
        assert!(long.ends_with("a…"), "{long}");
        // A cut right after a space drops the space before the ellipsis.
        let title = format!("{} {}", "x".repeat(MENU_TEXT_MAX_CHARS - 2), "y".repeat(20));
        let words = now(true, Some(&title), Some("Artist")).summary();
        assert_eq!(words, format!("{}…", "x".repeat(MENU_TEXT_MAX_CHARS - 2)));
    }

    #[test]
    fn the_tooltip_fits_windows_and_names_the_track() {
        assert_eq!(NowPlaying::default().tooltip(), "FXM");
        assert_eq!(
            now(false, Some("Creep"), Some("Radiohead")).tooltip(),
            "FXM: Creep – Radiohead"
        );
        // Characters outside the Basic Multilingual Plane take two UTF-16 code units each.
        let tooltip = now(true, Some(&"🎵".repeat(100)), None).tooltip();
        assert!(tooltip.encode_utf16().count() <= TOOLTIP_MAX_UNITS);
        assert!(tooltip.ends_with('…'));
    }

    #[test]
    fn menu_text_keeps_ampersands_from_becoming_mnemonics() {
        assert_eq!(menu_text("Simon & Garfunkel"), "Simon && Garfunkel");
        assert_eq!(menu_text("no ampersand"), "no ampersand");
    }

    #[test]
    fn truncation_respects_character_boundaries() {
        assert_eq!(truncate_chars("héllo", 10), "héllo");
        assert_eq!(truncate_chars("héllo wörld", 6), "héllo…");
        assert_eq!(truncate_utf16("ab🎵cd", 4), "ab…");
        assert_eq!(truncate_utf16("ab🎵cd", 6), "ab🎵cd");
    }

    #[test]
    fn playback_remembers_the_sanitized_state() {
        let playback = Playback::default();
        assert!(!playback.is_playing());
        let stored = playback.set(now(true, Some(" Creep "), Some("Radiohead")));
        assert_eq!(stored, now(true, Some("Creep"), Some("Radiohead")));
        assert!(playback.is_playing());
        assert_eq!(playback.now(), stored);
        playback.set(now(true, None, None));
        assert!(!playback.is_playing(), "nothing queued, nothing plays");
    }
}
