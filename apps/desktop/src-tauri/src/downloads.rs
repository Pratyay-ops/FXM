//! Downloads on disk (stage 7.4): the download manager's files in the folder the user picks,
//! `Music/FXM` by default, and the copies saved there in another format.
//!
//! The web app's download manager (`@fxm/downloads`, stage 4.1) runs in the webview. It names
//! each file with an opaque name of its own (1 to 64 ASCII letters, digits, `-` and `_`), and its
//! desktop storage (`createDesktopDownloadStorage` in `apps/desktop/bridge`) hands those names to
//! this plugin's commands. Page script never passes a path: Rust alone decides where a file goes,
//! and every command writes inside the downloads folder only.
//!
//! - **While it downloads,** a file lives in the folder's hidden `.fxm-partial` folder under its
//!   opaque name.
//! - **Once complete,** the web app gives it its human name (`name`), say `Radiohead - Creep.webm`,
//!   and Rust moves it into the folder itself, under a name no other file has: a file of the same
//!   name, FXM's or the user's, is never replaced.
//! - **The index** (`downloads.json` in the app's config folder) maps each opaque name to its file,
//!   and keeps the folder the user chose. Only files FXM wrote are in it, so the commands never
//!   list, read or delete any other file in the folder.
//! - **Choosing another folder** applies to the downloads that start from then on: downloads made
//!   before stay where they are and keep playing.
//! - **Saved copies** (`save_begin`, `save_write`, `save_end`), a download converted to another
//!   format by stage 4.2, go into the folder too, under their own names, and are the user's from
//!   then on: the index doesn't keep them.
//!
//! Offline playback reads a complete file through the `fxm-download:` scheme
//! (`fxm-download://localhost/<name>`, `http://fxm-download.localhost/<name>` on Windows), which
//! serves FXM's own files by their opaque names, with byte ranges, to the main window only.
//!
//! The web app sends a download's bytes as base64: the isolation hook (`apps/desktop/isolation`)
//! refuses byte payloads, so no command takes bytes.
//!
//! Error codes (`CommandError`): `bad-request` (a name, offset or payload FXM doesn't accept),
//! `busy` (the file is open for writing), `not-open`, `not-found`, `too-large`, `storage-full`,
//! `folder-missing` (the chosen folder is gone, say a disconnected drive), `no-folder`, `denied`
//! (the system refused access), `storage` (another failure), and for the folder picker
//! `not-focused` and `dialog`.

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use base64::Engine as _;
use rfd::AsyncFileDialog;
use serde::{Deserialize, Serialize};
use tauri::{
    Manager, Runtime, State, Url, WebviewWindow,
    http::{Method, Request, Response, StatusCode, header},
    plugin::{Builder, TauriPlugin},
};

use crate::{MAIN_WINDOW, user_hosts::CommandError};

/// The plugin's name: its commands are `plugin:fxm-downloads|open` and so on.
pub const PLUGIN: &str = "fxm-downloads";

/// The URI scheme offline playback reads complete files from.
pub const SCHEME: &str = "fxm-download";

/// The host wry gives the scheme on Windows: `http://fxm-download.localhost/`.
pub const WINDOWS_HOST: &str = "fxm-download.localhost";

/// The file in the app's config folder that keeps the chosen folder and the index.
pub const STATE_FILE: &str = "downloads.json";

/// The folder in the user's Music folder that downloads go to unless the user chose another.
pub const DEFAULT_FOLDER_NAME: &str = "FXM";

/// The hidden folder, inside the downloads folder, that holds files while they download.
pub const PARTIAL_FOLDER: &str = ".fxm-partial";

/// The end of the name of a copy being saved, in [`PARTIAL_FOLDER`]: its dot keeps the name out
/// of what `list` reports, so the download manager never mistakes it for a download.
pub const SAVE_SUFFIX: &str = ".saving";

/// The largest file FXM writes: 2 GiB, the download manager's own limit (`MAX_DOWNLOAD_BYTES`).
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The most bytes one `write` may carry, decoded: the download manager writes 256 KiB at a time.
pub const MAX_WRITE_BYTES: usize = 16 * 1024 * 1024;

/// The most bytes one response of the playback scheme carries for a range: a media element asks
/// again for the rest, as it does of any server that answers a part of what it asked for.
pub const MAX_RANGE_BYTES: u64 = 1024 * 1024;

/// The extensions a download or a saved copy may have: the containers FXM downloads and converts
/// to (`.mp4` only for YouTube's itag 18, a video file).
pub const EXTENSIONS: &[&str] = &[
    "webm", "weba", "m4a", "mp4", "mp3", "ogg", "oga", "opus", "flac", "wav", "aac",
];

/// The longest name, in characters, a file gets before its number and extension.
const MAX_STEM_CHARS: usize = 150;

/// How many files of one name FXM tries (`Name (2).mp3` up to this) before it gives up.
const MAX_NAME_NUMBER: u32 = 999;

/// A file's name when its title leaves nothing usable.
const FALLBACK_STEM: &str = "FXM download";

/// Names Windows reserves for devices, whatever their extension.
const DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// The folder picker's title.
const PICKER_TITLE: &str = "Choose where FXM saves downloads";

/// Whether `name` is one of the download manager's file names: 1 to 64 ASCII letters, digits,
/// `-` and `_`, and not a name Windows reserves for a device (`isSafeFileName` in
/// `@fxm/downloads`). Nothing a file system could read as a path gets through.
pub fn is_safe_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && !DEVICE_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

fn check_name(name: &str) -> Result<(), CommandError> {
    if is_safe_name(name) {
        Ok(())
    } else {
        Err(CommandError::new(
            "bad-request",
            format!("{name:?} is not a download file name"),
        ))
    }
}

/// A file name the web app asked for, made safe as one name inside the downloads folder: its stem
/// without the characters file systems refuse, control characters, leading dots (hidden files)
/// and trailing dots and spaces (which Windows drops), at most [`MAX_STEM_CHARS`] characters, and
/// never a device name; its extension one of [`EXTENSIONS`]. Returns the stem and the extension,
/// in lower case.
pub fn safe_file_name(requested: &str) -> Result<(String, String), CommandError> {
    let bad = || {
        CommandError::new(
            "bad-request",
            format!("{requested:?} is not a file name FXM saves: it needs an audio extension"),
        )
    };
    let (stem, extension) = requested.rsplit_once('.').ok_or_else(bad)?;
    let extension = extension.to_ascii_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err(bad());
    }
    let replaced: String = stem
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    let mut stem: String = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if stem.chars().count() > MAX_STEM_CHARS {
        stem = stem.chars().take(MAX_STEM_CHARS).collect();
    }
    let stem = stem
        .trim_start_matches(['.', ' '])
        .trim_end_matches(['.', ' ']);
    let stem = if stem.trim().is_empty() {
        FALLBACK_STEM.to_owned()
    } else {
        stem.trim().to_owned()
    };
    // Windows reserves a device name whatever follows its first dot: `CON.mp3`, `con.live.mp3`.
    let first = stem.split('.').next().unwrap_or_default().trim_end();
    let stem = if DEVICE_NAMES.contains(&first.to_ascii_lowercase().as_str()) {
        format!("{stem} (track)")
    } else {
        stem
    };
    Ok((stem, extension))
}

/// The name of the `number`th file of a stem: `Name.mp3`, then `Name (2).mp3`, …
fn numbered(stem: &str, extension: &str, number: u32) -> String {
    if number <= 1 {
        format!("{stem}.{extension}")
    } else {
        format!("{stem} ({number}).{extension}")
    }
}

/// Whether anything, a dangling link included, has the name `path`.
fn taken(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// The first name of the stem that no file in `folder` has. Only a guess: [`reserve`] makes sure.
fn free_name(folder: &Path, stem: &str, extension: &str) -> String {
    (1..=MAX_NAME_NUMBER)
        .map(|number| numbered(stem, extension, number))
        .find(|name| !taken(&folder.join(name)))
        .unwrap_or_else(|| numbered(stem, extension, 1))
}

/// Takes the first name of the stem that no file in `folder` has, by creating it empty and only
/// if it doesn't exist yet, so a rename onto it never replaces a file that appeared meanwhile.
fn reserve(folder: &Path, stem: &str, extension: &str) -> Result<PathBuf, CommandError> {
    for number in 1..=MAX_NAME_NUMBER {
        let path = folder.join(numbered(stem, extension, number));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            // Windows answers "access denied" for a folder of that name.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists || taken(&path) => {}
            Err(error) => return Err(io_error(error, "name the file")),
        }
    }
    Err(CommandError::new(
        "storage",
        format!("FXM found no free name for {stem}.{extension} in the downloads folder"),
    ))
}

