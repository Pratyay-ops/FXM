//! Updates from GitHub Releases (stage 7.5).
//!
//! In a release build that carries FXM's updater key, FXM looks for a newer version
//! [`FIRST_CHECK_DELAY`] after it starts, then every [`CHECK_INTERVAL`] while it runs (it can stay
//! in the tray for days), or [`RETRY_INTERVAL`] after a check that failed, say while offline. It
//! asks the endpoint in `tauri.conf.json` (`plugins > updater > endpoints`): `latest.json` of the
//! latest release on GitHub, which the release workflow writes (`.github/workflows/
//! desktop-release.yml`) with each platform's file and signature.
//!
//! - **Asking.** A newer version is offered in a native dialog, only while FXM's window is in
//!   front ([`in_front`]): never over another app, and never while FXM sits in the tray, where
//!   the offer waits for the window. "Later" is the button Return presses, so an offer that turns
//!   up while the user types in FXM installs nothing; the next check offers it again. "Install
//!   and Restart" downloads it, with the progress in the window's title, installs it and starts
//!   FXM again, which stops the music.
//! - **Trust.** tauri-plugin-updater installs nothing until the download matches its signature
//!   under the public key in `tauri.conf.json` (minisign, Ed25519), and `requireSignedVersion`
//!   also makes the signature name the version that `latest.json` announces, so an older release
//!   can't pass for a newer one. A build whose key is the placeholder, or anything else that isn't
//!   a key, never checks: it could verify nothing ([`is_usable_pubkey`]).
//! - **Installing.** macOS replaces FXM.app (asking for an administrator's password when its
//!   folder needs one); Windows runs the new installer in passive mode, which closes FXM and opens
//!   it again; Linux replaces the AppImage, or installs the new `.deb` through pkexec.
//!
//! Only Rust uses the plugin. The web app's capability grants no `updater:` permission, so no
//! page script, a signed resolver module included, can check, download or install anything.

use std::{
    sync::mpsc,
    thread,
    time::{Duration, SystemTime},
};

use base64::Engine as _;
use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{MAIN_WINDOW, window::in_front};

/// How long after start FXM first looks for an update: the window and the web app come first.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);

/// How often FXM looks for an update while it runs.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// How soon FXM looks again after a check that failed.
pub const RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// How often FXM looks whether its window is in front, while an update waits to be offered.
pub const FRONT_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The longest the thread sleeps at a time before it looks at the clock again. A sleeping
/// thread's time stops while the computer sleeps, but the system clock goes on, so a laptop that
/// sleeps every night still gets its daily check.
pub const WAKE_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Where every release, and what changed in it, is listed.
pub const RELEASES_URL: &str = "https://github.com/Pratyay-ops/FXM/releases";

/// The offer's title.
const DIALOG_TITLE: &str = "Update FXM?";

/// The button that installs the update.
const INSTALL: &str = "Install and Restart";

/// The button that leaves it for now.
const LATER: &str = "Later";

/// Whether this build looks for updates: release builds only, with a usable key. Debug builds
/// (`make desktop-dev`, the smoke test) never do.
pub fn enabled(debug_build: bool, pubkey: Option<&str>) -> bool {
    !debug_build && pubkey.is_some_and(is_usable_pubkey)
}

/// Whether `pubkey`, the `plugins > updater > pubkey` of `tauri.conf.json`, is a minisign public
/// key as the plugin reads it: the key file's text in base64, decoded as it stands, so a key with
/// a space or a line break around it isn't. Nor is the placeholder that ships until the owner
/// commits FXM's key, so such a build never offers an update it couldn't verify.
pub fn is_usable_pubkey(pubkey: &str) -> bool {
    base64::engine::general_purpose::STANDARD
        .decode(pubkey)
        .ok()
        .and_then(|text| String::from_utf8(text).ok())
        .is_some_and(|text| minisign_verify::PublicKey::decode(&text).is_ok())
}

/// The updater's public key in the app's configuration.
fn configured_pubkey<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let updater = app.config().plugins.0.get("updater")?;
    Some(updater.get("pubkey")?.as_str()?.to_owned())
}

/// Starts looking for updates on a thread of its own, if this build does ([`enabled`]).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let pubkey = configured_pubkey(app);
    if !enabled(cfg!(debug_assertions), pubkey.as_deref()) {
        if !cfg!(debug_assertions) {
            eprintln!("FXM doesn't look for updates: this build has no updater key");
        }
        return;
    }
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("fxm-updates".into())
        .spawn(move || run(&app));
    if let Err(error) = spawned {
        eprintln!("FXM doesn't look for updates: {error}");
    }
}

