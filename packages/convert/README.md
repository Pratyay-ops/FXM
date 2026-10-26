# @fxm/convert

Conversion and tagging (stage 4.2): saving a download in the format the user picks, with tags, cover art and lyrics, through FXM's own LGPL ffmpeg core ([`tools/ffmpeg-wasm`](../../tools/ffmpeg-wasm/README.md)) in a worker. A download is stored as the original bytes of its stream (stage 4.1, [`@fxm/downloads`](../downloads/README.md)) and plays offline from those; only the copy saved to the device is converted.

| Piece | What it is |
|---|---|
| `planExport`, `exportChoices`, `exportLabel` | What saving a download in a format takes (extract, remux or re-encode, which tag writer) and the honest label of each format, from core's `describeConversion` |
| `exportAudio` | The pipeline: mp4box.js extraction, the core, the tag writers. Runs in the worker |
| `createConverter` | The page's side of the worker: a queue of jobs, progress, cancellation |
| `serveConversions` (`@fxm/convert/worker`) | The worker's side: loads the core on first use and answers jobs |
| `loadFfmpegCore`, `createCore` | Loads the core from the site, checks it and runs it |
| `demuxMp4Audio`, `writeM4a` | MP4 audio: the AAC track of YouTube's itag 18 or of a fragmented M4A, read with mp4box.js and written as a plain M4A with iTunes tags |
| `writeMp3Tags`, `writeFlacTags`, `writeOggTags`, `writeWavTags` | The tag writers |
| `tagsFromTrack`, `fetchCover` | The tags of a track: metadata, lyrics, and its cover as JPEG or PNG bytes |
| `DeviceSaver`, `createBrowserDeviceSaver` | "Save to device": the interface each platform implements, and the browser's |
| `exportFileName` | "Artist - Title.ext", safe on every file system |

## Formats and labels

The formats are core's `DOWNLOAD_FORMATS`: Original, FLAC, ALAC, WAV, MP3, AAC and Opus. Each choice says what it really is (`exportLabel`, from `describeConversion`), and YouTube's audio, Opus or AAC, is never called lossless:

| Saving Opus from YouTube as | Label | How |
|---|---|---|
| Original | Original (Opus) | The WebM remuxed by the core with its tags (no re-encoding) |
| FLAC, ALAC, WAV | FLAC (converted from Opus, same quality as the source) | Decoded and encoded losslessly: a bigger file, not a better one |
| MP3, AAC | MP3 (converted from Opus, some quality loss) | MP3 at the download setting's bitrate (320 kbps by default), AAC at 256 kbps |
| Opus | Opus (no conversion) | Remuxed into an `.opus` (Ogg) file, the same packets |

A real lossless source (FLAC from Internet Archive or Jamendo) keeps its depth: a 24-bit FLAC becomes a 24-bit ALAC or WAV, labelled "lossless". Opus is encoded at 160 kbps, FLAC at FFmpeg's compression level 5.

**YouTube's itag 18** is a 360p video. Its AAC track is extracted with mp4box.js (BSD-3-Clause), never ffmpeg, and only the audio is written: Spotube's issue #3085, where downloads came out as video files, is the trap avoided. Its labels say where the audio came from: "Original (AAC from 360p video)", "MP3 (converted from AAC from 360p video, some quality loss)".

## Tags

Every saved file gets the same information in its format's own fields; a file whose structure FXM can't edit (a WAV whose sizes were never fixed, FLAC inside Ogg) is saved without tags rather than not at all (`tagged: false`).

| | MP3 | FLAC | Ogg Opus, Vorbis | M4A (AAC, ALAC) | WAV | WebM (Original only) |
|---|---|---|---|---|---|---|
| Written by | FXM, ID3v2.3, UTF-16 | FXM, Vorbis comments | FXM, Vorbis comments | FXM, iTunes atoms | FXM, LIST/INFO and an `id3 ` chunk | The core's muxer, Matroska tags |
| Title, artists, album | TIT2, TPE1, TALB | TITLE, ARTIST (one each), ALBUM | the same | ©nam, ©ART, ©alb | INAM, IART, IPRD (+ ID3) | TITLE, ARTIST, ALBUM |
| Track, disc, date | TRCK, TPOS, TYER | TRACKNUMBER, DISCNUMBER, DATE | the same | trkn, disk, ©day | ITRK, ICRD (+ ID3) | PART_NUMBER, DATE |
| ISRC | TSRC | ISRC | ISRC | `----:com.apple.iTunes:ISRC` | ID3 | ISRC |
| Lyrics | USLT, and SYLT when synced | LYRICS | LYRICS | ©lyr | ID3 | LYRICS |
| Cover | APIC (front cover) | PICTURE block | METADATA_BLOCK_PICTURE | covr | ID3 | none (WebM has no place for it) |