/// Whether `error` says the disk, or the user's share of it, is full.
fn is_disk_full(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    ) {
        return true;
    }
    let codes: &[i32] = if cfg!(target_os = "macos") {
        // ENOSPC, EDQUOT.
        &[28, 69]
    } else if cfg!(target_os = "linux") {
        &[28, 122]
    } else if cfg!(windows) {
        // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL.
        &[39, 112]
    } else {
        &[28]
    };
    error
        .raw_os_error()
        .is_some_and(|code| codes.contains(&code))
}

/// The [`CommandError`] for a failed file operation, saying what FXM tried to do.
fn io_error(error: io::Error, doing: &str) -> CommandError {
    let code = if is_disk_full(&error) {
        "storage-full"
    } else {
        match error.kind() {
            io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => "denied",
            io::ErrorKind::NotFound => "not-found",
            _ => "storage",
        }
    };
    CommandError::new(code, format!("FXM could not {doing}: {error}"))
}

/// Whether `path` is a file in a [`PARTIAL_FOLDER`]: a download on its way.
fn is_partial(path: &Path) -> bool {
    path.parent().and_then(Path::file_name) == Some(OsStr::new(PARTIAL_FOLDER))
}

/// Whether `path` is a regular file (not a link, a folder or nothing).
fn is_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

/// What `downloads.json` holds.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    /// The folder the user chose; none for the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folder: Option<PathBuf>,
    /// Each download's file, by its opaque name.
    #[serde(default)]
    files: BTreeMap<String, PathBuf>,
}

/// A copy being saved.
struct Save {
    /// Where its bytes go until it is complete.
    temp: PathBuf,
    /// The folder it goes to.
    folder: PathBuf,
    stem: String,
    extension: String,
    file: Arc<Mutex<File>>,
}

#[derive(Default)]
struct Inner {
    /// The folder the user chose; `None` for the default.
    chosen: Option<PathBuf>,
    /// Each download's file, by its opaque name: in a [`PARTIAL_FOLDER`] while it downloads, in
    /// the downloads folder once named.
    files: BTreeMap<String, PathBuf>,
    /// The files open for writing, one writer each.
    writers: HashMap<String, Arc<Mutex<File>>>,
    /// The copies being saved.
    saves: HashMap<u64, Save>,
    next_save: u64,
}

/// Where the downloads folder is, as Settings shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    /// The folder.
    pub path: String,
    /// Whether the user chose it, rather than FXM's default.
    pub chosen: bool,
}

/// What `list` reports: the opaque names of FXM's files that exist.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Files on their way, in a [`PARTIAL_FOLDER`].
    pub partial: Vec<String>,
    /// Complete files with their human names.
    pub named: Vec<String>,
}

/// A copy that `save_begin` started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveStarted {
    /// What `save_write` and `save_end` take.
    pub id: u64,
    /// The name the copy will most likely get: `save_end` picks another if a file took it
    /// meanwhile.
    pub file_name: String,
}

/// The downloads folder, the index of FXM's files in it, and the files open for writing.
pub struct Downloads {
    /// Where the choice of folder and the index are kept; `None` keeps them in memory only.
    state_file: Option<PathBuf>,
    /// `Music/FXM`, the folder downloads go to unless the user chose another.
    default_folder: Option<PathBuf>,
    inner: Mutex<Inner>,
    /// Whether the folder picker is open.
    picking: AtomicBool,
}

