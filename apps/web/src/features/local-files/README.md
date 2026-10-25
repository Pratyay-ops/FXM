# Local files

Music files on the user's device, in the web app (stage 4.4): a folder the browser keeps access to, or files chosen through a file input; tags and covers read with [music-metadata](https://github.com/Borewit/music-metadata); songs listed in the Library's **Local files** tab and in search ("On this device"), and played through the player core from object URLs. Nothing is uploaded: FXM reads the files where they are.

## How the files get in

| | Chromium on desktop (Chrome, Edge, Brave, Opera) | Every other browser, and the apps' webviews |
|---|---|---|
| Button | **Add a folder** (File System Access API) | **Choose a folder** (`<input webkitdirectory>`) and **Choose files** |
| After a reload | The folder stays. FXM keeps its handle in IndexedDB and checks the permission; when the browser wants to ask again, the folder shows **Allow access**, and playing one of its songs asks too. Chrome's "Allow on every visit" skips the question | The browser forgets the files: the folder shows **Choose again**. Choosing it again (same name) brings its songs back with their IDs |
| Changes on disk | Scanned again once per visit when readable, and with **Scan for changes** | Picked up when the folder is chosen again |

**Choose files** exists everywhere, also in Chromium, for single files: they play until the page reloads and are listed under "Chosen files".

A folder already added, picked again, is scanned for changes instead of being added twice. A folder inside one already added is refused ("already part of …"). A folder that holds folders added before replaces them, and their songs keep their IDs.

## Formats

FXM lists files by extension (`AUDIO_EXTENSIONS` in `format.ts`) and then by what the tag reader finds inside:

| Format | Extensions | Labelled |
|---|---|---|
| FLAC (also in Ogg) | `.flac`, `.oga`, `.ogg` | **Lossless**, with bit depth and sample rate |
| ALAC in MP4 | `.m4a`, `.mp4` | **Lossless** (Chromium and Firefox can't play it: see below) |
| WAV (PCM, integer or float) | `.wav` | **Lossless** |
| MP3 | `.mp3` | Lossy, with bitrate |
| AAC in MP4 | `.m4a`, `.mp4` | Lossy |
| Opus, Vorbis in Ogg or WebM | `.opus`, `.ogg`, `.oga`, `.webm`, `.weba` | Lossy |

**FLAC, ALAC and WAV are labelled lossless, nothing else is.** The tier comes from the codec through `tierOf` in `@fxm/core`, never from the tag reader's own `lossless` flag, which also says yes to formats browsers can't play (Monkey's Audio, WavPack, DSD, AIFF). Those, video files, raw `.aac` (ADTS), Matroska audio and files whose codec doesn't fit their container are left out and counted on the folder ("3 files can't be played here").

**What the browser can play** is asked the way the direct audio engine asks it, with `canPlayType` (`formatSupport` in `player.ts`). A file of a format the browser refuses is listed, dimmed, with **Can't play here**, and is kept out of queues; on 2026-10-26 Chromium 156 answered `''` to `audio/mp4; codecs="alac"` and `probably` to FLAC, MP3, AAC, Opus and Vorbis. Safari plays ALAC.

## Files

| File | What it holds |
|---|---|
| `types.ts` | Record types: roots (folders and chosen files), files with tags and format, cover thumbnails, handles |
| `database.ts` | The `fxm-local-files` IndexedDB database (Dexie), apart from the library's `fxm` |
| `repo.ts` | The repository: the only code that reads and writes that database. Folder handles go through a `HandleStore` (memory in tests) |
| `ids.ts` | Native IDs of local tracks, albums and artists, and the 64-bit FNV-1a hash they come from |
| `format.ts` | Which files are read; music-metadata's codec and container names mapped to core's; quality labels |
| `tags.ts` | `readTags`: music-metadata, loaded on first use, plus cleaning (lengths, dates, ISRCs, a title from the file name), and the length of Ogg files from their last page |
| `artwork.ts` | Cover thumbnails (`makeThumbnail`), folder images (`cover.jpg`…) and image keys |
| `file-system.ts` | The folder picker, permissions, walking a folder, grouping files from an input |
| `scanner.ts` | `scanRoot`: one scan of one root (unchanged files skipped, moved files keep their IDs, batched writes, cancel) |
| `local-files.ts` | The facade (`getLocalFiles()`): adding, scanning, access, statuses, opening a file to play |
| `object-urls.ts` | The object URLs files play from, the 16 most recent kept |
| `audio-source.ts` | Local files as a core `AudioSource`, for the playback policy (2.3) |
| `player.ts` | `withLocalFiles(resolver)`, the player local files play through, and `formatSupport` |
| `provider.ts` | Local files as a core `MetadataProvider` (source `local`), for search (2.4) |
| `tracks.ts` | Files as core `Track`s, sorting and searching |
| `hooks.ts` | Live queries of roots and tracks; root statuses |
| `local-files-panel.tsx`, `folder-list.tsx`, `add-music.tsx`, `track-list.tsx`, `track-row.tsx` | The Library tab |
| `search-section.tsx` | "On this device" on the search page |
| `testing/` | Generated audio files (WAV, FLAC, MP3, M4A, Ogg Opus, PNG covers), fake folder handles, a test facade |

## IDs

A local track is `local:track:<16 hex digits>`: 64-bit FNV-1a of `<root folder name>/<path inside it>` in Unicode NFC. So the ID is the same on every rescan, after removing and adding the folder again, and in another browser profile that reads the same folder, which keeps likes and playlist entries pointing at the file; a library backup restored elsewhere finds its local songs once the same folder is added there. Once given, an ID is stored with the file and kept:

- **Moved or renamed files** (within a root, or into a bigger folder that replaces its subfolders) keep their ID when a scan finds a new file with the same size, length, title, artists and album as one that disappeared.
- **Collisions** with an ID a moved file kept are avoided by mixing in a counter.
- **Chosen single files** are filed under `<size>/<name>`, so two different files of one name never share an ID.

Albums are `local:album:<hash of album artist and album>` and artists `local:artist:<hash of the name>`, normalized with `normalizeText`, so an album's tracks group together across folders. The album artist is the tag, else "Various artists" for a compilation, else the first artist.

## Tags and covers

`readTags` reads only what it needs through `Blob.slice` (headers and tags, never the whole file) and bounds what a damaged file can make it allocate (music-metadata 12.1.1). The parser is picked by extension; when that finds nothing playable, by content, for a file whose extension lies. Tags are trimmed and capped at 500 characters; a file without a title gets one from its name ("01 - Song.flac" is "Song", track 1; "99 Luftballons" and "1979" keep their numbers). music-metadata stops after an Ogg file's first pages, so the length of Opus, Vorbis and Ogg FLAC files is read from the granule position of the last page ([RFC 3533](https://www.rfc-editor.org/rfc/rfc3533), [RFC 7845](https://www.rfc-editor.org/rfc/rfc7845) for Opus's 48 kHz and pre-skip).

A cover is the file's embedded picture (the front cover), else its folder's `cover`, `folder`, `front`, `album`, `albumart` or `albumartsmall` image (`.jpg`, `.jpeg`, `.png`, `.webp`). Each image is thumbnailed once, keyed by its length and a hash of its ends and a sample of its middle, however many tracks share it: at most 128 px, WebP (JPEG where the browser can't encode WebP), as a `data:` URL of a few kilobytes. A `data:` URL works wherever a track goes (the library, the queue, the system media controls, a backup) and survives reloads, where an object URL wouldn't. A folder image added later covers the files that had none on the next scan.

## Playing

`streamFor(nativeId)` opens the file (asking for access when needed, which works because playing starts from a click) and returns a `StreamOption`: a `blob:` URL, `progressive`, `media: 'audio'`, `ipBound: false`, `fullLength: 'verified'` (the whole file is on the device), the codec, container, bitrate, sample rate, bit depth and tier. The object URL of an unchanged file is reused; the 16 most recent stay alive (the current track, the preloaded one, prefetches) and older ones are revoked. A revoked URL still in use fails like any broken stream, and the player resolves the track again.

Failures are `FxmError`s the player knows what to do with: a file gone from disk is `NotFound` (skip it); a folder FXM may not read, or chosen files forgotten after a reload, is `AuthRequired` (stop until the user acts); a format the engine refuses is `Unavailable` (skip). Their messages say what to do, and the list shows them as a toast.

## Until other stages merge

Built while the stages below were in progress, behind one seam each:

- **The app's player (2.5).** The player bar is still the shell's placeholder, so `getLocalPlayer()` makes a player of its own (direct audio engine, `withLocalFiles(NO_STREAMS)`, Media Session). When 2.5 merges: `getLocalPlayer()` returns 2.5's `getPlayer()`, `subscribeLocalPlayer` its `subscribePlayer`, and 2.5's `createAppPolicy()` wraps its resolver with `withLocalFiles(…)`.
- **The playback policy (2.3).** Register `createLocalAudioSource()` as the offline copy (ARCHITECTURE §7.4). Its `match` also finds a local file with a catalog track's ISRC, so a song the user owns, perhaps in FLAC, can play from their own copy.
- **Search (2.4).** Register `createLocalMetadataProvider()` with 2.4's sources registry (source `local`, labelled "This device"); its album and artist pages then work for local albums and artists. Until then the search page shows `LocalSearchSection`.

## Tests

Everything runs offline in happy-dom with tiny files generated in code (`testing/audio-files.ts`): silence or no audio at all, so no recording is involved. The tag tests parse real WAV, FLAC, MP3, M4A (ALAC and AAC) and Ogg Opus files through music-metadata. The scanner and facade tests use fake folder handles that grant, refuse and ask, and files that move, change or disappear.

`e2e/local-files.spec.ts` (Playwright, not part of `make check`) runs the real thing in Chromium: the folder picker returns a folder of the origin-private file system, a real `FileSystemDirectoryHandle`, filled with generated FLAC, MP3 and WAV files; it checks the tags, the lossless labels and the cover thumbnails, plays all three formats (Media Session reports each as playing), reloads and plays again from the kept handle, plays files chosen through the input and finds them in search.