/// Looks for an update, offers it, and waits for the next check, for as long as FXM runs.
fn run<R: Runtime>(app: &AppHandle<R>) {
    thread::sleep(FIRST_CHECK_DELAY);
    loop {
        let due = match tauri::async_runtime::block_on(check(app)) {
            Ok(update) => {
                let due = SystemTime::now() + CHECK_INTERVAL;
                if let Some(update) = update {
                    offer(app, update, due);
                }
                due
            }
            Err(error) => {
                // The endpoint, GitHub, names no user data, and the next check tries again.
                eprintln!("FXM could not look for an update: {error}");
                SystemTime::now() + RETRY_INTERVAL
            }
        };
        while let Some(nap) = next_nap(due, SystemTime::now()) {
            thread::sleep(nap);
        }
    }
}

/// How long to sleep before looking at the clock again, or `None` once `due` has come.
pub fn next_nap(due: SystemTime, now: SystemTime) -> Option<Duration> {
    due.duration_since(now)
        .ok()
        .filter(|left| !left.is_zero())
        .map(|left| left.min(WAKE_INTERVAL))
}

/// The newer version that the endpoint announces, if there is one.
async fn check<R: Runtime>(app: &AppHandle<R>) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater()?.check().await
}

/// Offers `update` once FXM's window is in front, and installs it if the user says so. Gives up
/// at `due`, the next check, which finds the newest version again.
fn offer<R: Runtime>(app: &AppHandle<R>, update: Update, due: SystemTime) {
    let Some(window) = wait_until_in_front(app, due) else {
        return;
    };
    let question = question_text(&update.current_version, &update.version);
    match tauri::async_runtime::block_on(ask(&window, question)) {
        Some(true) => install_and_restart(app, &window, &update),
        Some(false) => {}
        None => eprintln!("FXM could not show its update question"),
    }
}

/// The main window, once it is in front; `None` if that didn't happen before `deadline`.
fn wait_until_in_front<R: Runtime>(
    app: &AppHandle<R>,
    deadline: SystemTime,
) -> Option<WebviewWindow<R>> {
    loop {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW)
            && in_front(&window)
        {
            return Some(window);
        }
        if SystemTime::now() >= deadline {
            return None;
        }
        thread::sleep(FRONT_POLL_INTERVAL);
    }
}

/// The offer's buttons. "Later" comes first where the first button is the one Return presses:
/// NSAlert's on macOS, the task dialog's default on Windows. GTK (Linux and the BSDs) reports
/// custom buttons only as OK and Cancel, and closing the dialog as Cancel too, so there the
/// install button is OK and closing the dialog means later.
fn offer_buttons() -> MessageButtons {
    if cfg!(any(target_os = "macos", windows)) {
        MessageButtons::OkCancelCustom(LATER.into(), INSTALL.into())
    } else {
        MessageButtons::OkCancelCustom(INSTALL.into(), LATER.into())
    }
}

/// Whether the answer installs the update: "Install and Restart", and nothing else. Closing the
/// dialog leaves it for later.
fn installs(answer: &MessageDialogResult) -> bool {
    match answer {
        MessageDialogResult::Custom(label) => label == INSTALL,
        // GTK's OK button, which is "Install and Restart" there (see `offer_buttons`).
        MessageDialogResult::Ok => !cfg!(any(target_os = "macos", windows)),
        _ => false,
    }
}

/// What the offer says, from the version FXM runs to the new one.
pub fn question_text(current: &str, new: &str) -> String {
    format!(
        "FXM {new} is available. You have {current}.\n\n\
         Installing it closes FXM, which stops the music, and opens the new version. \
         What's new: {RELEASES_URL}/tag/v{new}"
    )
}

/// Shows the offer over `window` and waits for the answer: `Some(true)` to install, `None` if the
/// dialog couldn't be shown. rfd builds the dialog on the main thread, as for the approval of a
/// new host, and the answer arrives without blocking it.
async fn ask<R: Runtime>(window: &WebviewWindow<R>, question: String) -> Option<bool> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            let answer = AsyncMessageDialog::new()
                .set_level(MessageLevel::Info)
                .set_title(DIALOG_TITLE)
                .set_description(question)
                .set_buttons(offer_buttons())
                .set_parent(&parent)
                .show();
            let _ = sender.send(answer);
        })
        .ok()?;
    let answer = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .ok()?
        .ok()?;
    Some(installs(&answer.await))
}