impl Downloads {
    /// Loads the choice of folder and the index from `state_file`. A missing or damaged file gives
    /// the default folder and an empty index, and entries that aren't FXM's names or absolute
    /// paths are dropped. Copies left half saved by an FXM that stopped are deleted.
    pub fn load(state_file: PathBuf, default_folder: Option<PathBuf>) -> Self {
        let stored = fs::read(&state_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
            .unwrap_or_default();
        let files = stored
            .files
            .into_iter()
            .filter(|(name, path)| is_safe_name(name) && path.is_absolute())
            .collect();
        let chosen = stored.folder.filter(|folder| folder.is_absolute());
        let downloads = Self {
            state_file: Some(state_file),
            default_folder,
            inner: Mutex::new(Inner {
                chosen,
                files,
                ..Inner::default()
            }),
            picking: AtomicBool::new(false),
        };
        downloads.delete_unfinished_saves();
        downloads
    }

    /// Downloads kept in memory only, in `default_folder`.
    #[cfg(test)]
    fn in_memory(default_folder: Option<PathBuf>) -> Self {
        Self {
            state_file: None,
            default_folder,
            inner: Mutex::default(),
            picking: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The downloads folder now: the chosen one, or the default.
    fn current_folder(&self, inner: &Inner) -> Option<PathBuf> {
        inner.chosen.clone().or_else(|| self.default_folder.clone())
    }

    /// The folder new files go to. A chosen folder must exist: FXM never creates it again, so a
    /// disconnected drive's folder can't come back on the system disk. The default one is created.
    fn writing_folder(&self, inner: &Inner) -> Result<PathBuf, CommandError> {
        if let Some(chosen) = &inner.chosen {
            return if chosen.is_dir() {
                Ok(chosen.clone())
            } else {
                Err(CommandError::new(
                    "folder-missing",
                    "The downloads folder you chose is missing. Connect its drive, or choose another folder in Settings.",
                ))
            };
        }
        let default = self.default_folder.clone().ok_or_else(|| {
            CommandError::new(
                "no-folder",
                "FXM found no Music folder for downloads: choose a folder in Settings.",
            )
        })?;
        fs::create_dir_all(&default)
            .map_err(|error| io_error(error, "create the downloads folder"))?;
        Ok(default)
    }

    /// Where the file named `name` is, if it exists: its entry in the index, else a file of that
    /// name in the current folder's [`PARTIAL_FOLDER`] that the index lost.
    fn locate(&self, inner: &Inner, name: &str) -> Option<PathBuf> {
        if let Some(path) = inner.files.get(name)
            && is_file(path)
        {
            return Some(path.clone());
        }
        let partial = self.current_folder(inner)?.join(PARTIAL_FOLDER).join(name);
        is_file(&partial).then_some(partial)
    }

    /// Writes the choice of folder and the index to a temporary file, then renames it over the old
    /// one.
    fn save(&self, inner: &Inner) -> Result<(), CommandError> {
        let Some(file) = &self.state_file else {
            return Ok(());
        };
        let stored = Stored {
            version: 1,
            folder: inner.chosen.clone(),
            files: inner.files.clone(),
        };
        let failed = |error: &dyn std::fmt::Display| {
            CommandError::new(
                "storage",
                format!("FXM could not save its list of downloads: {error}"),
            )
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(|error| failed(&error))?;
        if let Some(folder) = file.parent() {
            fs::create_dir_all(folder).map_err(|error| failed(&error))?;
        }
        let partial = file.with_extension("json.partial");
        fs::write(&partial, json).map_err(|error| failed(&error))?;
        fs::rename(&partial, file).map_err(|error| failed(&error))
    }

    /// Deletes copies left half saved in the current folder by an FXM that stopped.
    fn delete_unfinished_saves(&self) {
        let inner = self.lock();
        let Some(folder) = self.current_folder(&inner) else {
            return;
        };
        let Ok(entries) = fs::read_dir(folder.join(PARTIAL_FOLDER)) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().ends_with(SAVE_SUFFIX) && is_file(&entry.path()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Where the downloads folder is.
    pub fn folder(&self) -> Result<FolderInfo, CommandError> {
        let inner = self.lock();
        let path = self.current_folder(&inner).ok_or_else(|| {
            CommandError::new(
                "no-folder",
                "FXM found no Music folder for downloads: choose a folder in Settings.",
            )
        })?;
        Ok(FolderInfo {
            path: path.to_string_lossy().into_owned(),
            chosen: inner.chosen.is_some(),
        })
    }

    /// Makes `folder`, which the user picked, the downloads folder for the downloads that start
    /// from now on.
    pub fn set_folder(&self, folder: PathBuf) -> Result<FolderInfo, CommandError> {
        if !folder.is_absolute() || !folder.is_dir() {
            return Err(CommandError::new(
                "bad-request",
                "The downloads folder must be a folder that exists",
            ));
        }
        let mut inner = self.lock();
        let previous = inner.chosen.replace(folder.clone());
        if let Err(error) = self.save(&inner) {
            inner.chosen = previous;
            return Err(error);
        }
        Ok(FolderInfo {
            path: folder.to_string_lossy().into_owned(),
            chosen: true,
        })
    }

    /// Opens the file named `name` for writing, creating it empty in the current folder's
    /// [`PARTIAL_FOLDER`] if FXM has no such file, and answers its size. One writer per file.
    pub fn open(&self, name: &str) -> Result<u64, CommandError> {
        check_name(name)?;
        let mut inner = self.lock();
        if inner.writers.contains_key(name) {
            return Err(CommandError::new(
                "busy",
                format!("{name} is already open for writing"),
            ));
        }
        let path = match self.locate(&inner, name) {
            Some(path) => path,
            None => {
                let partial = self.writing_folder(&inner)?.join(PARTIAL_FOLDER);
                fs::create_dir_all(&partial)
                    .map_err(|error| io_error(error, "create the folder for downloads"))?;
                let path = partial.join(name);
                // Never written through: a link or a folder put where the file goes.
                if taken(&path) {
                    return Err(CommandError::new(
                        "storage",
                        format!("Something that is not a download has the name {name}"),
                    ));
                }
                path
            }
        };
        if inner.files.get(name) != Some(&path) {
            // The index first, so FXM never leaves a file behind that it doesn't know.
            let previous = inner.files.insert(name.to_owned(), path.clone());
            if let Err(error) = self.save(&inner) {
                match previous {
                    Some(previous) => inner.files.insert(name.to_owned(), previous),
                    None => inner.files.remove(name),
                };
                return Err(error);
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| io_error(error, "open the download"))?;
        let size = file
            .metadata()
            .map_err(|error| io_error(error, "read the download's size"))?
            .len();
        inner
            .writers
            .insert(name.to_owned(), Arc::new(Mutex::new(file)));
        Ok(size)
    }

    /// The writer of `name`, which must be open.
    fn writer(&self, name: &str) -> Result<Arc<Mutex<File>>, CommandError> {
        check_name(name)?;
        self.lock()
            .writers
            .get(name)
            .cloned()
            .ok_or_else(|| CommandError::new("not-open", format!("{name} is not open for writing")))
    }

    /// Writes `bytes` at `offset` of the open file `name`, growing it as needed.
    pub fn write(&self, name: &str, offset: u64, bytes: &[u8]) -> Result<(), CommandError> {
        let writer = self.writer(name)?;
        write_at(&writer, offset, bytes)
    }

    /// Cuts the open file `name` to `size` bytes.
    pub fn truncate(&self, name: &str, size: u64) -> Result<(), CommandError> {
        let writer = self.writer(name)?;
        if size > MAX_FILE_BYTES {
            return Err(too_large());
        }
        let file = writer.lock().unwrap_or_else(PoisonError::into_inner);
        file.set_len(size)
            .map_err(|error| io_error(error, "shorten the download"))
    }

    /// Makes what was written to the open file `name` survive a crash.
    pub fn flush(&self, name: &str) -> Result<(), CommandError> {
        let writer = self.writer(name)?;
        let file = writer.lock().unwrap_or_else(PoisonError::into_inner);
        file.sync_data()
            .map_err(|error| io_error(error, "save the download"))
    }

    /// Flushes and releases the file `name`. Closing a file that isn't open does nothing.
    pub fn close(&self, name: &str) -> Result<(), CommandError> {
        check_name(name)?;
        let writer = self.lock().writers.remove(name);
        let Some(writer) = writer else {
            return Ok(());
        };
        let file = writer.lock().unwrap_or_else(PoisonError::into_inner);
        file.sync_data()
            .map_err(|error| io_error(error, "save the download"))
    }

    /// Deletes the file `name`, if FXM has one, and forgets it. Not while it is open.
    pub fn remove(&self, name: &str) -> Result<(), CommandError> {
        check_name(name)?;
        let mut inner = self.lock();
        if inner.writers.contains_key(name) {
            return Err(CommandError::new(
                "busy",
                format!("{name} is open for writing"),
            ));
        }
        let mut paths: Vec<PathBuf> = inner.files.get(name).cloned().into_iter().collect();
        if let Some(folder) = self.current_folder(&inner) {
            paths.push(folder.join(PARTIAL_FOLDER).join(name));
        }
        for path in paths {
            if is_file(&path) {
                fs::remove_file(&path).map_err(|error| io_error(error, "delete the download"))?;
            }
        }
        if inner.files.remove(name).is_some() {
            self.save(&inner)?;
        }
        Ok(())
    }

    /// FXM's files that exist, by their opaque names, sorted: those on their way (from the index,
    /// and any the index lost in the current folder's [`PARTIAL_FOLDER`]) and those complete.
    /// Entries whose file is gone leave the index.
    pub fn list(&self) -> Result<Listing, CommandError> {
        let mut inner = self.lock();
        let mut listing = Listing::default();
        let mut gone = Vec::new();
        for (name, path) in &inner.files {
            if !is_file(path) {
                if !inner.writers.contains_key(name) {
                    gone.push(name.clone());
                }
            } else if is_partial(path) {
                listing.partial.push(name.clone());
            } else {
                listing.named.push(name.clone());
            }
        }
        if let Some(folder) = self.current_folder(&inner)
            && let Ok(entries) = fs::read_dir(folder.join(PARTIAL_FOLDER))
        {
            for entry in entries.flatten() {
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if is_safe_name(&name) && !inner.files.contains_key(&name) && is_file(&entry.path())
                {
                    listing.partial.push(name);
                }
            }
        }
        if !gone.is_empty() {
            for name in &gone {
                inner.files.remove(name);
            }
            // Best effort: the entries are dropped again next time.
            let _ = self.save(&inner);
        }
        listing.partial.sort();
        listing.named.sort();
        Ok(listing)
    }

    /// The size of the file `name` in bytes, or `None` when FXM has no such file.
    pub fn size(&self, name: &str) -> Result<Option<u64>, CommandError> {
        check_name(name)?;
        let inner = self.lock();
        if let Some(writer) = inner.writers.get(name) {
            let file = writer.lock().unwrap_or_else(PoisonError::into_inner);
            return file
                .metadata()
                .map(|metadata| Some(metadata.len()))
                .map_err(|error| io_error(error, "read the download's size"));
        }
        Ok(self
            .locate(&inner, name)
            .and_then(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len()))
    }

    /// The whole of the file `name`.
    pub fn read(&self, name: &str) -> Result<Vec<u8>, CommandError> {
        check_name(name)?;
        let path = self
            .locate(&self.lock(), name)
            .ok_or_else(|| CommandError::new("not-found", format!("FXM has no file {name}")))?;
        let mut file = File::open(&path).map_err(|error| io_error(error, "read the download"))?;
        let length = file
            .metadata()
            .map_err(|error| io_error(error, "read the download"))?
            .len();
        if length > MAX_FILE_BYTES {
            return Err(too_large());
        }
        let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        file.read_to_end(&mut bytes)
            .map_err(|error| io_error(error, "read the download"))?;
        Ok(bytes)
    }

    /// Gives the complete file `name` its human name, `requested` made safe ([`safe_file_name`]),
    /// moving it out of its [`PARTIAL_FOLDER`] into the downloads folder it was made in, under a
    /// name no other file has. Answers the name it got. A file that has its name already keeps it.
    pub fn name(&self, name: &str, requested: &str) -> Result<String, CommandError> {
        check_name(name)?;
        let (stem, extension) = safe_file_name(requested)?;
        let mut inner = self.lock();
        if inner.writers.contains_key(name) {
            return Err(CommandError::new(
                "busy",
                format!("{name} is open for writing"),
            ));
        }
        let current = self
            .locate(&inner, name)
            .ok_or_else(|| CommandError::new("not-found", format!("FXM has no file {name}")))?;
        let file_name = |path: &Path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        if !is_partial(&current) {
            return Ok(file_name(&current));
        }
        let folder = current
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| CommandError::new("storage", "The download has no folder"))?
            .to_path_buf();
        let target = reserve(&folder, &stem, &extension)?;
        if let Err(error) = fs::rename(&current, &target) {
            let _ = fs::remove_file(&target);
            return Err(io_error(error, "name the download"));
        }
        inner.files.insert(name.to_owned(), target.clone());
        // The index in memory has the new place; a failed save is written by the next one.
        self.save(&inner)?;
        Ok(file_name(&target))
    }

    /// Where the complete file `name` is, for offline playback.
    fn playback_path(&self, name: &str) -> Option<PathBuf> {
        if !is_safe_name(name) {
            return None;
        }
        self.locate(&self.lock(), name)
    }

    /// Starts saving a copy named `requested` ([`safe_file_name`]) in the current folder.
    pub fn save_begin(&self, requested: &str) -> Result<SaveStarted, CommandError> {
        let (stem, extension) = safe_file_name(requested)?;
        let mut inner = self.lock();
        let folder = self.writing_folder(&inner)?;
        let partial = folder.join(PARTIAL_FOLDER);
        fs::create_dir_all(&partial)
            .map_err(|error| io_error(error, "create the folder for downloads"))?;
        inner.next_save += 1;
        let id = inner.next_save;
        let temp = partial.join(format!(".{id}{SAVE_SUFFIX}"));
        let file = File::create(&temp).map_err(|error| io_error(error, "start the copy"))?;
        let file_name = free_name(&folder, &stem, &extension);
        inner.saves.insert(
            id,
            Save {
                temp,
                folder,
                stem,
                extension,
                file: Arc::new(Mutex::new(file)),
            },
        );
        Ok(SaveStarted { id, file_name })
    }

    /// Writes `bytes` at `offset` of the copy `id`.
    pub fn save_write(&self, id: u64, offset: u64, bytes: &[u8]) -> Result<(), CommandError> {
        let file = self
            .lock()
            .saves
            .get(&id)
            .map(|save| save.file.clone())
            .ok_or_else(|| CommandError::new("not-open", format!("No copy {id} is being saved")))?;
        write_at(&file, offset, bytes)
    }

    /// Ends the copy `id`: with `keep`, gives it a name no other file has in its folder and
    /// answers it; without, deletes it.
    pub fn save_end(&self, id: u64, keep: bool) -> Result<Option<String>, CommandError> {
        let save =
            self.lock().saves.remove(&id).ok_or_else(|| {
                CommandError::new("not-open", format!("No copy {id} is being saved"))
            })?;
        let synced = save
            .file
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sync_data();
        drop(save.file);
        if !keep {
            let _ = fs::remove_file(&save.temp);
            return Ok(None);
        }
        if let Err(error) = synced {
            let _ = fs::remove_file(&save.temp);
            return Err(io_error(error, "save the copy"));
        }
        let target = match reserve(&save.folder, &save.stem, &save.extension) {
            Ok(target) => target,
            Err(error) => {
                let _ = fs::remove_file(&save.temp);
                return Err(error);
            }
        };
        if let Err(error) = fs::rename(&save.temp, &target) {
            let _ = fs::remove_file(&target);
            let _ = fs::remove_file(&save.temp);
            return Err(io_error(error, "save the copy"));
        }
        Ok(target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()))
    }

    /// Marks the folder picker open, or says it is open already. Dropping the guard closes it.
    fn begin_picking(&self) -> Result<PickerGuard<'_>, CommandError> {
        if self.picking.swap(true, Ordering::AcqRel) {
            return Err(CommandError::new(
                "busy",
                "FXM is already asking for a folder",
            ));
        }
        Ok(PickerGuard(&self.picking))
    }
}

/// The open folder picker: dropping it lets the next one open.
struct PickerGuard<'a>(&'a AtomicBool);

impl Drop for PickerGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn too_large() -> CommandError {
    CommandError::new(
        "too-large",
        format!(
            "A download may take at most {} GiB",
            MAX_FILE_BYTES / (1024 * 1024 * 1024)
        ),
    )
}

/// Writes `bytes` at `offset` of `file`, within [`MAX_FILE_BYTES`].
fn write_at(file: &Mutex<File>, offset: u64, bytes: &[u8]) -> Result<(), CommandError> {
    let fits = u64::try_from(bytes.len())
        .ok()
        .and_then(|length| offset.checked_add(length))
        .is_some_and(|end| end <= MAX_FILE_BYTES);
    if !fits {
        return Err(too_large());
    }
    let mut file = file.lock().unwrap_or_else(PoisonError::into_inner);
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.write_all(bytes))
        .map_err(|error| io_error(error, "write the download"))
}

/// The bytes of a base64 payload, at most [`MAX_WRITE_BYTES`] of them.
pub fn decode_payload(data: &str) -> Result<Vec<u8>, CommandError> {
    if data.len() > MAX_WRITE_BYTES / 3 * 4 + 4 {
        return Err(CommandError::new(
            "too-large",
            "One write may carry at most 16 MiB",
        ));
    }
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| CommandError::new("bad-request", "The bytes to write are not base64"))
}

// --- Offline playback: the fxm-download: scheme ------------------------------------------------

/// What a `Range` header asks for, of a file of some length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteRange {
    /// No range: the whole file.
    Whole,
    /// The bytes from the first to the second, both included, at most [`MAX_RANGE_BYTES`].
    Part(u64, u64),
    /// A range the file can't serve, or one FXM doesn't read (several ranges, other units).
    Unsatisfiable,
}

