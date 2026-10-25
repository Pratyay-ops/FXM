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
- The oldest engines to support are Safari 16 (iOS 16, where only the free sources play) and the system WebKit of macOS 11, the desktop app's minimum. They lack `AbortSignal.any` (Safari 17.4), and Safari before 16 lacks `AbortSignal.timeout`, so use `fetchWithTimeout`, which falls back to a timer, instead of calling them.
- Tests run offline against recorded, sanitized fixtures. Live checks run only with `FXM_LIVE=1`.

See [ARCHITECTURE.md §7.3](../../docs/ARCHITECTURE.md#73-runtime-agnostic-providers).

## YouTube Music and YouTube (`youtube/`)

Two metadata providers on one shared session, built on [youtubei.js](https://github.com/LuanRT/YouTube.js) (MIT) and the injected `ctx.fetch`:

| Provider | Source | What it does |
|---|---|---|
| `createYouTubeMusicProvider()` | `ytm` | YouTube Music: search (songs, videos, albums, artists, playlists) with cursors, suggestions, tracks, albums, artists, playlists, a paged radio (`RecommendationProvider`), the top result of an unfiltered search (`topResult`) and a video's description (`getDescription`) |
| `createYouTubeVideoProvider()` | `yt` | Plain YouTube, for Music + Video mode: video, channel and playlist search, videos, channels, playlists and descriptions. Every track is a `video`; there are no songs or albums, and in Music mode its searches answer empty pages without a request |

```ts
import { createYouTubeProviders } from '@fxm/sources/youtube'

const { music, video } = createYouTubeProviders({ visitorDataStore }) // one visitorData for both
const { tracks } = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
const radio = await music.radioPage(tracks.items[0], {}, ctx) // then { cursor: radio.nextCursor }
```

The factories take either the device's `session` (to share one visitorData) or the options to create one, not both. Both providers reject with an `Unsupported` `FxmError`, before any request, when `ctx.capabilities.youtube` is `none`. Stream resolution, on the same session, is `createYouTubeAudioSource()` in [`youtube/stream/`](src/youtube/stream/README.md).

`@fxm/sources/youtube` exports the consumer API: the factories, the provider and session types, the config API and the classification helpers. The request plumbing (`request.ts`, `visitor.ts`, `errors.ts`) stays inside the folder, where the stream resolver of stage 1.4 imports it directly: `session.innertube(ctx)` gives a youtubei.js `Innertube` with the same request shape, and code that sends its own requests shapes them with `toSimpleInnerTubeRequest` and takes the visitorData with `leaseVisitorData(session, ctx)`.

Every protocol fact this code relies on is recorded, with its source and date, in the [YouTube clean-room log](src/youtube/CLEAN-ROOM.md).

### Request shape

Every InnerTube request is CORS-simple on every platform and tier, because the Lite tier's sandboxed document can make no other kind:

- `POST https://<host>/youtubei/v1/<endpoint>?prettyPrint=false`, only to `search`, `browse`, `next`, `player` and `music/get_search_suggestions` (any other endpoint is refused);
- the JSON body as a string with `Content-Type: text/plain;charset=UTF-8` and no other header: no `X-Goog-*`, `X-YouTube-*` or `Content-Type: application/json`;
- `context.client` holds the client name and version, `hl`, `gl` and the visitorData;
- `credentials: 'omit'`.

youtubei.js builds each request (endpoint and payload) and sends it through a `fetch` adapter (`request.ts`) that rewrites it into this shape and calls `ctx.fetch`. For the config's clients (`WEB_REMIX`, `WEB`), which every provider call uses, `context.client` holds only the fields above, so youtubei.js's own session data (a random user agent, a desktop browser's context, a locally generated visitorData) never leaves the device. For a client the config does not list, such as a stream client, a request keeps the client fields of its payload, minus youtubei.js's session fields; one that youtubei.js built through `session.innertube(ctx)` therefore carries youtubei.js's user agent and operating system fields.

Each call gets its own lightweight `Innertube`, bound to that call's `ctx`; creating one makes no request. youtubei.js itself is loaded on the first call that needs it, so a bundler puts it in a chunk of its own (about 800 KB minified) instead of the app's first bundle (the providers are about 60 KB). Every request has a deadline (20 s by default) that holds even when a transport ignores `AbortSignal`. Stage 1.2 adds a generic `toSimpleInnerTubeRequest()` to `@fxm/platform`; this module's shaper also knows the config's clients, and the two can converge once 1.2 has merged.

FXM parses the raw JSON itself (`parse/`) instead of youtubei.js's node classes, which drop what classification and bylines need: `OFFICIAL_SOURCE_MUSIC`, the page type of every byline run, and the credits links of album rows.

### visitorData

Only ever server-issued, since locally generated sessions hit bot checks 3 times in 4:

- **`full` tier** (FXM Connect, desktop, Android, Node): read once from `https://www.youtube.com/sw.js_data`.
- **`simple` tier**, or when `sw.js_data` can't be read: the first InnerTube request goes without one and YouTube's answer issues it (`responseContext.visitorData`). Requests that start meanwhile wait for it, so the device keeps one session; they wait at most one request timeout, after which the next request asks too.

It is cached in memory and persisted through an optional `VisitorDataStore` (`load`, `save`, `clear`); a store that takes longer than 1.5 s to load is passed over. A bot check drops the visitorData that the request sent, so the next request gets a fresh one, while a newer one that another request got meanwhile is kept. `session.visitorData` shows the value in use and can drop it (`invalidate()`), for a "reset" setting.

### Config

`youtube-config.json` holds the client names, versions and hosts (`WEB_REMIX` on `music.youtube.com`, `WEB` on `www.youtube.com`), the search filter `params` (as YouTube's own filter chips and filter dialog send them), the radio `params`, the kill switches (`killSwitches.lite` turns the experimental Lite tier off; `@fxm/platform` reads it) and, by language, the labels that help read unlinked byline words (`labels.en`; a language without labels of its own reads with the English ones). It has a `schema` and an increasing `revision`. `parseYouTubeConfig()` validates every field and refuses any host outside `INNERTUBE_HOSTS`, which lives in code so no config can extend it; it ignores fields it does not know, such as the stream ladder's `streams` section, which stage 1.4 reads. `pickYouTubeConfig(candidate, current)` takes a newer valid config (one fetched from the static site, say) and otherwise keeps the current one and says why. Signature checks come in stage 1.13.

### Classification and modes

| `musicVideoType` | Kind |
|---|---|
| `ATV` | `song` |
| `OMV`, `OFFICIAL_SOURCE_MUSIC` | `music-video` |
| `UGC`, missing, unknown | `video` |
| podcast types | `episode` |

Plain YouTube's results are always `video`. Every list goes through `applyModeFilter` (radio through `filterPlayable`), and search sends songs only to `tracks` and videos only to `videos`, which is an empty page, with no request, in Music mode. A page is cut to its `limit` before the mode filter, so it may hold fewer items than the limit, or none, and still have a `nextCursor`: only a missing `nextCursor` ends a list.

**Bylines** are read by the page type each run links to (artist or channel, album), and a duration, a year and counts by their text, never by position. Unlinked words name the artists only when no run links one, minus item type labels such as `Song` or `Single`.

**Albums.** In Music mode an album's tracks come from its audio playlist (`browse VL` + `OLAK5uy_…`): anonymous album pages may list a song's official video instead of the song, and `next` over that playlist returns the videos too. In Music + Video mode the album page's own rows are the tracks, and an official video in them links its song (`Track.songId`). The link comes from the row's "View song credits" item (`MPTC<videoId of the song>`) or, failing that, from the same position of the audio playlist. Search and `next` never carry these links, so the provider never infers one from them. When the audio playlist can't be read, the album page's rows stand in for it (its credits links still apply); a bot check or a rate limit still fails the album.

**Radio** is `next` with `RDAMVM<videoId>` and the config's `params`. In Music mode it starts from a song (an official video's linked song, or another source's track through its YouTube Music song, `externalIds.ytm`) and keeps only songs; any other seed is refused with `Unsupported`, because radio from a video plays videos. An artist's radio starts from the Mix button of the artist page. `radioPage` returns one YouTube page at a time (about 50 tracks), or `limit` of them, with the rest on the next page; pages never return the seed or a track of the last 200 they returned. A cursor belongs to its seed and catalog mode. `radio` returns the first page.

**Top result and descriptions** serve the matching engine (stage 1.7). `topResult(query)` reads the card above the results of an unfiltered YouTube Music search (a track, album, artist or playlist; a track the mode hides is none). `getDescription(id)` reads the text under a video on plain YouTube's watch page, such as a song's "Provided to YouTube by …" with its label, ℗ line and release date.

**IDs and artwork** follow the core's canonical forms (videoId, `MPREb_…`, `UC…`, playlistId without `VL`). Artwork lists the thumbnails' sizes, plus a 544 px version of a small square Google image. `hl` and `gl` come from `ctx.locale` and `ctx.region`; without a region YouTube uses the IP address's.

### Errors

| What YouTube does | `FxmError` |
|---|---|
| 429, or 503 with `Retry-After` | `RateLimited`, with `retryAfterMs` |
| "Sign in to confirm you're not a bot" (in a playability status, error screen or alert), `LOGIN_REQUIRED` without a reason, Google's bot check page | `BotCheck` (and the visitorData the request sent is dropped) |
| `LOGIN_REQUIRED` for an age-restricted or private video | No error: the answer goes to the caller (only `player` answers have one) |
| An empty page for an unknown album, video, playlist or channel (YouTube answers them with HTTP 200), a 400 `INVALID_ARGUMENT` for a request that names only an ID, a malformed YouTube ID or cursor | `NotFound` |
| Any other 4xx but the ones below, such as the 404 `NOT_FOUND` that an unknown client version gets; an answer that is not JSON or has an unexpected shape | `Parse`: YouTube refused the request, and the config may need an update |
| Another source's ID, an ID of another kind, an album asked of `yt` | `Unsupported` |
| 401 / 403 | `AuthRequired` / `Unsupported` |
| A failed request, a timeout (20 s by default, also when the transport ignores aborts), 408, 5xx | `Network` |

The caller's own cancellation is rethrown as it is; an abort the caller did not ask for is a timeout.

### Requests per call

A search is one request per type, a continuation one more. A YouTube page that a `limit` splits is read once: each provider keeps the last 8 such pages for 10 minutes, so the pages that slice it cost no further request (searches, playlists and radio alike); without a `limit`, or with one as large as a YouTube page, nothing is kept. A track, artist, playlist page, suggestions, a top result or a description is one request. An album is one request in Music + Video mode and two in Music mode (its page and its audio playlist). A radio page is one request; an artist's radio adds the artist page. The first call of a session in the `full` tier adds one `sw.js_data` request. `yt` makes none for a search in Music mode.

### Tests

Offline tests replay real responses recorded on 2026-10-25 UTC, and two more on 2026-10-26 (`youtube/fixtures/`), through a fake InnerTube behind `ctx.fetch`. `fixtures/sanitize.ts` removes IP addresses in every form (IPv4, IPv6 also compressed, percent-encoded, `ip=` parameters), visitorData, tracking and logging fields, comments, menus other than the credits link, and long texts before a fixture is written, and a test checks every fixture for leftovers. To record them again (29 requests, from a residential connection; `-t "<test name>"` records one group):

```sh
FXM_LIVE=1 FXM_RECORD=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/fixtures/record -u
make format
```

The live smoke test (8 requests) searches "Radiohead Creep" from Node in the CORS-simple shape, loads two radio pages, reads Pablo Honey through its audio playlist and checks `sw.js_data`:

```sh
FXM_LIVE=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/live.test.ts
```