/// How much of the download has arrived, in whole percent, when the server said how big it is.
pub fn progress_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    let percent = u128::from(downloaded.min(total)) * 100 / u128::from(total);
    u8::try_from(percent).ok()
}

/// The window's title while the update downloads.
pub fn download_title(version: &str, percent: Option<u8>) -> String {
    match percent {
        Some(percent) => format!("FXM: downloading version {version} ({percent}%)"),
        None => format!("FXM: downloading version {version}"),
    }
}

/// The window's title while the update installs.
pub fn install_title(version: &str) -> String {
    format!("FXM: installing version {version}")
}

/// What the message says when the update couldn't be installed.
pub fn failure_text(version: &str, error: &str) -> String {
    format!(
        "FXM couldn't install version {version}: {error}\n\n\
         It will offer the update again. You can also download it from {RELEASES_URL}"
    )
}

/// Downloads, checks and installs `update`, with the progress in the window's title, then starts
/// FXM again. On Windows the installer closes FXM and opens it again itself. A failure is told in
/// a message, and the window gets its title back.
fn install_and_restart<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, update: &Update) {
    let title = window.title().unwrap_or_else(|_| "FXM".to_owned());
    let mut downloaded = 0_u64;
    let mut shown = None;
    let _ = window.set_title(&download_title(&update.version, None));
    let installed = tauri::async_runtime::block_on(update.download_and_install(
        |chunk, total| {
            downloaded = downloaded.saturating_add(chunk as u64);
            let percent = progress_percent(downloaded, total);
            if percent.is_some() && percent != shown {
                shown = percent;
                let _ = window.set_title(&download_title(&update.version, percent));
            }
        },
        || {
            let _ = window.set_title(&install_title(&update.version));
        },
    ));
    match installed {
        // Through the app's exit events, so plugins such as window-state save first.
        Ok(()) => app.request_restart(),
        Err(error) => {
            let _ = window.set_title(&title);
            tell_failure(app, failure_text(&update.version, &error.to_string()));
        }
    }
}

/// Tells the user that the update failed. Nothing waits for the answer.
fn tell_failure<R: Runtime>(app: &AppHandle<R>, text: String) {
    let _ = app.run_on_main_thread(move || {
        let answer = AsyncMessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title("FXM wasn't updated")
            .set_description(text)
            .set_buttons(MessageButtons::Ok)
            .show();
        tauri::async_runtime::spawn(answer);
    });
}

#[cfg(test)]
mod tests {
    use rfd::MessageDialogResult;

    use std::time::{Duration, SystemTime};

    use super::{
        INSTALL, LATER, WAKE_INTERVAL, download_title, enabled, failure_text, install_title,
        installs, is_usable_pubkey, next_nap, progress_percent, question_text,
    };

    /// A minisign public key in the plugin's format, from a key pair made for these tests only
    /// (test/fixtures/updater in apps/desktop has it with a signature, and how it was made).
    const TEST_PUBKEY: &str = include_str!("../../test/fixtures/updater/test-key.pub");

    /// The placeholder in tauri.conf.json until the owner commits FXM's key.
    fn configured_pubkey() -> String {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        config["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("tauri.conf.json has plugins > updater > pubkey")
            .to_owned()
    }

    #[test]
    fn the_release_signatures_pass_the_updaters_check() {
        // data.txt.sig was made by apps/desktop/release/minisign.ts, which the release workflow
        // signs with. tauri-plugin-updater checks a download like this: minisign-verify, then the
        // version in the trusted comment (`requireSignedVersion`).
        use base64::Engine as _;
        let decode = |text: &str| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .expect("base64");
            String::from_utf8(bytes).expect("UTF-8")
        };
        let key = minisign_verify::PublicKey::decode(&decode(TEST_PUBKEY)).expect("a public key");
        let signature = minisign_verify::Signature::decode(&decode(include_str!(
            "../../test/fixtures/updater/data.txt.sig"
        )))
        .expect("a signature");
        let data = include_bytes!("../../test/fixtures/updater/data.txt");
        // Prehashed, so it passes without the legacy mode the plugin also allows.
        key.verify(data, &signature, false)
            .expect("the signature holds");
        let version = signature
            .trusted_comment()
            .split('\t')
            .find_map(|field| field.strip_prefix("version:"));
        assert_eq!(version, Some("1.2.3"));
        let mut tampered = data.to_vec();
        tampered[0] ^= 1;
        assert!(key.verify(&tampered, &signature, true).is_err());
    }

