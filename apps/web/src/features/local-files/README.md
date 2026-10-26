# Local files

Music files on the user's device, in the web app (stage 4.4): a folder the browser keeps access to, or files chosen through a file input; tags and covers read with [music-metadata](https://github.com/Borewit/music-metadata); songs listed in the Library's **Local files** tab and in search ("On this device"), and played through the player core from object URLs. Nothing is uploaded: FXM reads the files where they are.

## How the files get in

| | Chromium on desktop (Chrome, Edge, Brave, Opera) | Every other browser, and the apps' webviews |
|---|---|---|
| Button | **Add a folder** (File System Access API) | **Choose a folder** (`<input webkitdirectory>`) and **Choose files**; only **Choose music files** where a file input can't pick folders (`canChooseFolders`: iOS, for one) |
| After a reload | The folder stays. FXM keeps its handle in IndexedDB and checks the permission; when the browser wants to ask again, the folder shows **Allow access**, and playing one of its songs asks too. Chrome's "Allow on every visit" skips the question. A folder the user refused shows **Choose folder again** (the browser doesn't ask twice; picking it grants access anew) | The browser forgets the files: the folder shows **Choose again**, its songs say so and stay out of queues. Choosing it again (same name) brings its songs back with their IDs |
| Changes on disk | Scanned again once per visit when readable, and with **Scan for changes**. A scan the user stopped isn't started again in that visit | Picked up when the folder is chosen again |
| Moved or deleted | The folder shows **Find folder**: the folder picked becomes this one, and its songs keep their IDs where the paths inside match | |

**Choose files** exists everywhere, also in Chromium, for single files: they play until the page reloads and are listed under "Chosen files". Where folders can't be chosen, the folder input takes several music files instead (`multiple`, `accept`).

A folder already added, picked again, is scanned for changes instead of being added twice. A folder inside one already added is refused ("already part of …"). A folder that holds folders added before replaces them at once: their songs move into it by path (`repo.adoptRoot`, one transaction), with their IDs and without being read again, so a scan stopped halfway still leaves one list.

**Scans run one at a time** (`lane.ts`); another waits as `queued` ("Waiting to scan…"). A scan hands out new IDs from those in use when it starts, so two scans at once could give two folders of the same name the same ID; one at a time also keeps the page responsive when several folders are scanned at the start of a visit. A file that can't be read (changed or locked while the scan reads it) or a subfolder that can't be listed is left out, and the scan goes on; the songs of that subfolder stay listed. Until the walk has found every file, the progress bar moves without a total ("Read 12 files…"), then it fills up ("Reading files: 12 of 340").

**On phones** (below 640 px) the folders fold into one line ("Music · 8 songs · updated just now") that opens them, **Add music** is one menu button, Shuffle and Sort are icons and the filter opens from a button, so the first songs show on the first screen; a folder that needs the user always shows in full, its buttons on a line under its text.

## Formats

FXM lists files by extension (`AUDIO_EXTENSIONS` in `format.ts`) and then by what the tag reader finds inside:

