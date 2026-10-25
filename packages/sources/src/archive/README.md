# Internet Archive (`archive`)

Free audio from the [Internet Archive](https://archive.org), FLAC first: a `MetadataProvider` for search, tracks and albums, and an `AudioSource` whose streams are the items' files. It works in any browser without FXM Connect, and on every platform through the injected `ctx.fetch`.

```ts
import { createArchiveSource } from '@fxm/sources/archive'

const archive = createArchiveSource()            // one per app: it caches
const { albums, tracks } = await archive.search('nine inch nails ghosts', { types: ['album', 'track'] }, ctx)
const [candidate] = await archive.match(track, ctx) // an Archive track, or any other source's
const options = await archive.resolve(candidate, ctx, prefs) // FLAC first
```

## What it requests

| Request | When | Cached |
|---|---|---|
| `GET /advancedsearch.php?q=…&fl[]=…&sort[]=downloads desc&rows=…&page=…&output=json` | `search`, and `match` for another source's track | 10 minutes |
| `GET /metadata/<identifier>` | Opening an item: song search (the first 4 items), `getTrack`, `getAlbum`, `match` (the first 3 items), `resolve` | 1 hour, one request shared by every caller |
| `GET /download/<identifier>/<file>` with `Range: bytes=0-41` | `resolve` with `probeFlac: true`, once per FLAC file | no |

Requests send no headers of their own and no credentials, so a browser never needs a CORS preflight; the probe's single range header is CORS-safelisted.

**The search query** keeps the user's words to letters and digits, lower-cased, so nothing typed can change its structure:

```
mediatype:(audio OR etree) AND format:flac AND NOT access-restricted-item:true AND (nine inch nails ghosts)
```

`etree` is the Live Music Archive's media type: concert recordings, mostly in FLAC. Results come most downloaded first. `sort: 'relevance'` leaves the order to the Archive, which for the query above ranked two concert recordings first and left the canonical album out of its top five. `match` adds alternatives, of which one must also match, because the Archive indexes items, not files: `(nine inch nails) AND ((1 ghosts i) OR (ghosts i iv))` finds a song by its title or by its album's name.

## CORS (measured 2026-10-25)

| URL | Answer to a request with `Origin: https://fxm-music.pages.dev` |
|---|---|
| `archive.org/advancedsearch.php` | 200, `Access-Control-Allow-Origin: *` |
| `archive.org/metadata/<identifier>` | 200, `Access-Control-Allow-Origin: *` (`{}` for an unknown item) |
| `archive.org/download/<identifier>/<file>` | 302 to `ia<n>.us.archive.org/…`, `Access-Control-Allow-Origin: *` |
| `ia<n>.us.archive.org/<dir>/<file>` | 206 for a range, `Access-Control-Allow-Origin: *` (plus `Access-Control-Allow-Credentials: true`, harmless since FXM never sends credentials). No `Access-Control-Expose-Headers`, so a page can read the body and `Content-Length` but not `Content-Range` |
| `archive.org/services/img/<identifier>` | 200, the item tile (an image, so no CORS needed) |

After the cross-origin redirect a browser sends `Origin: null`, which `*` also allows. So everything works in a plain page: search, metadata, playback through `<audio src>`, downloads and the equalizer (the bytes are readable).

## Only freely accessible items

The Archive marks lending-library and stream-only items with `access-restricted-item` (for example the Grateful Dead's soundboard recordings, whose FLAC files are private). Searches leave them out, and `getTrack`, `getAlbum` and `resolve` reject them with `Unavailable`. A file marked `private` is never offered; a recording whose only playable files are private is left out.

## Tracks and albums

- **An album is an item**: `archive:album:<identifier>`, with the item's title, creators, date and artwork (an uploaded `cover`, `folder` or `front` image, largest first, then the item tile).
- **A track is a recording**: one audio file and every file the Archive derived from it (its `original` field, chains followed). If the uploader sent a second original of the same recording, such as a 320 kbps MP3 next to the FLAC (same title tag, track number and disc, lengths within 2 s), it joins the better one. The group's original names the track: `archive:track:<identifier>/<file path>`, the canonical form from `@fxm/core`. `getTrack` also accepts the path of any other file of the recording and answers with the canonical ID.
- Titles, artists, track numbers and lengths come from the files' tags, falling back to the item's creators and to the file name. An ISRC is read from a file's `urn:isrc:` external identifier when there is one.
- Every track is a `song`, so it shows and plays in Music mode, like any non-YouTube track (the owner's decision).
- There are no artist pages or playlists: `getArtist` and `getPlaylist` reject with `Unsupported`.

## Streams

`resolve` returns every playable file of the track, best first by `compareStreams`, with the download format's codec first among equals:

| Archive format | Codec, container | Tier |
|---|---|---|
| `Flac`, `24bit Flac` | FLAC | `lossless`; `24bit Flac` states `bitDepth: 24` |
| `Apple Lossless Audio` | ALAC, `m4a` | `lossless` |
| `WAVE` | PCM, `wav` | `lossless` |
| `VBR MP3`, `320Kbps MP3`, `128Kbps MP3`, `64Kbps MP3`, … | MP3 | by `tierOf`: 320 `high`, VBR (about 160–210) `normal`, 64 `low` |
| `Ogg Vorbis` | Vorbis, `ogg` | by `tierOf` (about 80–100 kbps: `normal` or `low`) |

An unknown format name falls back to the extension (`.flac`, `.mp3`, `.ogg`, `.opus`, `.wav`, `.m4a`). Shorten, AIFF, zips, playlists, images and text never become streams. The bitrate is the Archive's own figure for MP3s, the format name's (`320Kbps`), or size × 8 ÷ length.

Every option is `progressive`, `media: 'audio'`, `ipBound: false`, never expires, and has a plain `https://archive.org/download/…` URL. `fullLength` is `unverified`: the Archive does not cap its URLs, and nothing probed the end of the file.

**Sample rate and bit depth.** The Archive's metadata states neither. With `probeFlac: true`, `resolve` reads each FLAC file's first 42 bytes (its STREAMINFO block) for both, e.g. 44,100 Hz and 16 bits for the known item below. Without the probe, only `24bit Flac` gives a depth.

## Matching another source's track

`match` answers an Archive track, or a track whose `externalIds.archive` names an Archive file, with that file at confidence 1, without a request. For any other track it searches by main artist and by title or album (concert recordings only when the track itself is live), opens the first three items and scores their recordings with a provisional score: 0.40 title, 0.35 artist and 0.25 duration, minus the version and duration penalties of the matching engine's scorer (ARCHITECTURE.md §12). A text-only score is capped at 0.79, below the Auto band, because the matching engine scores every candidate itself before anything plays; equal ISRCs give 1. Candidates below 0.60, the floor of the Suggest band, are left out: a concert recording of a studio song loses 0.45 for its live tag and lands there. `signals` carry `releaseId` (the item), `releaseYear`, `sourceAlbumMatch` (the track's album has the item's title) and `isrcVerified`.

## Errors

| Situation | `FxmError` code |
|---|---|
| Unknown item (`{}`), withdrawn ("dark") item, file not in the item, malformed track ID | `NotFound` |
| Restricted item | `Unavailable` |
| HTTP 429 | `RateLimited`, with `Retry-After` |
| Other HTTP errors | `Unavailable` (404 and 410: `NotFound`) |
| Unreachable, timed out (15 s by default) | `Network` |
| An answer that is not what the API documents | `Parse` |
| A candidate from another source | `Unsupported` |

A song search skips an item that fails to load instead of failing.

## Licences and credit

Archive items carry their own licence (`ArchiveItem.licenseUrl`, often Creative Commons or public domain). `itemPageUrl(identifier)` links to the item's page, which shows it: the link for crediting an item.

## Tests

Offline tests use responses recorded on 2026-10-25 and sanitized in `fixtures/`: uploader e-mail addresses, reviews, reviewer and updater names and curation notes removed, file hashes and timestamps dropped, and file lists trimmed to a few recordings.

| Fixture | What |
|---|---|
| `search-nin-ghosts.json` | The search for "nine inch nails ghosts", most downloaded first |
| `search-match-nin.json` | A `match` search with alternatives |
| `item-nin-ghosts.json` | Nine Inch Nails, "Ghosts I - IV" (CC BY-NC-SA 3.0): FLAC and 320 kbps MP3 originals plus derivatives, a cover |
| `item-tuning-77.json` | A `24bit Flac` original and a separately numbered MP3 original of the same recording |
| `item-restricted.json` | A stream-only Grateful Dead soundboard recording: restricted, with private FLAC files |
| `item-missing.json` | The API's answer for an unknown item |

The live smoke test resolves the known item `nineinchnails_ghosts_I_IV` to its FLAC original, probes it and checks CORS, in about ten requests:

```sh
FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/archive/live.test.ts
```
