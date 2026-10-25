# Internet Archive (`archive`)

Free audio from the [Internet Archive](https://archive.org), FLAC first: a `MetadataProvider` for search, tracks and albums, and an `AudioSource` whose streams are the items' files. It works in any browser without FXM Connect, and on every platform through the injected `ctx.fetch`.

```ts
import { createArchiveSource } from '@fxm/sources/archive'

const archive = createArchiveSource()            // one per app: it caches
const { albums, tracks } = await archive.search('nine inch nails ghosts', { types: ['album', 'track'] }, ctx)
const [candidate] = await archive.match(track, ctx) // an Archive track, or any other source's
const options = await archive.resolve(candidate, ctx, prefs) // FLAC first
const credit = await archive.attribution(formatId('archive', 'track', candidate.ref), ctx)
```

The module exports only `createArchiveSource` with its types, `parseTrackRef` and `itemPageUrl`.

## What it requests

| Request | When | Cached |
|---|---|---|
| `GET /advancedsearch.php?q=…&fl[]=…&sort[]=downloads desc&rows=…&page=…&output=json` | `search`, and `match` for another source's track | 10 minutes |
| `GET /metadata/<identifier>` | Opening an item: song search (4 items at a time), `getTrack`, `getAlbum`, `match` (the first 3 items), `resolve`, `attribution` | 1 hour, one request shared by every caller |
| `GET /download/<identifier>/<file>` with `Range: bytes=0-41` | `resolve` with `readFlacHeader: true`, once per FLAC file | 1 hour |

Requests send no headers of their own and no credentials, so a browser never needs a CORS preflight; the header read's single range header (`bytes=0-41`, with a start) is CORS-safelisted.

**The search query** keeps the user's words to letters and digits, lower-cased, so nothing typed can change its structure:

```
mediatype:(audio OR etree) AND format:flac AND NOT access-restricted-item:true AND (nine inch nails ghosts)
```

`etree` is the Live Music Archive's media type: concert recordings, mostly in FLAC. Results come most downloaded first. `sort: 'relevance'` leaves the order to the Archive, which for the query above ranked two concert recordings first and left the canonical album out of its top five. `match` adds alternatives, of which one must also match, because the Archive indexes items, not files: `(nine inch nails) AND ((1 ghosts i) OR (ghosts i iv))` finds a song by its title or by its album's name.

**Song search** opens the first 4 items (`trackSearchItems`) and lists their tracks that fit every word of the query, `limit` (50 by default) at a time. The next pages go through the rest of those items' tracks first, with cursors such as `1.50` (page of items 1, after 50 tracks), and then open the next 4 items (cursor `2`), so every fitting track appears exactly once. Album cursors are plain page numbers; a song cursor is refused (`RangeError`) for albums, as is any cursor this source never made.

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

Every option is `progressive`, `media: 'audio'`, `ipBound: false`, never expires, and has a plain `https://archive.org/download/…` URL. `fullLength` is `unverified` because nothing probed the end of the file, not because the bytes are unreadable: the Archive does not cap its URLs, and a page can read every byte (CORS `*`). So the download manager (4.1), which downloads only probed URLs, can run its end-of-file probe on the option it picks: the bytes are readable on every tier, and a single range with a start (`bytes=<n>-`) needs no preflight.

**Sample rate and bit depth.** The Archive's metadata states neither. With `readFlacHeader: true`, `resolve` reads each FLAC file's header, its first 42 bytes (the STREAMINFO block), for both, e.g. 44,100 Hz and 16 bits for the known item below. Without it, only `24bit Flac` gives a depth. Reading the start of a file says nothing about `fullLength`.

## Matching another source's track

`match` answers an Archive track, or a track whose `externalIds.archive` names an Archive file, with that file at confidence 1, without a request. For any other track it searches by main artist and by title or album, opens the first three items and scores their recordings with a provisional score: 0.40 title, 0.35 artist and 0.25 duration, minus the version and duration penalties of the matching engine's scorer (ARCHITECTURE.md §12). Candidates below 0.60, the floor of the Suggest band, are left out: a concert recording of a studio song loses 0.45 for its live tag and lands there. `signals` carry `releaseId` (the item), `releaseYear`, `sourceAlbumMatch` (the track's album has the item's title) and `isrcVerified`.

- **Version tags come from the title's qualifiers and the album, on both sides**, as in the matching engine: the candidate's album is the item's title, and live, unplugged, concert, tour and session count as one family. So a Spotify track of the album "Live Through This" matches the Archive item "Live Through This" (both say live), a Live Music Archive item (`etree`) counts as live whatever its title, and concert recordings are searched only for a track that is live by its title or its album ("MTV Unplugged in New York").
- **Equal ISRCs are not enough.** An Archive file's ISRC comes from an uploader's `urn:isrc:` tag, which may be copied onto every file of an item, and ISRCs are shared by unrelated tracks (memo §6.1). A file with the track's ISRC is ISRC-verified, at confidence 1, only when it also passes the ISRC gate's checks: title similarity at least 0.8 (the matching engine's default), artist similarity at least 0.5, a duration within max(5 s, 2 %) of the track's (when the track has one), and no strong version tag on one side only. Otherwise it keeps its text score, with `isrc conflict (…)` in its evidence naming the failed checks.
- **`track.isrc` counts as a catalog ISRC**: the source's own, or MusicBrainz's exact path. Never put an ISRC there that a fuzzy MusicBrainz search suggested (`origin: 'musicbrainz-fuzzy'`): it is only a ranking hint.

**What the playback policy (2.3) may do with these candidates.** A text-only candidate is capped at 0.79, below the Auto band, and is at most a suggestion: nothing re-scores it on its way to the player (the matching engine, 1.7, reads YouTube Music pages only), and the provisional score only resembles the engine's. Only `signals.isrcVerified` may play without asking ("prefer lossless", ARCHITECTURE.md §7.4 step 4). Once 1.7 is merged, these candidates should be scored with its scorer.

## Licences and credit

Archive items carry their own licence, often Creative Commons or public domain. `attribution(trackId, ctx)` returns what crediting a track takes: its title and artists, `provider: 'Internet Archive'`, the item's page (`pageUrl`, the same as `itemPageUrl(identifier)`, which shows the licence) and the licence's URL when the item states one. For a candidate, pass `formatId('archive', 'track', candidate.ref)`. It costs no request for an item already loaded.

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
| A cursor this source never made, or a song cursor for albums | `RangeError` |

A song search skips an item that fails to load instead of failing.

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

The live smoke test resolves the known item `nineinchnails_ghosts_I_IV` to its FLAC original, reads its header and checks CORS, in about ten requests:

```sh
FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/archive/live.test.ts
```