/// The part of a file of `length` bytes that `header` asks for: one range of bytes, `a-b`, `a-`
/// or `-n` (the last n bytes), capped at [`MAX_RANGE_BYTES`].
pub fn byte_range(header: Option<&str>, length: u64) -> ByteRange {
    let Some(header) = header else {
        return ByteRange::Whole;
    };
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return ByteRange::Unsatisfiable;
    };
    let Some((start, end)) = spec.trim().split_once('-') else {
        return ByteRange::Unsatisfiable;
    };
    if spec.contains(',') || length == 0 {
        return ByteRange::Unsatisfiable;
    }
    let number = |text: &str| -> Option<u64> {
        let text = text.trim();
        (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| text.parse().ok())
            .flatten()
    };
    let (first, last) = match (number(start), number(end), end.trim().is_empty()) {
        // `-n`: the last n bytes.
        (None, Some(suffix), _) if start.trim().is_empty() && suffix > 0 => {
            (length.saturating_sub(suffix), length - 1)
        }
        // `a-`: from a to the end.
        (Some(first), None, true) => (first, length - 1),
        // `a-b`.
        (Some(first), Some(last), _) if first <= last => (first, last.min(length - 1)),
        _ => return ByteRange::Unsatisfiable,
    };
    if first >= length {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Part(first, last.min(first + MAX_RANGE_BYTES - 1))
}

/// The `Content-Type` to serve: the type the web app asked for when it is audio, an MP4 or WebM
/// video or plain bytes, optionally with a `codecs` parameter, and plain bytes otherwise. Never a
/// type a webview would render as a page.
pub fn content_type(requested: Option<&str>) -> String {
    const PLAIN: &str = "application/octet-stream";
    let Some(requested) = requested.map(str::trim) else {
        return PLAIN.to_owned();
    };
    let (essence, parameters) = match requested.split_once(';') {
        Some((essence, parameters)) => (essence.trim(), Some(parameters.trim())),
        None => (requested, None),
    };
    let token = |text: &str| {
        !text.is_empty()
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
    };
    let essence_ok = match essence.split_once('/') {
        Some(("audio", subtype)) => token(subtype),
        Some(("video", "mp4" | "webm")) | Some(("application", "octet-stream")) => true,
        _ => false,
    };
    let parameters_ok = parameters.is_none_or(|parameters| {
        parameters.strip_prefix("codecs=").is_some_and(|codecs| {
            let codecs = codecs.strip_prefix('"').unwrap_or(codecs);
            let codecs = codecs.strip_suffix('"').unwrap_or(codecs);
            codecs
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"., +-".contains(&byte))
        })
    });
    if essence_ok && parameters_ok {
        requested.to_owned()
    } else {
        PLAIN.to_owned()
    }
}

/// A response with no body.
fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("a static response")
}

/// Answers a request to the `fxm-download:` scheme from the webview labelled `webview`: the main
/// window's `GET` or `HEAD` of `/<opaque name>` (with `?type=` for its `Content-Type`), a byte
/// range of it, and nothing else.
pub fn respond(
    downloads: &Downloads,
    request: &Request<Vec<u8>>,
    webview: &str,
) -> Response<Vec<u8>> {
    if webview != MAIN_WINDOW {
        return status(StatusCode::FORBIDDEN);
    }
    let head = request.method() == Method::HEAD;
    if !head && request.method() != Method::GET {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let name = request.uri().path().trim_start_matches('/');
    let Some(path) = downloads.playback_path(name) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(mut file) = File::open(&path) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let requested_type = Url::parse(&request.uri().to_string()).ok().and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "type")
            .map(|(_, value)| value.into_owned())
    });
    let range = request
        .headers()
        .get(header::RANGE)
        .map(|value| value.to_str().unwrap_or(""));
    let builder = Response::builder()
        .header(
            header::CONTENT_TYPE,
            content_type(requested_type.as_deref()),
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    let (builder, start, count) = match byte_range(range, length) {
        ByteRange::Whole => (builder.status(StatusCode::OK), 0, length),
        ByteRange::Part(first, last) => (
            builder.status(StatusCode::PARTIAL_CONTENT).header(
                header::CONTENT_RANGE,
                format!("bytes {first}-{last}/{length}"),
            ),
            first,
            last - first + 1,
        ),
        ByteRange::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                .header(header::CACHE_CONTROL, "no-store")
                .body(Vec::new())
                .expect("a static response");
        }
    };
    let builder = builder.header(header::CONTENT_LENGTH, count);
    if head {
        return builder.body(Vec::new()).expect("a valid response");
    }
    let mut body = Vec::with_capacity(usize::try_from(count).unwrap_or(0));
    let read = file
        .seek(SeekFrom::Start(start))
        .and_then(|_| (&mut file).take(count).read_to_end(&mut body));
    match read {
        Ok(_) => builder.body(body).expect("a valid response"),
        Err(_) => status(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// --- Commands ----------------------------------------------------------------------------------

/// The plugin's state.
type Shared = Arc<Downloads>;

/// Runs `work` on a thread for blocking work, so file operations never hold up the main thread
/// or the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::new("storage", error.to_string()))?
}

/// Opens the file `file` for writing and answers its size.
#[tauri::command]
async fn open(downloads: State<'_, Shared>, file: String) -> Result<u64, CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.open(&file)).await
}

/// Writes `data` (base64) at `offset` of the open file `file`.
#[tauri::command]
async fn write(
    downloads: State<'_, Shared>,
    file: String,
    offset: u64,
    data: String,
) -> Result<(), CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.write(&file, offset, &decode_payload(&data)?)).await
}