Earlier tags are replaced, not merged, so a source's stale title never outlives the new one; the audio is left byte for byte (the Ogg writer renumbers and re-checksums the pages after the new comment header). ID3v2.3 with UTF-16 text is what the widest range of players and file managers read. Lyrics come from LRCLIB (stage 1.8); synced lyrics also go into MP3's SYLT frame, and the other formats get their plain text, having no standard field for timings. Covers are the track's largest artwork, fetched with the platform's `fetch` (the web app's policy lets the app, not the embed, fetch from YouTube's and Spotify's image hosts) and kept only as JPEG or PNG: WebP is converted through a canvas where the browser can, or left out.

The format facts come from the public specifications: ID3v2.3 (id3.org), the FLAC format, RFC 3533 (Ogg) and RFC 7845 (Ogg Opus), the Vorbis I specification, ISO/IEC 14496-12 and -14 with Apple's iTunes metadata atoms, and Microsoft's RIFF INFO list.

## The worker and the core

```ts
import { createConverter } from '@fxm/convert'

const converter = createConverter({
  createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  coreBase: new URL(`${import.meta.env.BASE_URL}ffmpeg/`, location.href).href,
})
const { blob, tagged } = await converter.exportAudio(
  { input, source: record.format, format: 'flac', tags },
  { onProgress, signal },
)
```

```ts
// worker.ts
import { serveConversions } from '@fxm/convert/worker'
serveConversions(globalThis as never)
```

- **Jobs run one at a time**, in order. Cancelling a queued job removes it; cancelling the running one terminates the worker (the core can't be interrupted mid-conversion), and the next job starts a fresh one. A worker that crashes fails only its job.
- **The core loads on the first job that needs it.** Saving an MP3 original, a FLAC as FLAC or an M4A as M4A doesn't: FXM's own writers do it. The worker fetches `ffmpeg-core.json`, then `ffmpeg-core.wasm`, and checks the wasm's SHA-256 against the manifest (once more past the HTTP cache if it doesn't match), imports `ffmpeg-core.js` and refuses a core whose libraries don't report an LGPL licence. Both files are fetched with a version query from the manifest, so a cached old file never pairs with a new one.
- **Files reach the core without copies**: in a worker, the stored `Blob` is mounted with Emscripten's WORKERFS and read as needed; in Node, the bytes go into its memory file system.
- **A core that failed to load** is tried again on the next job; one that ran out of memory or crashed is replaced.
- **Errors** reach the page as `ConvertError` codes: `core-unavailable`, `unsupported-input`, `corrupt-input`, `out-of-memory`, `cancelled`, `failed`.

The app's policy (`/app/*`, stage 2.8) allows `'wasm-unsafe-eval'` for this worker, and never `'unsafe-eval'`: the core's glue is built without `eval`.

## Save to device

Saving takes two steps, because converting takes time and browsers open their file picker only straight from a click:

```ts
const target = await saver.choose({ fileName, mimeType, description }) // from the click
if (target) await target.write(blob) // after the conversion
```

`createBrowserDeviceSaver()` uses the File System Access API's save picker where the browser has one (Chromium on desktop: the user picks the folder and the name) and otherwise downloads the file through a temporary link. The desktop app (stage 7.4) and the Android app (6.4) implement `DeviceSaver` themselves (a native save dialog, the device's music library) and hand it to the web app with `setDeviceSaver` (apps/web/src/features/downloads/save).

## Testing

`@fxm/convert/testing` has audio the tests generate (sine waves and silence in WAV and MP3, and FLAC, Ogg Opus, Ogg Vorbis, M4A, fragmented M4A and itag 18 files with real structure and filler audio: never real recordings), readers that check tags independently of the writers, `FakeFfmpegCore` (answers each job with a generated file of its container) and `createInProcessConverter` (the pipeline without the worker, for app tests).

The tests run offline in Node. `core.wasm.test.ts` runs the real core on every format, decodes the results back and reads their tags; it needs a built core, so it runs only with `FXM_FFMPEG_CORE_DIR` set: `make ffmpeg-wasm-test`, and CI's ffmpeg-wasm job.
