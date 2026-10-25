# @fxm/sources

Provider implementations, one folder per source, each imported by path:

```ts
import { fetchWithTimeout } from '@fxm/sources/shared'
// later: '@fxm/sources/youtube', '@fxm/sources/jiosaavn', '@fxm/sources/archive', …
```

The wildcard `exports` entry (`./*` → `./src/*/index.ts`) means a new provider never edits a shared index file, so parallel stages don't conflict.

**Rules**

- Only `fetch` and web-standard APIs. The same code must run in Cloudflare Workers (the gateway), the Android WebView, browsers and Node. The `tsconfig.json` loads the `webworker` library, so `document` and `window` are type errors.
- Never call the global `fetch`: take it as a parameter (see `shared/fetchWithTimeout`), because each platform injects its own.
- Tests run offline against recorded, sanitized fixtures. Live checks run only with `FXM_LIVE=1`.

See [ARCHITECTURE.md §7.3](../../docs/ARCHITECTURE.md#73-runtime-agnostic-providers).

## YouTube Music and YouTube (`youtube/`)

Two metadata providers on one shared session, built on [youtubei.js](https://github.com/LuanRT/YouTube.js) (MIT) and the injected `ctx.fetch`:

| Provider | Source | What it does |
|---|---|---|
| `createYouTubeMusicProvider()` | `ytm` | YouTube Music: search (songs, videos, albums, artists, playlists) with cursors, suggestions, tracks, albums, artists, playlists, and a paged radio (`RecommendationProvider`) |
| `createYouTubeProvider()` | `yt` | Plain YouTube for Music + Video mode: video, channel and playlist search, videos, channels and playlists. Every track is a `video`; there are no songs or albums |

```ts
import { createYouTubeProviders } from '@fxm/sources/youtube'

const { music, video } = createYouTubeProviders({ visitorDataStore }) // one visitorData for both
const { tracks } = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
const radio = await music.radioPage(tracks.items[0], {}, ctx) // then { cursor: radio.nextCursor }
```

Both providers reject with an `Unsupported` `FxmError`, before any request, when `ctx.capabilities.youtube` is `none`. Stream resolution is stage 1.4; it gets a youtubei.js `Innertube` with the same request shape from `session.innertube(ctx)`.

### Request shape

Every InnerTube request is CORS-simple on every platform and tier, because the Lite tier's sandboxed document can make no other kind:

- `POST https://<host>/youtubei/v1/<endpoint>?prettyPrint=false`, only to `search`, `browse`, `next`, `player` and `music/get_search_suggestions` (any other endpoint is refused);
- the JSON body as a string with `Content-Type: text/plain;charset=UTF-8` and no other header: no `X-Goog-*`, `X-YouTube-*` or `Content-Type: application/json`;
- `context.client` holds only the client name and version from the config, `hl`, `gl` and the visitorData;
- `credentials: 'omit'`.

youtubei.js builds each request (endpoint and payload) and sends it through a `fetch` adapter (`request.ts`) that rewrites it into this shape and calls `ctx.fetch`. youtubei.js's own session data (a random user agent, a desktop browser's context, a locally generated visitorData) never leaves the device. Each call gets its own lightweight `Innertube`, bound to that call's `ctx`; creating one makes no request. Stage 1.2 adds a generic `toSimpleInnerTubeRequest()` to `@fxm/platform`; this module's version can then use it.

FXM parses the raw JSON itself (`parse/`) instead of youtubei.js's node classes, which drop what classification and bylines need: `OFFICIAL_SOURCE_MUSIC`, the page type of every byline run, and the credits links of album rows.

### visitorData

Only ever server-issued, since locally generated sessions hit bot checks 3 times in 4:

- **`full` tier** (FXM Connect, desktop, Android, Node): read once from `https://www.youtube.com/sw.js_data`.
- **`simple` tier**, or when `sw.js_data` can't be read: the first InnerTube request goes without one and YouTube's answer issues it (`responseContext.visitorData`). Requests that start meanwhile wait, so the device keeps one session.

It is cached in memory and persisted through an optional `VisitorDataStore` (`load`, `save`, `clear`). A bot check drops it, so the next request gets a fresh one.

### Config

`youtube-config.json` holds the client names, versions and hosts (`WEB_REMIX` on `music.youtube.com`, `WEB` on `www.youtube.com`), the search filter `params`, the radio `params` and the English labels that help read unlinked byline words. It has a `schema` and an increasing `revision`. `parseYouTubeConfig()` validates every field and refuses any host outside `INNERTUBE_HOSTS`, which lives in code so no config can extend it. `pickYouTubeConfig(candidate, current)` takes a newer valid config (one fetched from the static site, say) and otherwise keeps the current one and says why. Signature checks come in stage 1.13.

### Classification and modes

| `musicVideoType` | Kind |
|---|---|
| `ATV` | `song` |
| `OMV`, `OFFICIAL_SOURCE_MUSIC` | `music-video` |
| `UGC`, missing, unknown | `video` |
| podcast types | `episode` |

Plain YouTube's results are always `video`. Every list goes through `applyModeFilter` (radio through `filterPlayable`), and search sends songs only to `tracks` and videos only to `videos`, which is an empty page, with no request, in Music mode.

**Bylines** are read by the page type each run links to (artist or channel, album), and a duration, a year and counts by their text, never by position. Unlinked words name the artists only when no run links one, minus item type labels such as `Song` or `Single`.

**Albums.** In Music mode an album's tracks come from its audio playlist (`browse VL` + `OLAK5uy_…`): anonymous album pages may list a song's official video instead of the song, and `next` over that playlist returns the videos too. In Music + Video mode the album page's own rows are the tracks, and an official video in them links its song (`Track.songId`). The link comes from the row's "View song credits" item (`MPTC<videoId of the song>`) or, failing that, from the same position of the audio playlist. Search and `next` never carry these links, so the provider never infers one from them.

**Radio** is `next` with `RDAMVM<videoId>` and the config's `params`. In Music mode it starts from a song, an official video's linked song included, and keeps only songs; any other seed is refused with `Unsupported`, because radio from a video plays videos. An artist's radio starts from the Mix button of the artist page. `radioPage` returns one page at a time (about 50 tracks) without repeats across pages, and `radio` returns the first page.

**IDs and artwork** follow the core's canonical forms (videoId, `MPREb_…`, `UC…`, playlistId without `VL`). Artwork lists the thumbnails' sizes, plus a 544 px version of a small square Google image. `hl` and `gl` come from `ctx.locale` and `ctx.region`; without a region YouTube uses the IP address's.

### Errors

| What YouTube does | `FxmError` |
|---|---|
| 429, or 503 with `Retry-After` | `RateLimited`, with `retryAfterMs` |
| `LOGIN_REQUIRED`, "Sign in to confirm you're not a bot", Google's bot check page | `BotCheck` (and the visitorData is dropped) |
| 404, 410, an empty page for an unknown album or video, 400 for a request naming an entity, a malformed ID or cursor | `NotFound` |
| 400 for a search, an answer that is not JSON or has an unexpected shape | `Parse` |
| 401 / 403 | `AuthRequired` / `Unsupported` |
| A failed request, a timeout (20 s by default), 5xx | `Network` |

The caller's own cancellation is rethrown as it is.

### Requests per call

A search is one request per type, a continuation one more. A track, artist, playlist page or suggestions is one request. An album is one request in Music + Video mode and two in Music mode (its page and its audio playlist). A radio page is one request; an artist's radio adds the artist page. The first call of a session in the `full` tier adds one `sw.js_data` request.

### Tests

Offline tests replay real responses recorded on 2026-10-25 UTC (`youtube/fixtures/`) through a fake InnerTube behind `ctx.fetch`. `fixtures/sanitize.ts` removes IP addresses, visitorData, tracking and logging fields, menus other than the credits link, and long texts before a fixture is written, and a test checks every fixture for leftovers. To record them again (27 requests, from a residential connection):

```sh
FXM_LIVE=1 FXM_RECORD=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/fixtures/record -u
make format
```

The live smoke test (8 requests) searches "Radiohead Creep" from Node in the CORS-simple shape, loads two radio pages, reads Pablo Honey through its audio playlist and checks `sw.js_data`:

```sh
FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/live.test.ts
```