| Format | Extensions | Labelled |
|---|---|---|
| FLAC (also in Ogg) | `.flac`, `.oga`, `.ogg` | **Lossless**, with bit depth and sample rate |
| ALAC in MP4 | `.m4a`, `.mp4` | **Lossless** (Chromium and Firefox can't play it: see below) |
| WAV (PCM, integer or float, also WAVE_FORMAT_EXTENSIBLE) | `.wav` | **Lossless**, with bit depth and sample rate |
| MP3 | `.mp3` | Lossy, with bitrate |
| AAC in MP4 | `.m4a`, `.mp4` | Lossy |
| Opus, Vorbis in Ogg or WebM | `.opus`, `.ogg`, `.oga`, `.webm`, `.weba` | Lossy |

**FLAC, ALAC and WAV are labelled lossless, nothing else is.** The tier comes from the codec through `tierOf` in `@fxm/core`, never from the tag reader's own `lossless` flag, which also says yes to formats browsers can't play (Monkey's Audio, WavPack, DSD, AIFF). Those, video files, raw `.aac` (ADTS), Matroska audio and files whose codec doesn't fit their container are left out and counted on the folder ("3 files can't be played here").

**Nor is a file converted from lossy audio.** FXM's Save to device writes `FXM_SOURCE_CODEC` (and `FXM_SOURCE_BITRATE` when known) into every file it makes by re-encoding lossy audio, a FLAC from YouTube's Opus say, in the format's own free-form field (`@fxm/convert`). The reader looks for it in Vorbis comments, ID3 `TXXX` frames, iTunes freeform atoms and Matroska tags, whatever the case of the name (`convertedFromTags`), and believes only a lossy codec and a sensible bitrate. Such a file keeps its codec and its container, but gets its source's tier (`convertedTier`: the lower of the two, so never lossless) and `format.convertedFrom`: its row says "From Opus" where a lossless file says "Lossless", its quality reads "FLAC · converted from Opus", and its stream carries the source, so Now playing's badge reads "FLAC from Opus · Your files" with its source's quality, also when the file plays as the offline copy of the song it was saved from (by its ISRC). Reader version 3 learned it, so files listed before are read again on the next scan.

**Extensible WAVs.** ffmpeg and most other tools write the `fmt ` chunk of any WAV above 16-bit or 48 kHz, or with more than two channels, as WAVE_FORMAT_EXTENSIBLE (format tag 0xFFFE). music-metadata 12.1.1 has no name for that tag and reports the codec as `non-PCM (65534)` (checked 2026-10-26). `readTags` then reads the chunk itself (`waveFormatChunk`, a few bytes per RIFF chunk) and takes the format from its SubFormat GUID (`waveSubFormat`): `00000001-0000-0010-8000-00aa00389b71` is PCM, `00000003-…` IEEE float, anything else (Ambisonics, compressed audio) stays unplayable. The bit depth is the GUID's valid bits (24 for 24-bit audio stored in 32-bit samples). The layout is Microsoft's `WAVEFORMATEXTENSIBLE` structure (mmreg.h / ksmedia.h). Chromium 156 played such a 24-bit, 96 kHz file in an `<audio>` element on 2026-10-26.

**What the browser can play** is asked the way the direct audio engine asks it, with `canPlayType` (`formatSupport` in `player.ts`). A file of a format the browser refuses is listed with **Can't play here** and is kept out of queues; on 2026-10-26 Chromium 156 answered `''` to `audio/mp4; codecs="alac"` and `probably` to FLAC, MP3, AAC, Opus and Vorbis. Safari plays ALAC.

**Songs that can't play now** (`blockedRootsOf` in `root-status.ts`): those of chosen files the browser forgot, of a folder the user refused and of a folder that is gone. Their rows say so with a lock badge ("Choose again", "Missing"), a click on Play says what to do instead of playing, and Play, Shuffle, Play next and Add to queue leave them out; when nothing else can play, the button that fixes it ("Choose “Tunes” again") takes Play's place. A folder that only needs asking again isn't one of them: a click on Play asks. Such rows keep their text at full contrast (WCAG AA): only the cover fades and the title turns muted, never the whole row.

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
| `scanner.ts` | `scanRoot`: one scan of one root (the walk ahead of the reading, unchanged files skipped, moved files keep their IDs, batched writes, files that fail left out, cancel) |
| `lane.ts` | `SerialLane`: runs the scans, and the pruning of unused covers, one at a time |
| `local-files.ts` | The facade (`getLocalFiles()`): adding, scanning, access, statuses, opening a file to play |
| `root-status.ts` | What the UI says about roots: status lines, which need the user, whose songs can't play now, what a scan found |
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

- **Moved or renamed files** within a root keep their ID when a scan finds a new file with the same size, length, title, artists and album as one that disappeared. The files of folders a bigger folder replaces move into it by path, IDs and all.
- **A folder found again** (**Find folder** after it moved, or **Choose folder again**) keeps its root, so its files keep their IDs where the paths inside it are the same.
- **Collisions** with an ID a moved file kept are avoided by mixing in a counter.
- **Chosen single files** are filed under `<size>/<name>`, so two different files of one name never share an ID.

Albums are `local:album:<hash of album artist and album>` and artists `local:artist:<hash of the name>`, normalized with `normalizeText`, so an album's tracks group together across folders. The album artist is the tag, else "Various artists" for a compilation, else the first artist.

## Tags and covers

`readTags` reads only what it needs through `Blob.slice` (headers and tags, never the whole file) and bounds what a damaged file can make it allocate (music-metadata 12.1.1). The parser is picked by extension; when that finds nothing playable, by content, for a file whose extension lies. Tags are trimmed and capped at 500 characters; a file without a title gets one from its name ("01 - Song.flac" is "Song", track 1; "99 Luftballons" and "1979" keep their numbers). music-metadata stops after an Ogg file's first pages, so the length of Opus, Vorbis and Ogg FLAC files is read from the granule position of the last page ([RFC 3533](https://www.rfc-editor.org/rfc/rfc3533), [RFC 7845](https://www.rfc-editor.org/rfc/rfc7845) for Opus's 48 kHz and pre-skip).

**Loudness** (stage 8.1): the ReplayGain tags (`REPLAYGAIN_TRACK_GAIN` and `_PEAK`, and the album pair), which music-metadata finds in ID3, MP4, Vorbis and APE tags, and for Opus files the R128 gains (`R128_TRACK_GAIN`, `R128_ALBUM_GAIN`, [RFC 7845](https://www.rfc-editor.org/rfc/rfc7845) §5.2.1) first, become the file's `tags.loudness` (`loudnessOfTags`), which its stream carries: loudness normalization plays the song at the user's level, and turns a quiet song up as far as its peak allows. The gains are read from the tags' own text with `parseReplayGainDb` (`-7.89 dB`, `-7.89dB`, `-7,89 dB` and a bare `-7.89` alike), in Vorbis comments, APE tags, ID3 `TXXX` frames and iTunes freeform atoms, whatever the case of their names; music-metadata's own reading, which drops `-7.89dB` and reads `-7,89 dB` as -7 dB, serves only for other tag formats. Reader version 2 learned them, so files listed before are read again on the next scan.

A cover is the file's embedded picture (the front cover), else its folder's `cover`, `folder`, `front`, `album`, `albumart` or `albumartsmall` image (`.jpg`, `.jpeg`, `.png`, `.webp`). Each image is thumbnailed once, keyed by its length and a hash of its ends and a sample of its middle, however many tracks share it: at most 128 px, WebP (JPEG where the browser can't encode WebP), as a `data:` URL of a few kilobytes. A `data:` URL works wherever a track goes (the library, the queue, the system media controls, a backup) and survives reloads, where an object URL wouldn't. A folder image added later covers the files that had none on the next scan.

Thumbnails no file uses any more are deleted (`repo.prunePictures`) only when no scan runs or waits: a scan stores a thumbnail before it writes the records that use it. A file whose thumbnail is missing anyway is read again on the next scan, so its cover comes back.

The lists read every file with a live query, and every write makes them load and sort them all again. So a scan writes its first records within 750 ms (the first songs show up), then every 3 seconds or 1,000 records, and the sorts compare each artist's and album's place in collation order, worked out once per sort, instead of calling the collator several times per comparison.

## Playing

`streamFor(nativeId)` opens the file (asking for access when needed, which works because playing starts from a click) and returns a `StreamOption`: a `blob:` URL, `progressive`, `media: 'audio'`, `ipBound: false`, `fullLength: 'verified'` (the whole file is on the device), the codec, container, bitrate, sample rate, bit depth, tier and loudness. A `blob:` URL is the page's own, so the equalizer always processes local files (stage 8.1, through the app's player). The object URL of an unchanged file is reused; the 16 most recent stay alive (the current track, the preloaded one, prefetches) and older ones are revoked. A revoked URL still in use fails like any broken stream, and the player resolves the track again.

Failures are `FxmError`s the player knows what to do with: a file gone from disk is `NotFound` (skip it); chosen files forgotten after a reload are `Unavailable` (skip: nothing in a queue can bring them back, so one of them doesn't stop a playlist); a folder FXM may not read is `AuthRequired` (stop until the user allows it: one click allows the whole folder); a format the engine refuses is `Unavailable` (skip). Their messages say what to do, and the list shows them as a toast. The lists keep songs that can't play now out of queues in the first place.

## Until other stages merge

Built while the stages below were in progress, behind one seam each. All three have merged into `develop` since:

- **The app's player (2.5): wired.** Local files play through the app's one player (`getLocalPlayer()` is `getPlayer()` from `features/now-playing/playback.ts`, `subscribeLocalPlayer` its `subscribePlayer`), which the player bars, Now playing and the system media controls show. The composition root (`src/app/services`, stage 2.9) connects the app's policy with `withLocalFilesFirst(…)` in front of it, so local files resolve to their object URLs and never reach the stream lifecycle or the network; where the music services don't run, the stand-in it connects plays local files too. Tests put the app's player on a fake engine with `configureLocalPlayer`.
- **The playback policy (2.3): wired** (stage 2.9b). The composition root makes `createLocalAudioSource()`'s ISRC match an offline copy (ARCHITECTURE §7.4, `src/app/services/offline.ts`), after the downloads: a catalog track with an ISRC that one of the user's files is tagged with plays from that file, perhaps in FLAC. A file that can't be read now (a folder that needs the user's permission again) is skipped, and the track streams.
- **Search (2.4): wired** (2.9b). `createLocalMetadataProvider()` is registered with the app's sources (source `local`, "This device") while the user has added music (a live query of the folders), so search offers it as a source only then, and its album and artist pages work for local albums and artists. The search page shows `LocalSearchSection` above another source's results, not while "This device" is the source itself, which would list the songs twice. Local songs are on the device already: the catalog's menus offer no download for them (`itemFeatures`), only the equalizer.

## Tests

Everything runs offline in happy-dom with tiny files generated in code (`testing/audio-files.ts`): silence or no audio at all, so no recording is involved. The tag tests parse real WAV (also extensible, 24-bit and float), FLAC, MP3, M4A (ALAC and AAC) and Ogg Opus files through music-metadata. The scanner and facade tests use fake folder handles that grant, refuse and ask, files that move, change, disappear or fail while read, and scans held back to show what waits for what; `reloadTestLocalFiles` starts the next visit over the same database, as after a reload.

`e2e/local-files.spec.ts` (Playwright, not part of `make check`; the fixture is in `e2e/local-files-fixture.ts`) runs the real thing in Chromium: the folder picker returns a folder of the origin-private file system, a real `FileSystemDirectoryHandle`, filled with generated FLAC, MP3 and WAV files; it checks the tags, the lossless labels and the cover thumbnails, plays all three formats (Media Session reports each as playing), reloads and plays again from the kept handle, plays files chosen through the input and finds them in search. On phones it checks that the first song shows above the mini player at 320 × 720 and 375 × 667 with the selected tab in view, and, with `FileSystemHandle.prototype.queryPermission` stubbed to answer `prompt`, that a folder that needs access keeps at least 200 px for its text at 320 px.

`pnpm --filter @fxm/web screenshots` also captures the tab (empty, with songs, one playing, a folder that needs access) and "On this device" at 320, 768 and 1280 px in both themes, as `screenshots/local-files-*.png` (`e2e/local-files-screenshots.spec.ts`).
