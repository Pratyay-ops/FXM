//! What the web app tells the desktop shell about playback (stage 7.3), and the text the tray
//! shows for it.
//!
//! The web app's player sends [`NowPlaying`] with the `set_now_playing` command whenever it
//! changes. The tray's menu and tooltip follow it ([`crate::tray`]), and so does the close
//! button, which keeps FXM running in the tray while music plays ([`crate::window`]).

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

/// What the tray's menu shows when playback stopped on an error: choosing it shows the window,
/// which says why.
pub const CANT_PLAY: &str = "Can't play: open FXM to see why";

/// What the web app's player is doing. Read in lower case: `"playing"`, `"paused"`, `"error"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayState {
    /// Audio plays, or the next track loads.
    Playing,
    /// Paused, stopped, ended or not started.
    #[default]
    Paused,
    /// Playback stopped on a failure the user must look at in FXM's window, such as a bot check
    /// or too many tracks that failed in a row.
    Error,
}

/// What the web app's player is doing, as the tray shows it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NowPlaying {
    /// What the player is doing.
    pub state: PlayState,
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
    /// queue without a title has no track, so it is [`PlayState::Paused`] with nothing in it.
    pub fn sanitized(self) -> Self {
        let Some(title) = self.title.as_deref().and_then(clean_field) else {
            return Self::default();
        };
        Self {
            state: self.state,
            artist: self.artist.as_deref().and_then(clean_field),
            title: Some(title),
        }
    }

    /// Whether the queue has a current track, which the media items of the menu act on.
    pub fn has_track(&self) -> bool {
        self.title.is_some()
    }

    /// Whether music plays: the player plays or loads a track.
    pub fn is_playing(&self) -> bool {
        self.state == PlayState::Playing && self.has_track()
    }

    /// Whether playback stopped on an error that FXM's window explains: the menu's first line
    /// then shows the window.
    pub fn needs_attention(&self) -> bool {
        self.state == PlayState::Error && self.has_track()
    }

    /// The label of the play/pause item: what choosing it does.
    pub fn play_pause_label(&self) -> &'static str {
        if self.is_playing() { "Pause" } else { "Play" }
    }

    /// The menu's first line, at most [`MENU_TEXT_MAX_CHARS`] characters: `Title – Artist`
    /// while it plays, `Paused · Title – Artist`, [`CANT_PLAY`] after an error, or
    /// [`NOTHING_PLAYING`].
    pub fn summary(&self) -> String {
        let Some(line) = self.track_line() else {
            return NOTHING_PLAYING.to_owned();
        };
        let summary = match self.state {
            PlayState::Playing => line,
            PlayState::Paused => format!("Paused · {line}"),
            PlayState::Error => CANT_PLAY.to_owned(),
        };
        truncate_chars(&summary, MENU_TEXT_MAX_CHARS)
    }

    /// The tray icon's tooltip, at most [`TOOLTIP_MAX_UNITS`] UTF-16 code units: `FXM`, or
    /// `FXM: Title – Artist`, `FXM: Paused · Title – Artist` or `FXM: Can't play Title – Artist`
    /// while a track is queued.
    pub fn tooltip(&self) -> String {
        let Some(line) = self.track_line() else {
            return "FXM".to_owned();
        };
        let tooltip = match self.state {
            PlayState::Playing => format!("FXM: {line}"),
            PlayState::Paused => format!("FXM: Paused · {line}"),
            PlayState::Error => format!("FXM: Can't play {line}"),
        };
        truncate_utf16(&tooltip, TOOLTIP_MAX_UNITS)
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
        self.playing.store(now.is_playing(), Ordering::Release);
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

    const PLAYING: PlayState = PlayState::Playing;
    const PAUSED: PlayState = PlayState::Paused;
    const ERROR: PlayState = PlayState::Error;

    fn now(state: PlayState, title: Option<&str>, artist: Option<&str>) -> NowPlaying {
        NowPlaying {
            state,
            title: title.map(str::to_owned),
            artist: artist.map(str::to_owned),
        }
    }

    #[test]
    fn reads_the_web_apps_camel_case_state_and_refuses_unknown_fields() {
        let parsed: NowPlaying =
            serde_json::from_str(r#"{"state":"playing","title":"Creep","artist":"Radiohead"}"#)
                .expect("valid state");
        assert_eq!(parsed, now(PLAYING, Some("Creep"), Some("Radiohead")));
        let empty: NowPlaying = serde_json::from_str(r#"{"state":"paused"}"#).expect("valid");
        assert_eq!(empty, NowPlaying::default());
        let error: NowPlaying =
            serde_json::from_str(r#"{"state":"error","title":"Creep"}"#).expect("valid state");
        assert_eq!(error, now(ERROR, Some("Creep"), None));
        for refused in [
            r#"{"state":"playing","url":"x"}"#,
            r#"{"state":"stopped"}"#,
            r#"{"playing":true}"#,
            r#"{"title":"Creep"}"#,
        ] {
            assert!(
                serde_json::from_str::<NowPlaying>(refused).is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn sanitizing_drops_control_characters_spaces_and_empty_fields() {
        let clean = now(PLAYING, Some("  Line\none\t"), Some("\u{7}")).sanitized();
        assert_eq!(clean, now(PLAYING, Some("Line one"), None));
        let long = "a".repeat(FIELD_MAX_CHARS + 50);
        let capped = now(PAUSED, Some(&long), None).sanitized();
        assert_eq!(
            capped.title.map(|title| title.chars().count()),
            Some(FIELD_MAX_CHARS)
        );
    }

    #[test]
    fn a_queue_without_a_title_plays_nothing_and_has_no_artist() {
        for state in [PLAYING, PAUSED, ERROR] {
            let empty = now(state, Some("   "), Some("Radiohead")).sanitized();
            assert_eq!(empty, NowPlaying::default());
            assert!(!empty.is_playing() && !empty.needs_attention());
        }
        assert!(!NowPlaying::default().has_track());
        assert!(now(PAUSED, Some("Creep"), None).sanitized().has_track());
    }

    #[test]
    fn the_play_pause_item_says_what_it_does() {
        assert_eq!(
            now(PLAYING, Some("Creep"), None).play_pause_label(),
            "Pause"
        );
        assert_eq!(now(PAUSED, Some("Creep"), None).play_pause_label(), "Play");
        assert_eq!(now(ERROR, Some("Creep"), None).play_pause_label(), "Play");
    }

    #[test]
    fn only_an_error_asks_for_attention() {
        assert!(now(ERROR, Some("Creep"), None).needs_attention());
        assert!(!now(PLAYING, Some("Creep"), None).needs_attention());
        assert!(!now(PAUSED, Some("Creep"), None).needs_attention());
    }

    #[test]
    fn the_summary_says_what_the_player_does_with_which_track() {
        let creep = |state| now(state, Some("Creep"), Some("Radiohead")).summary();
        assert_eq!(creep(PLAYING), "Creep – Radiohead");
        assert_eq!(creep(PAUSED), "Paused · Creep – Radiohead");
        assert_eq!(creep(ERROR), CANT_PLAY);
        assert_eq!(now(PLAYING, Some("Creep"), None).summary(), "Creep");
        assert_eq!(NowPlaying::default().summary(), NOTHING_PLAYING);
        assert!(CANT_PLAY.chars().count() <= MENU_TEXT_MAX_CHARS);
        let long = now(PLAYING, Some(&"a".repeat(100)), None).summary();
        assert_eq!(long.chars().count(), MENU_TEXT_MAX_CHARS);
        assert!(long.ends_with("a…"), "{long}");
        let paused = now(PAUSED, Some(&"a".repeat(100)), None).summary();
        assert_eq!(paused.chars().count(), MENU_TEXT_MAX_CHARS);
        assert!(paused.starts_with("Paused · a"), "{paused}");
        // A cut right after a space drops the space before the ellipsis.
        let title = format!("{} {}", "x".repeat(MENU_TEXT_MAX_CHARS - 2), "y".repeat(20));
        let words = now(PLAYING, Some(&title), Some("Artist")).summary();
        assert_eq!(words, format!("{}…", "x".repeat(MENU_TEXT_MAX_CHARS - 2)));
    }

    #[test]
    fn the_tooltip_fits_windows_and_says_what_the_player_does() {
        assert_eq!(NowPlaying::default().tooltip(), "FXM");
        let creep = |state| now(state, Some("Creep"), Some("Radiohead")).tooltip();
        assert_eq!(creep(PLAYING), "FXM: Creep – Radiohead");
        assert_eq!(creep(PAUSED), "FXM: Paused · Creep – Radiohead");
        assert_eq!(creep(ERROR), "FXM: Can't play Creep – Radiohead");
        // Characters outside the Basic Multilingual Plane take two UTF-16 code units each.
        let tooltip = now(PLAYING, Some(&"🎵".repeat(100)), None).tooltip();
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
        let stored = playback.set(now(PLAYING, Some(" Creep "), Some("Radiohead")));
        assert_eq!(stored, now(PLAYING, Some("Creep"), Some("Radiohead")));
        assert!(playback.is_playing());
        assert_eq!(playback.now(), stored);
        playback.set(now(ERROR, Some("Creep"), None));
        assert!(!playback.is_playing(), "stopped on an error");
        playback.set(now(PLAYING, None, None));
        assert!(!playback.is_playing(), "nothing queued, nothing plays");
    }
}