/// Cuts the open file `file` to `size` bytes.
#[tauri::command]
async fn truncate(
    downloads: State<'_, Shared>,
    file: String,
    size: u64,
) -> Result<(), CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.truncate(&file, size)).await
}

/// Makes what was written to the open file `file` survive a crash.
#[tauri::command]
async fn flush(downloads: State<'_, Shared>, file: String) -> Result<(), CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.flush(&file)).await
}

/// Flushes and releases the file `file`.
#[tauri::command]
async fn close(downloads: State<'_, Shared>, file: String) -> Result<(), CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.close(&file)).await
}

/// Deletes the file `file`.
#[tauri::command]
async fn remove(downloads: State<'_, Shared>, file: String) -> Result<(), CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.remove(&file)).await
}

/// FXM's files that exist, by their opaque names.
#[tauri::command]
async fn list(downloads: State<'_, Shared>) -> Result<Listing, CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.list()).await
}

/// The size of the file `file`, or `null`.
#[tauri::command]
async fn size(downloads: State<'_, Shared>, file: String) -> Result<Option<u64>, CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.size(&file)).await
}

/// The whole of the file `file`, as bytes.
#[tauri::command]
async fn read(
    downloads: State<'_, Shared>,
    file: String,
) -> Result<tauri::ipc::Response, CommandError> {
    let downloads = downloads.inner().clone();
    let bytes = blocking(move || downloads.read(&file)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Gives the complete file `file` its human name, `file_name` made safe, and answers it.
#[tauri::command]
async fn name(
    downloads: State<'_, Shared>,
    file: String,
    file_name: String,
) -> Result<String, CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.name(&file, &file_name)).await
}

/// Where the downloads folder is.
#[tauri::command]
async fn folder(downloads: State<'_, Shared>) -> Result<FolderInfo, CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.folder()).await
}

/// Whether `window` is visible, not minimized, and has the focus.
fn in_front<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(true)
        && window.is_focused().unwrap_or(false)
}

/// Asks the user, in the system's folder picker over the main window, for the folder downloads go
/// to from now on. Answers the new folder, or `null` if the user cancelled. Only while FXM's
/// window is in front (`not-focused`), and one picker at a time (`busy`).
#[tauri::command]
async fn choose_folder<R: Runtime>(
    window: WebviewWindow<R>,
    downloads: State<'_, Shared>,
) -> Result<Option<FolderInfo>, CommandError> {
    if !in_front(&window) {
        return Err(CommandError::new(
            "not-focused",
            "FXM asks for a folder only while its window is in front",
        ));
    }
    let shared = downloads.inner().clone();
    let _picking = downloads.begin_picking()?;
    let start = shared
        .folder()
        .ok()
        .map(|folder| PathBuf::from(folder.path));
    let Some(picked) = pick_folder(&window, start).await? else {
        return Ok(None);
    };
    blocking(move || shared.set_folder(picked)).await.map(Some)
}

/// Shows the folder picker over `window`, starting in `start` (or the nearest folder above it
/// that exists), and waits for the user's choice. rfd builds the picker on the main thread, as the
/// approval dialog does, and the answer arrives without blocking it.
async fn pick_folder<R: Runtime>(
    window: &WebviewWindow<R>,
    start: Option<PathBuf>,
) -> Result<Option<PathBuf>, CommandError> {
    let failed = || CommandError::new("dialog", "FXM could not show the folder picker");
    let start = start.and_then(|start| {
        start
            .ancestors()
            .find(|folder| folder.is_dir())
            .map(Path::to_path_buf)
    });
    let (sender, receiver) = mpsc::sync_channel(1);
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            let mut picker = AsyncFileDialog::new()
                .set_title(PICKER_TITLE)
                .set_can_create_directories(true)
                .set_parent(&parent);
            if let Some(start) = start {
                picker = picker.set_directory(start);
            }
            let _ = sender.send(picker.pick_folder());
        })
        .map_err(|_| failed())?;
    let answer = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?;
    Ok(answer.await.map(|handle| handle.path().to_path_buf()))
}

/// Starts saving a copy named `file_name` (made safe) in the downloads folder.
#[tauri::command]
async fn save_begin(
    downloads: State<'_, Shared>,
    file_name: String,
) -> Result<SaveStarted, CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.save_begin(&file_name)).await
}

/// Writes `data` (base64) at `offset` of the copy `id`.
#[tauri::command]
async fn save_write(
    downloads: State<'_, Shared>,
    id: u64,
    offset: u64,
    data: String,
) -> Result<(), CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.save_write(id, offset, &decode_payload(&data)?)).await
}

/// Ends the copy `id`: with `keep`, answers the name it got; without, deletes it.
#[tauri::command]
async fn save_end(
    downloads: State<'_, Shared>,
    id: u64,
    keep: bool,
) -> Result<Option<String>, CommandError> {
    let downloads = downloads.inner().clone();
    blocking(move || downloads.save_end(id, keep)).await
}

/// The folder downloads go to by default: `FXM` in the user's Music folder.
fn default_folder<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let paths = app.path();
    let music = paths
        .audio_dir()
        .ok()
        .or_else(|| paths.home_dir().ok().map(|home| home.join("Music")))?;
    Some(music.join(DEFAULT_FOLDER_NAME))
}

