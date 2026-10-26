//! The third-party notices that every release carries (stage 7.5): the licences of the Rust crates
//! compiled into the app and make dist's notices for the web app it shows, in one text file that
//! the release workflow writes (`apps/desktop/release/notices.ts`) and that
//! `tauri.release.conf.json` puts among the app's resources. Settings → About shows it, through
//! [`third_party_notices`].
//!
//! Local and development builds carry no such file: the command then says so, and About offers
//! the notices on FXM's site instead.

use std::io::ErrorKind;
use std::path::Path;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};

/// The file's name among the app's resources, as `tauri.release.conf.json` names it.
pub const NOTICES_FILE: &str = "third-party-notices.txt";

/// What the command says when the build carries no notices file.
pub const NO_NOTICES: &str =
    "This build of FXM carries no third-party notices file: release builds do.";

/// The third-party notices among the app's resources, as text. Async, so the file is read off the
/// main thread.
#[tauri::command]
pub async fn third_party_notices<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let path = app
        .path()
        .resolve(NOTICES_FILE, BaseDirectory::Resource)
        .map_err(|error| format!("FXM couldn't find its resources: {error}"))?;
    read_notices(&path)
}

/// Reads the notices file at `path`, or says why it can't.
pub fn read_notices(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(NO_NOTICES.to_string()),
        Err(error) => Err(format!(
            "FXM couldn't read its third-party notices: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{NO_NOTICES, NOTICES_FILE, read_notices};
    use std::fs;
    use std::path::PathBuf;

    /// A folder of its own for each test, removed first.
    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "fxm-notices-{}-{name}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).expect("a temporary folder");
        folder
    }

    #[test]
    fn reads_the_notices_file_as_it_is() {
        let folder = folder("present");
        let path = folder.join(NOTICES_FILE);
        let text = "FXM desktop app: third-party notices\nVersion 1.2.3\n\nserde 1.0.0 …\n";
        fs::write(&path, text).expect("the notices file");
        assert_eq!(read_notices(&path), Ok(text.to_string()));
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn says_that_a_build_without_the_file_carries_none() {
        let folder = folder("missing");
        assert_eq!(
            read_notices(&folder.join(NOTICES_FILE)),
            Err(NO_NOTICES.to_string())
        );
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn says_why_it_could_not_read_the_file() {
        // A folder where the file should be: reading it fails, but not because nothing is there.
        let folder = folder("unreadable");
        let path = folder.join(NOTICES_FILE);
        fs::create_dir_all(&path).expect("a folder in the file's place");
        let error = read_notices(&path).expect_err("a folder is no notices file");
        assert!(
            error.starts_with("FXM couldn't read its third-party notices: "),
            "{error}"
        );
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn the_release_config_bundles_the_file_under_its_name() {
        // tauri.release.conf.json maps the file the release workflow writes to NOTICES_FILE among
        // the resources, where the command looks for it.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.release.conf.json"))
                .expect("tauri.release.conf.json");
        let resources = config["bundle"]["resources"]
            .as_object()
            .expect("the release config maps its resources");
        assert_eq!(
            resources
                .values()
                .filter_map(|target| target.as_str())
                .collect::<Vec<_>>(),
            vec![NOTICES_FILE]
        );
    }
}