    #[test]
    fn a_minisign_public_key_is_usable_exactly_as_the_plugin_reads_it() {
        assert!(is_usable_pubkey(TEST_PUBKEY));
        // The plugin decodes the key as it stands, so it would refuse every update signed for a
        // key with whitespace around it.
        for padded in [
            format!("{TEST_PUBKEY}\n"),
            format!(" {TEST_PUBKEY}"),
            format!("{TEST_PUBKEY} "),
        ] {
            assert!(!is_usable_pubkey(&padded), "{padded:?}");
        }
    }

    #[test]
    fn anything_else_is_not() {
        for key in [
            "",
            "not base64!",
            "aGVsbG8=",
            "dW50cnVzdGVkIGNvbW1lbnQ6IHgKeHh4eAo=",
        ] {
            assert!(!is_usable_pubkey(key), "{key}");
        }
    }

    #[test]
    fn the_configured_key_is_usable_or_the_placeholder() {
        let pubkey = configured_pubkey();
        assert!(
            is_usable_pubkey(&pubkey) || pubkey.starts_with("PLACEHOLDER"),
            "plugins > updater > pubkey must be FXM's public key or the placeholder"
        );
    }

    #[test]
    fn only_release_builds_with_a_key_look_for_updates() {
        assert!(enabled(false, Some(TEST_PUBKEY)));
        assert!(!enabled(true, Some(TEST_PUBKEY)), "debug builds never look");
        assert!(!enabled(false, None));
        assert!(!enabled(false, Some("PLACEHOLDER")));
    }

    #[test]
    fn only_the_install_button_installs() {
        assert!(installs(&MessageDialogResult::Custom(INSTALL.into())));
        assert!(!installs(&MessageDialogResult::Custom(LATER.into())));
        assert!(!installs(&MessageDialogResult::Cancel));
        assert!(!installs(&MessageDialogResult::No));
        assert_eq!(
            installs(&MessageDialogResult::Ok),
            !cfg!(any(target_os = "macos", windows)),
            "OK is the install button on GTK only"
        );
    }

    #[test]
    fn later_is_the_button_return_presses_on_macos_and_windows() {
        let rfd::MessageButtons::OkCancelCustom(first, second) = super::offer_buttons() else {
            panic!("the offer has two custom buttons");
        };
        if cfg!(any(target_os = "macos", windows)) {
            assert_eq!((first.as_str(), second.as_str()), (LATER, INSTALL));
        } else {
            assert_eq!((first.as_str(), second.as_str()), (INSTALL, LATER));
        }
    }

    #[test]
    fn the_offer_names_both_versions_and_where_to_read_what_changed() {
        let text = question_text("0.6.0", "0.7.0");
        assert!(text.starts_with("FXM 0.7.0 is available. You have 0.6.0."));
        assert!(text.contains("stops the music"));
        assert!(text.ends_with("https://github.com/Pratyay-ops/FXM/releases/tag/v0.7.0"));
    }

    #[test]
    fn the_thread_naps_until_the_next_check_by_the_clock() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let hour = Duration::from_secs(60 * 60);
        assert_eq!(next_nap(now + hour, now), Some(WAKE_INTERVAL));
        assert_eq!(
            next_nap(now + Duration::from_secs(90), now),
            Some(Duration::from_secs(90))
        );
        // Due, or past due after the computer slept through it: check now.
        assert_eq!(next_nap(now, now), None);
        assert_eq!(next_nap(now, now + hour), None);
    }

    #[test]
    fn the_title_shows_the_download_in_whole_percent() {
        assert_eq!(progress_percent(0, Some(200)), Some(0));
        assert_eq!(progress_percent(199, Some(200)), Some(99));
        assert_eq!(progress_percent(200, Some(200)), Some(100));
        assert_eq!(
            progress_percent(500, Some(200)),
            Some(100),
            "never above 100"
        );
        assert_eq!(progress_percent(10, None), None, "no size, no percent");
        assert_eq!(progress_percent(10, Some(0)), None);
        assert_eq!(progress_percent(u64::MAX, Some(u64::MAX)), Some(100));
        assert_eq!(
            download_title("0.7.0", Some(42)),
            "FXM: downloading version 0.7.0 (42%)"
        );
        assert_eq!(
            download_title("0.7.0", None),
            "FXM: downloading version 0.7.0"
        );
        assert_eq!(install_title("0.7.0"), "FXM: installing version 0.7.0");
    }

    #[test]
    fn a_failure_says_what_went_wrong_and_where_to_get_the_update() {
        let text = failure_text("0.7.0", "the signature does not match");
        assert!(text.starts_with("FXM couldn't install version 0.7.0: the signature"));
        assert!(text.ends_with("https://github.com/Pratyay-ops/FXM/releases"));
    }
}