/// The downloads plugin: its commands, which `fxm-downloads:default` grants to the main window
/// only, and the `fxm-download:` scheme.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN)
        .setup(|app, _api| {
            let state_file = app.path().app_config_dir()?.join(STATE_FILE);
            let shared: Shared = Arc::new(Downloads::load(state_file, default_folder(app)));
            app.manage(shared);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(SCHEME, |context, request, responder| {
            let app = context.app_handle().clone();
            let webview = context.webview_label().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                let response = match app.try_state::<Shared>() {
                    Some(downloads) => respond(&downloads, &request, &webview),
                    None => status(StatusCode::SERVICE_UNAVAILABLE),
                };
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            open,
            write,
            truncate,
            flush,
            close,
            remove,
            list,
            size,
            read,
            name,
            folder,
            choose_folder,
            save_begin,
            save_write,
            save_end
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder in the system's temporary folder, deleted when dropped.
    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "fxm-downloads-{}-{name}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Downloads in memory, whose default folder is `music/FXM` inside `temp`.
    fn downloads_in(temp: &TempFolder) -> Downloads {
        Downloads::in_memory(Some(temp.path().join("music").join(DEFAULT_FOLDER_NAME)))
    }

    fn default_folder_of(temp: &TempFolder) -> PathBuf {
        temp.path().join("music").join(DEFAULT_FOLDER_NAME)
    }

    /// Writes `bytes` as the download `name` and closes it.
    fn download(downloads: &Downloads, name: &str, bytes: &[u8]) {
        assert_eq!(downloads.open(name).unwrap(), 0);
        downloads.write(name, 0, bytes).unwrap();
        downloads.flush(name).unwrap();
        downloads.close(name).unwrap();
    }

    fn entries(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn only_the_managers_own_names_are_file_names() {
        for good in [
            "a",
            "0b6f9e1c-2f4d-4c55-9d1e-7a0f3c2b1a90",
            "file_1",
            &"x".repeat(64),
        ] {
            assert!(is_safe_name(good), "{good}");
        }
        for bad in [
            "",
            &"x".repeat(65),
            "../x",
            "a/b",
            "a\\b",
            "a.b",
            ".hidden",
            "con",
            "NUL",
            "com1",
            "Lpt9",
            "a b",
            "é",
            "a\0b",
        ] {
            assert!(!is_safe_name(bad), "{bad:?}");
            assert_eq!(check_name(bad).unwrap_err().code, "bad-request", "{bad:?}");
        }
    }

    #[test]
    fn file_names_are_made_safe_inside_the_folder() {
        let cases = [
            ("Radiohead - Creep.webm", ("Radiohead - Creep", "webm")),
            (
                "  Simon & Garfunkel - Mrs. Robinson .MP3",
                ("Simon & Garfunkel - Mrs. Robinson", "mp3"),
            ),
            (
                "a/b\\c:d*e?f\"g<h>i|j.flac",
                ("a b c d e f g h i j", "flac"),
            ),
            ("../../etc/passwd.opus", ("etc passwd", "opus")),
            ("...hidden.m4a", ("hidden", "m4a")),
            ("trailing dots... .wav", ("trailing dots", "wav")),
            ("line\nbreak\ttab.ogg", ("line break tab", "ogg")),
            (".mp3", (FALLBACK_STEM, "mp3")),
            ("   .mp4", (FALLBACK_STEM, "mp4")),
            ("CON.mp3", ("CON (track)", "mp3")),
            ("aux.live.flac", ("aux.live (track)", "flac")),
            ("日本語 - タイトル.m4a", ("日本語 - タイトル", "m4a")),
        ];
        for (requested, (stem, extension)) in cases {
            assert_eq!(
                safe_file_name(requested).unwrap(),
                (stem.to_owned(), extension.to_owned()),
                "{requested:?}"
            );
        }
        let long = format!("{}.mp3", "é".repeat(400));
        let (stem, _) = safe_file_name(&long).unwrap();
        assert_eq!(stem.chars().count(), MAX_STEM_CHARS);
        for refused in [
            "no extension",
            "song.exe",
            "song.html",
            "song.mp3.lnk",
            "song.",
        ] {
            assert_eq!(
                safe_file_name(refused).unwrap_err().code,
                "bad-request",
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_download_is_written_in_the_hidden_folder_then_named() {
        let temp = TempFolder::new("write");
        let downloads = downloads_in(&temp);
        let folder = default_folder_of(&temp);
        assert_eq!(downloads.open("abc").unwrap(), 0);
        downloads.write("abc", 0, b"hello ").unwrap();
        downloads.write("abc", 6, b"world").unwrap();
        assert_eq!(downloads.size("abc").unwrap(), Some(11));
        downloads.flush("abc").unwrap();
        downloads.close("abc").unwrap();
        assert_eq!(entries(&folder.join(PARTIAL_FOLDER)), ["abc"]);
        assert_eq!(
            downloads.list().unwrap(),
            Listing {
                partial: vec!["abc".into()],
                named: vec![]
            }
        );
        let named = downloads.name("abc", "Radiohead - Creep.webm").unwrap();
        assert_eq!(named, "Radiohead - Creep.webm");
        assert_eq!(
            fs::read(folder.join("Radiohead - Creep.webm")).unwrap(),
            b"hello world"
        );
        assert!(entries(&folder.join(PARTIAL_FOLDER)).is_empty());
        assert_eq!(
            downloads.list().unwrap(),
            Listing {
                partial: vec![],
                named: vec!["abc".into()]
            }
        );
        assert_eq!(downloads.read("abc").unwrap(), b"hello world");
        assert_eq!(downloads.size("abc").unwrap(), Some(11));
        // Naming again changes nothing.
        assert_eq!(
            downloads.name("abc", "Something else.mp3").unwrap(),
            "Radiohead - Creep.webm"
        );
    }

    #[test]
    fn writes_continue_where_the_file_ends_and_gaps_fill_with_zeros() {
        let temp = TempFolder::new("resume");
        let downloads = downloads_in(&temp);
        download(&downloads, "abc", b"12345");
        // A resume opens the same file.
        assert_eq!(downloads.open("abc").unwrap(), 5);
        downloads.write("abc", 7, b"89").unwrap();
        assert_eq!(downloads.size("abc").unwrap(), Some(9));
        downloads.truncate("abc", 3).unwrap();
        downloads.close("abc").unwrap();
        assert_eq!(downloads.read("abc").unwrap(), b"123");
        download(&downloads, "gap", b"");
        downloads.open("gap").unwrap();
        downloads.write("gap", 2, b"x").unwrap();
        downloads.close("gap").unwrap();
        assert_eq!(downloads.read("gap").unwrap(), b"\0\0x");
    }

    #[test]
    fn one_writer_per_file_and_never_a_delete_while_it_writes() {
        let temp = TempFolder::new("busy");
        let downloads = downloads_in(&temp);
        downloads.open("abc").unwrap();
        assert_eq!(downloads.open("abc").unwrap_err().code, "busy");
        assert_eq!(downloads.remove("abc").unwrap_err().code, "busy");
        assert_eq!(downloads.name("abc", "Name.mp3").unwrap_err().code, "busy");
        downloads.close("abc").unwrap();
        // Closing twice is fine; writing to a closed file is not.
        downloads.close("abc").unwrap();
        assert_eq!(
            downloads.write("abc", 0, b"x").unwrap_err().code,
            "not-open"
        );
        assert_eq!(downloads.truncate("abc", 0).unwrap_err().code, "not-open");
        assert_eq!(downloads.flush("abc").unwrap_err().code, "not-open");
        downloads.remove("abc").unwrap();
        assert_eq!(downloads.size("abc").unwrap(), None);
    }

    #[test]
    fn a_link_or_folder_where_a_download_goes_is_never_written_through() {
        let temp = TempFolder::new("links");
        let downloads = downloads_in(&temp);
        let partial = default_folder_of(&temp).join(PARTIAL_FOLDER);
        fs::create_dir_all(partial.join("folder")).unwrap();
        assert_eq!(downloads.open("folder").unwrap_err().code, "storage");
        #[cfg(unix)]
        {
            let outside = temp.path().join("outside.txt");
            fs::write(&outside, b"keep me").unwrap();
            std::os::unix::fs::symlink(&outside, partial.join("link")).unwrap();
            assert_eq!(downloads.open("link").unwrap_err().code, "storage");
            assert_eq!(fs::read(&outside).unwrap(), b"keep me");
            // Nor listed, read or deleted through.
            assert_eq!(downloads.list().unwrap(), Listing::default());
            assert_eq!(downloads.read("link").unwrap_err().code, "not-found");
            downloads.remove("link").unwrap();
            assert_eq!(fs::read(&outside).unwrap(), b"keep me");
        }
    }

    #[test]
    fn writes_stay_within_the_largest_file() {
        let temp = TempFolder::new("large");
        let downloads = downloads_in(&temp);
        downloads.open("abc").unwrap();
        assert_eq!(
            downloads
                .write("abc", MAX_FILE_BYTES, b"x")
                .unwrap_err()
                .code,
            "too-large"
        );
        assert_eq!(
            downloads.write("abc", u64::MAX, b"x").unwrap_err().code,
            "too-large"
        );
        assert_eq!(
            downloads
                .truncate("abc", MAX_FILE_BYTES + 1)
                .unwrap_err()
                .code,
            "too-large"
        );
        downloads.close("abc").unwrap();
    }

    #[test]
    fn bad_names_never_reach_the_file_system() {
        let temp = TempFolder::new("names");
        let downloads = downloads_in(&temp);
        for bad in ["../escape", "a/b", "con", ".x", ""] {
            assert_eq!(downloads.open(bad).unwrap_err().code, "bad-request");
            assert_eq!(downloads.remove(bad).unwrap_err().code, "bad-request");
            assert_eq!(downloads.size(bad).unwrap_err().code, "bad-request");
            assert_eq!(downloads.read(bad).unwrap_err().code, "bad-request");
            assert_eq!(
                downloads.name(bad, "x.mp3").unwrap_err().code,
                "bad-request"
            );
        }
        assert!(!temp.path().join("music").exists());
        assert!(!temp.path().join("escape").exists());
    }

    #[test]
    fn a_name_that_is_taken_gets_a_number_and_no_file_is_replaced() {
        let temp = TempFolder::new("taken");
        let downloads = downloads_in(&temp);
        let folder = default_folder_of(&temp);
        fs::create_dir_all(&folder).unwrap();
        // The user's own file, and a folder, with the names FXM would pick.
        fs::write(folder.join("Song.mp3"), b"the user's").unwrap();
        fs::create_dir(folder.join("Song (2).mp3")).unwrap();
        download(&downloads, "one", b"first");
        download(&downloads, "two", b"second");
        assert_eq!(downloads.name("one", "Song.mp3").unwrap(), "Song (3).mp3");
        // The extension's case doesn't make another name.
        let second = downloads.name("two", "Song.MP3").unwrap();
        assert_eq!(second, "Song (4).mp3");
        assert_eq!(fs::read(folder.join("Song.mp3")).unwrap(), b"the user's");
        assert_eq!(fs::read(folder.join("Song (3).mp3")).unwrap(), b"first");
        assert_eq!(fs::read(folder.join("Song (4).mp3")).unwrap(), b"second");
    }

    #[test]
    fn removing_deletes_only_fxms_file() {
        let temp = TempFolder::new("remove");
        let downloads = downloads_in(&temp);
        let folder = default_folder_of(&temp);
        download(&downloads, "abc", b"bytes");
        downloads.name("abc", "Song.mp3").unwrap();
        fs::write(folder.join("Other.mp3"), b"the user's").unwrap();
        downloads.remove("abc").unwrap();
        assert_eq!(entries(&folder), [PARTIAL_FOLDER, "Other.mp3"]);
        assert_eq!(downloads.list().unwrap(), Listing::default());
        // Removing what isn't there is fine.
        downloads.remove("abc").unwrap();
        downloads.remove("never").unwrap();
    }

    #[test]
    fn the_list_has_fxms_files_only_and_forgets_those_gone() {
        let temp = TempFolder::new("list");
        let downloads = downloads_in(&temp);
        let folder = default_folder_of(&temp);
        download(&downloads, "named", b"1");
        downloads.name("named", "Song.mp3").unwrap();
        download(&downloads, "partial", b"2");
        download(&downloads, "deleted", b"3");
        downloads.name("deleted", "Deleted.mp3").unwrap();
        // The user deletes a download's file, and keeps music of their own next to them.
        fs::remove_file(folder.join("Deleted.mp3")).unwrap();
        fs::write(folder.join("Theirs.mp3"), b"x").unwrap();
        // Left in the hidden folder without an entry, say after a crash: FXM's, so listed.
        fs::write(folder.join(PARTIAL_FOLDER).join("orphan"), b"x").unwrap();
        // Not a download name, so never listed.
        fs::write(folder.join(PARTIAL_FOLDER).join("not a name"), b"x").unwrap();
        fs::write(folder.join(PARTIAL_FOLDER).join(".1.saving"), b"x").unwrap();
        assert_eq!(
            downloads.list().unwrap(),
            Listing {
                partial: vec!["orphan".into(), "partial".into()],
                named: vec!["named".into()],
            }
        );
        assert!(!downloads.lock().files.contains_key("deleted"));
        // The orphan can be deleted, as the download manager's tidy-up does.
        downloads.remove("orphan").unwrap();
        assert!(!folder.join(PARTIAL_FOLDER).join("orphan").exists());
    }

    #[test]
    fn the_index_and_the_chosen_folder_survive_a_restart() {
        let temp = TempFolder::new("restart");
        let state = temp.path().join("config").join(STATE_FILE);
        let default = default_folder_of(&temp);
        let downloads = Downloads::load(state.clone(), Some(default.clone()));
        download(&downloads, "abc", b"bytes");
        downloads.name("abc", "Song.flac").unwrap();
        let chosen = temp.path().join("chosen");
        fs::create_dir(&chosen).unwrap();
        assert_eq!(
            downloads.set_folder(chosen.clone()).unwrap(),
            FolderInfo {
                path: chosen.to_string_lossy().into_owned(),
                chosen: true
            }
        );
        drop(downloads);
        let restarted = Downloads::load(state.clone(), Some(default.clone()));
        assert_eq!(restarted.folder().unwrap().path, chosen.to_string_lossy());
        // The download made before the change stays where it is and still plays.
        assert_eq!(restarted.read("abc").unwrap(), b"bytes");
        assert_eq!(
            restarted.playback_path("abc"),
            Some(default.join("Song.flac"))
        );
        // New ones go to the chosen folder.
        download(&restarted, "new", b"x");
        assert!(chosen.join(PARTIAL_FOLDER).join("new").exists());
        assert!(!state.with_extension("json.partial").exists());
    }

    #[test]
    fn a_damaged_index_loads_as_what_is_still_valid() {
        let temp = TempFolder::new("damaged");
        let state = temp.path().join(STATE_FILE);
        fs::write(&state, "not json").unwrap();
        let downloads = Downloads::load(state.clone(), Some(default_folder_of(&temp)));
        assert!(downloads.lock().files.is_empty());
        let absolute = temp.path().join("x.mp3");
        fs::write(
            &state,
            serde_json::json!({
                "version": 1,
                "folder": "relative/folder",
                "files": {
                    "good": absolute,
                    "../bad": absolute,
                    "relative": "x.mp3",
                },
            })
            .to_string(),
        )
        .unwrap();
        let downloads = Downloads::load(state, Some(default_folder_of(&temp)));
        let inner = downloads.lock();
        assert_eq!(inner.files.keys().collect::<Vec<_>>(), ["good"]);
        assert_eq!(inner.chosen, None);
    }

    #[test]
    fn a_chosen_folder_that_is_gone_is_never_created_again() {
        let temp = TempFolder::new("gone");
        let downloads = downloads_in(&temp);
        let chosen = temp.path().join("drive");
        fs::create_dir(&chosen).unwrap();
        downloads.set_folder(chosen.clone()).unwrap();
        fs::remove_dir(&chosen).unwrap();
        assert_eq!(downloads.open("abc").unwrap_err().code, "folder-missing");
        assert_eq!(
            downloads.save_begin("Song.mp3").unwrap_err().code,
            "folder-missing"
        );
        assert!(!chosen.exists());
        // Only an existing folder can be chosen.
        assert_eq!(
            downloads
                .set_folder(temp.path().join("nowhere"))
                .unwrap_err()
                .code,
            "bad-request"
        );
        assert_eq!(
            downloads
                .set_folder(PathBuf::from("relative"))
                .unwrap_err()
                .code,
            "bad-request"
        );
    }

    #[test]
    fn without_a_music_folder_the_user_must_choose_one() {
        let downloads = Downloads::in_memory(None);
        assert_eq!(downloads.folder().unwrap_err().code, "no-folder");
        assert_eq!(downloads.open("abc").unwrap_err().code, "no-folder");
        assert_eq!(downloads.list().unwrap(), Listing::default());
    }

    #[test]
    fn a_copy_is_saved_under_its_own_name_and_never_listed() {
        let temp = TempFolder::new("save");
        let downloads = downloads_in(&temp);
        let folder = default_folder_of(&temp);
        let started = downloads.save_begin("Radiohead - Creep.mp3").unwrap();
        assert_eq!(started.file_name, "Radiohead - Creep.mp3");
        downloads.save_write(started.id, 0, b"ID3").unwrap();
        downloads.save_write(started.id, 3, b" audio").unwrap();
        // A copy on its way is no download.
        assert_eq!(downloads.list().unwrap(), Listing::default());
        let saved = downloads.save_end(started.id, true).unwrap();
        assert_eq!(saved.as_deref(), Some("Radiohead - Creep.mp3"));
        assert_eq!(
            fs::read(folder.join("Radiohead - Creep.mp3")).unwrap(),
            b"ID3 audio"
        );
        assert!(entries(&folder.join(PARTIAL_FOLDER)).is_empty());
        // The next copy of the same name gets a number; a discarded one leaves nothing.
        let second = downloads.save_begin("Radiohead - Creep.mp3").unwrap();
        assert_eq!(second.file_name, "Radiohead - Creep (2).mp3");
        let third = downloads.save_begin("Other.flac").unwrap();
        assert_eq!(downloads.save_end(third.id, false).unwrap(), None);
        downloads.save_write(second.id, 0, b"x").unwrap();
        assert_eq!(
            downloads.save_end(second.id, true).unwrap().as_deref(),
            Some("Radiohead - Creep (2).mp3")
        );
        assert_eq!(
            entries(&folder),
            [
                PARTIAL_FOLDER,
                "Radiohead - Creep (2).mp3",
                "Radiohead - Creep.mp3"
            ]
        );
        assert!(entries(&folder.join(PARTIAL_FOLDER)).is_empty());
        assert_eq!(
            downloads.save_end(second.id, true).unwrap_err().code,
            "not-open"
        );
        assert_eq!(
            downloads.save_write(99, 0, b"x").unwrap_err().code,
            "not-open"
        );
        assert_eq!(
            downloads.save_begin("page.html").unwrap_err().code,
            "bad-request"
        );
    }

    #[test]
    fn copies_left_half_saved_go_at_the_next_start() {
        let temp = TempFolder::new("unfinished");
        let state = temp.path().join(STATE_FILE);
        let default = default_folder_of(&temp);
        let downloads = Downloads::load(state.clone(), Some(default.clone()));
        let started = downloads.save_begin("Song.mp3").unwrap();
        downloads.save_write(started.id, 0, b"half").unwrap();
        download(&downloads, "abc", b"a download on its way");
        drop(downloads);
        let restarted = Downloads::load(state, Some(default.clone()));
        assert_eq!(entries(&default.join(PARTIAL_FOLDER)), ["abc"]);
        assert_eq!(
            restarted.list().unwrap(),
            Listing {
                partial: vec!["abc".into()],
                named: vec![]
            }
        );
    }

    #[test]
    fn payloads_are_base64_of_bounded_size() {
        assert_eq!(decode_payload("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_payload("").unwrap(), b"");
        assert_eq!(
            decode_payload("not base64!").unwrap_err().code,
            "bad-request"
        );
        let huge = "A".repeat(MAX_WRITE_BYTES / 3 * 4 + 8);
        assert_eq!(decode_payload(&huge).unwrap_err().code, "too-large");
    }

    #[test]
    fn disk_full_and_refusals_are_told_apart() {
        let full = io::Error::from(io::ErrorKind::StorageFull);
        assert_eq!(io_error(full, "write").code, "storage-full");
        let quota = io::Error::from(io::ErrorKind::QuotaExceeded);
        assert_eq!(io_error(quota, "write").code, "storage-full");
        if cfg!(unix) {
            assert_eq!(
                io_error(io::Error::from_raw_os_error(28), "write").code,
                "storage-full"
            );
        }
        if cfg!(windows) {
            assert_eq!(
                io_error(io::Error::from_raw_os_error(112), "write").code,
                "storage-full"
            );
        }
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(io_error(denied, "write").code, "denied");
        let other = io::Error::other("boom");
        let error = io_error(other, "write the download");
        assert_eq!(error.code, "storage");
        assert!(error.message.contains("write the download"));
    }

    #[test]
    fn ranges_are_single_byte_ranges_within_the_file() {
        let length = 10_000_000;
        let cap = MAX_RANGE_BYTES;
        let cases = [
            (None, ByteRange::Whole),
            (Some("bytes=0-1"), ByteRange::Part(0, 1)),
            (Some("bytes=0-"), ByteRange::Part(0, cap - 1)),
            (Some("bytes=100-199"), ByteRange::Part(100, 199)),
            (
                Some("bytes=9999990-"),
                ByteRange::Part(9_999_990, 9_999_999),
            ),
            (
                Some("bytes=9999990-20000000"),
                ByteRange::Part(9_999_990, 9_999_999),
            ),
            (
                Some("bytes=-65536"),
                ByteRange::Part(length - 65_536, length - 1),
            ),
            (Some("bytes=-20000000"), ByteRange::Part(0, cap - 1)),
            (Some(" bytes=5-5 "), ByteRange::Part(5, 5)),
            (Some("bytes=10000000-"), ByteRange::Unsatisfiable),
            (Some("bytes=5-4"), ByteRange::Unsatisfiable),
            (Some("bytes=-0"), ByteRange::Unsatisfiable),
            (Some("bytes=0-1,5-6"), ByteRange::Unsatisfiable),
            (Some("bytes=a-b"), ByteRange::Unsatisfiable),
            (Some("bytes=+1-2"), ByteRange::Unsatisfiable),
            (Some("items=0-1"), ByteRange::Unsatisfiable),
            (Some("bytes="), ByteRange::Unsatisfiable),
        ];
        for (header, expected) in cases {
            assert_eq!(byte_range(header, length), expected, "{header:?}");
        }
        assert_eq!(byte_range(Some("bytes=0-"), 0), ByteRange::Unsatisfiable);
        assert_eq!(byte_range(None, 0), ByteRange::Whole);
    }

    #[test]
    fn content_types_are_media_or_plain_bytes() {
        for kept in [
            "audio/webm; codecs=\"opus\"",
            "audio/mp4; codecs=\"mp4a.40.2\"",
            "audio/mpeg",
            "audio/flac",
            "video/mp4",
            "video/webm",
            "application/octet-stream",
        ] {
            assert_eq!(content_type(Some(kept)), kept);
        }
        for refused in [
            "text/html",
            "image/svg+xml",
            "application/xhtml+xml",
            "audio/webm; charset=utf-8",
            "audio/webm; codecs=\"<script>\"",
            "audio/",
            "video/quicktime",
            "audio/mpeg\r\nX-Evil: 1",
        ] {
            assert_eq!(
                content_type(Some(refused)),
                "application/octet-stream",
                "{refused:?}"
            );
        }
        assert_eq!(content_type(None), "application/octet-stream");
    }

    fn get(
        downloads: &Downloads,
        uri: &str,
        range: Option<&str>,
        webview: &str,
    ) -> Response<Vec<u8>> {
        let mut request = Request::builder().method(Method::GET).uri(uri);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        respond(downloads, &request.body(Vec::new()).unwrap(), webview)
    }

    #[test]
    fn the_scheme_serves_fxms_files_to_the_main_window_with_ranges() {
        let temp = TempFolder::new("scheme");
        let downloads = downloads_in(&temp);
        let bytes: Vec<u8> = (0..=255)
            .cycle()
            .take(3 * MAX_RANGE_BYTES as usize)
            .collect();
        download(&downloads, "abc", &bytes);
        downloads.name("abc", "Song.webm").unwrap();
        let uri = "fxm-download://localhost/abc?type=audio%2Fwebm%3B%20codecs%3D%22opus%22";
        let whole = get(&downloads, uri, None, MAIN_WINDOW);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body(), &bytes);
        assert_eq!(
            whole.headers()[header::CONTENT_TYPE],
            "audio/webm; codecs=\"opus\""
        );
        assert_eq!(whole.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(whole.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let part = get(&downloads, uri, Some("bytes=10-19"), MAIN_WINDOW);
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body(), &bytes[10..20]);
        assert_eq!(
            part.headers()[header::CONTENT_RANGE],
            format!("bytes 10-19/{}", bytes.len())
        );
        assert_eq!(part.headers()[header::CONTENT_LENGTH], "10");
        let open_ended = get(&downloads, uri, Some("bytes=0-"), MAIN_WINDOW);
        assert_eq!(open_ended.body().len() as u64, MAX_RANGE_BYTES);
        let tail = get(&downloads, uri, Some("bytes=-4"), MAIN_WINDOW);
        assert_eq!(tail.body(), &bytes[bytes.len() - 4..]);
        let past_the_end = format!("bytes={}-", bytes.len());
        let beyond = get(&downloads, uri, Some(past_the_end.as_str()), MAIN_WINDOW);
        assert_eq!(beyond.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            beyond.headers()[header::CONTENT_RANGE],
            format!("bytes */{}", bytes.len())
        );
        // Windows' form of the scheme.
        let windows = get(
            &downloads,
            "http://fxm-download.localhost/abc",
            Some("bytes=0-1"),
            MAIN_WINDOW,
        );
        assert_eq!(windows.body(), &bytes[..2]);
        assert_eq!(
            windows.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        let head = respond(
            &downloads,
            &Request::builder()
                .method(Method::HEAD)
                .uri(uri)
                .body(Vec::new())
                .unwrap(),
            MAIN_WINDOW,
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(
            head.headers()[header::CONTENT_LENGTH],
            bytes.len().to_string()
        );
    }

    #[test]
    fn the_scheme_serves_nothing_else() {
        let temp = TempFolder::new("scheme-refusals");
        let downloads = downloads_in(&temp);
        download(&downloads, "abc", b"bytes");
        let folder = default_folder_of(&temp);
        fs::write(folder.join("theirs.mp3"), b"x").unwrap();
        let uri = "fxm-download://localhost/abc";
        // Other webviews: the evaluator, the Spotify login window.
        for webview in ["fxm-evaluator-0", "spotify-login"] {
            assert_eq!(
                get(&downloads, uri, None, webview).status(),
                StatusCode::FORBIDDEN
            );
        }
        for path in [
            "fxm-download://localhost/missing",
            "fxm-download://localhost/theirs.mp3",
            "fxm-download://localhost/..%2Ftheirs.mp3",
            "fxm-download://localhost/con",
            "fxm-download://localhost/",
        ] {
            assert_eq!(
                get(&downloads, path, None, MAIN_WINDOW).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        let post = respond(
            &downloads,
            &Request::builder()
                .method(Method::POST)
                .uri(uri)
                .body(Vec::new())
                .unwrap(),
            MAIN_WINDOW,
        );
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
        let html = get(
            &downloads,
            "fxm-download://localhost/abc?type=text%2Fhtml",
            None,
            MAIN_WINDOW,
        );
        assert_eq!(
            html.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
    }

    #[test]
    fn only_one_folder_picker_at_a_time() {
        let downloads = Downloads::in_memory(None);
        let first = downloads.begin_picking().unwrap();
        assert_eq!(downloads.begin_picking().err().unwrap().code, "busy");
        drop(first);
        downloads.begin_picking().unwrap();
    }

    #[test]
    fn the_partial_folder_is_hidden_and_saves_are_never_download_names() {
        assert!(PARTIAL_FOLDER.starts_with('.'));
        assert!(!is_safe_name(&format!(".1{SAVE_SUFFIX}")));
        assert!(is_partial(Path::new("/music/FXM/.fxm-partial/abc")));
        assert!(!is_partial(Path::new("/music/FXM/Song.mp3")));
    }
}
