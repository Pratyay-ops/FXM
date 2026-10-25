# The embeddable mini-player (stage 5.2)

An `<iframe>` player for a track, an album or a playlist, served from FXM's site at `/embed/…` so that any website can show it. It plays YouTube through FXM Connect when the visitor has it, otherwise through the experimental Lite tier, otherwise free sources, with an install hint for what needs YouTube. Like the rest of FXM it runs entirely in the visitor's browser: FXM hosts static files only.

The app's share dialog (`src/features/share/`) writes the code:

```html
<iframe title="FXM player: Pablo Honey" src="https://fxmusic.pages.dev/embed/album/ytm:MPREb_…" width="100%" height="380" style="border:0;border-radius:12px" allow="autoplay" loading="lazy"></iframe>
```

## Addresses

`https://fxmusic.pages.dev/embed/<kind>/<source>:<native ID>?<options>` (`target.ts`):

- `<kind>`: `track`, `album` or `playlist`. Artists have no embed.
- `<source>:<native ID>`: the entity as the app's pages name it (`/album/ytm:MPREb_…`), with the native ID percent-encoded, so an Internet Archive track (`<identifier>/<file>`) stays one segment. The sources are `ytm`, `yt`, `archive` and `jamendo`: local files live on one device, plugins aren't loaded in embeds, and Spotify needs FXM Connect plus the matching engine.
- Options, each optional; a value the player doesn't know falls back to the default, so a typo never breaks a player:

| Option | Values | Default |
|---|---|---|
| `layout` | `card`: the artwork, the controls with a seek bar and, for albums and playlists, the track list; `compact`: one 80 px row | `card` |
| `theme` | `auto` (the visitor's light or dark setting), `dark`, `light` | `auto` |
| `mode` | `music` (songs only) or `all` (Music + Video). The share dialog uses the app's catalog mode | `music` |
| `origin` | The serialized origin (`https://example.com`, exactly as `URL.origin` writes it) of the only page allowed to use the postMessage API. With it, the player also announces itself to that page unprompted | none |

The iframe heights the layouts are designed for are in `EMBED_HEIGHTS`: 80 px for `compact`, 232 px for a track's card and 380 px for an album's or a playlist's. The player fills whatever size it gets.

"Open in FXM" (the FXM mark) and the install hint open the app or the landing page's "Get FXM" section on the embed's own origin, in a new tab.

## Where it plays

The player creates the platform of `@fxm/platform` as the app does, and its tier decides what plays (`controller.ts`):

| Tier | YouTube Music and YouTube | Internet Archive, Jamendo |
|---|---|---|
| Full (FXM Connect) | Plays, with the end-of-file probe where bytes are readable | Plays |
| Lite (no install, experimental) | Plays: InnerTube calls go through the sandbox document, nested inside the player, and the media element's first request is the probe (stage 2.3) | Plays |
| Free only | The install hint: "FXM can't reach YouTube Music in this browser. Add the free FXM Connect extension, or get the FXM app" | Plays |

- **Lite inside other sites.** The player frames `/sandbox/innertube.html` with `sandbox="allow-scripts"`, as the app does. The sandbox documents set no `frame-ancestors`, so they load inside a player inside any page, and their messages check only the player (their parent, at FXM's origin). The Lite self-test runs only for YouTube content, so a free-source player costs no InnerTube call.
- **FXM Connect inside other sites.** Its header rules apply to the player's requests (they are scoped to the requests' initiator, FXM's origin), but its content script is declared with `all_frames: false`, so it doesn't mark a player framed by another page, and the player can't detect it there: it uses Lite. Opened at top level, the player detects Connect and uses it. The fix belongs to the extension (see "Not yet").
- **Catalog mode.** A song plays in both modes. In Music mode, an official video plays as the song it links (`Track.songId`); one without a link needs the matching engine (a `matcher`, not wired in yet), and the mode hides other videos. A single video that can't play says "This is a video, and this player plays songs only"; an album or a playlist leaves such tracks out.
- **Autoplay.** The player never starts by itself. A click in it plays; the embedding page can ask it to play through the API, which browsers allow when the iframe has `allow="autoplay"` (the share dialog's code has it) and the page itself has had a user gesture.

## The postMessage API (protocol 1)

The page that embeds a player can control it and follow what it plays (`api.ts`).

```js
const player = document.querySelector('iframe').contentWindow
const FXM = 'https://fxmusic.pages.dev'
addEventListener('message', (event) => {
  if (event.origin !== FXM || event.source !== player) return
  if (event.data.type === 'fxm-embed:ready') console.log('Ready', event.data.embed, event.data.state)
  if (event.data.type === 'fxm-embed:state') console.log(event.data.state.status)
})
document.querySelector('iframe').addEventListener('load', () => {
  player.postMessage({ type: 'fxm-embed:hello', protocol: 1 }, FXM)
})
// Later, from a click on the page:
player.postMessage({ type: 'fxm-embed:command', command: 'play' }, FXM)
```

**Pairing.** The player answers only the window that embeds it, and only one origin: the origin of the page's first `fxm-embed:hello`, or, when the address has an `origin` parameter, that origin alone. It ignores messages from any other window (a sibling frame, a popup) or origin, and pages with an opaque origin, which it could answer only by posting to `'*'`. Commands sent before the pairing are ignored; a malformed message still gets an error, posted to the origin that sent it. Opened at top level, the player has no API.

**Page → player:**

| Message | Fields | Does |
|---|---|---|
| `{ type: 'fxm-embed:hello', protocol: 1 }` | nothing else | Pairs; the player answers `ready` once its content has loaded |
| `{ type: 'fxm-embed:command', command, … }` | `protocol: 1` and `id` (a string of up to 64 `[A-Za-z0-9_.:-]`, or a non-negative integer, echoed in errors) are optional | Runs the command |

| `command` | Parameters | |
|---|---|---|
| `play` | `index`: optional, a whole number below `trackCount` | Resumes, or plays that track from its start |
| `pause`, `toggle`, `next`, `previous` | none | |
| `seek` | `positionMs`: 0 to 86,400,000 | Jumps within the current track |
| `setVolume` | `volume`: 0 to 1 | |
| `setMuted` | `muted`: a boolean | |
| `getState` | none | Answers with `state` |

Any other field, a value of the wrong type or out of range, gets an error. `pause`, `setVolume`, `setMuted` and `getState` work at any time; the others answer `not-ready` until the content has loaded, or when it can't play here.

**Player → page** (posted to the paired origin only):

| Message | Fields |
|---|---|
| `fxm-embed:ready` | `embed: { kind, id, title, trackCount }` (`title` is `null` when the content couldn't load) and `state` |
| `fxm-embed:state` | `state`, whenever anything but the position changes, and the position at most once a second while playing (at once after a seek) |
| `fxm-embed:error` | `code` (`bad-request`, `unsupported`, `rate-limited`, `not-ready`), plus the `id` and `command` when known |

`state` is `{ status, buffering, index, trackCount, positionMs, durationMs, volume, muted, track }`: `status` is `preparing` (loading its content), `unavailable` (it can't play its content here), `idle` (ready, not started), `loading`, `playing`, `paused`, `ended` or `error`; `track` is `{ id, title, artists }` or `null`. Every message carries `protocol: 1`.

**What a page can't learn or do.** The API reports only what the player shows. It never says which tier the visitor is in, so a site can't use a player to find out whether its visitors have FXM Connect. Commands that start resolving a track (`play` with an `index`, `next`, `previous`, and `play` or `toggle` from a player that hasn't started, has ended or has failed) are limited to 10 a minute, so a page can't use a player to spend its visitor's YouTube request budget. The player never answers its own message types, so a page that echoes messages back can't start a loop.

## Security and privacy

- **Framing.** `/embed/*` is the only part of FXM that other sites may frame; `/app/*` keeps `frame-ancestors 'none'`. Nothing in the player acts on the visitor's account or data: its actions are playback and links that open new tabs.
- **Storage.** In another site's iframe, browsers partition the player's storage by that site, so the request budget (1.2) and the "Connect was seen" memory are kept per embedding site, not shared with the app. Each embedding site's players share one budget of 600 calls an hour.
- **The sandbox frame.** A page that embeds the player can navigate the player's sandbox frame to a document of its own before the frame's handshake, and then read or answer the player's InnerTube requests ([the sandbox README](../../../../packages/platform/src/sandbox/README.md#the-protocol) explains this inherent gap). The worst it can do is make that player show or play something else, which the page could do anyway.
- **Referrer.** The player's page sends `Referrer-Policy: no-referrer` (a `<meta>` here; the deploy also sends the header), so googlevideo sees no Referer.

## Headers (stage 2.8)

The deploy serves the build of `vite.embed.config.ts` at `/embed/`, with the app's policy minus `frame-ancestors` (`appPolicy({ embeddable: true })` in 2.8). The player needs nothing more than the app:

- no inline script (`script-src 'self'` suffices; the app's theme-script hash is harmless), and styles from its own files;
- `frame-src 'self'` for the sandbox documents at `/sandbox/`;
- the app's `img-src`, `media-src` and `connect-src` hosts: it contacts no new service;
- the single-page fallback: every `/embed/…` path serves `index.html` (2.8 copies it to `embed/404.html`).

The browser tests serve the player with exactly that policy and check that it reports no violation.

## Layout

| Path | What |
|---|---|
| `../../embed/`, `../../vite.embed.config.ts` | The embed's page (`index.html`) and entry (`main.ts`), and its build: root `embed/`, base `/embed/`, output `dist-embed/` |
| `main.tsx` | Reads the address, applies the theme, creates the controller, renders and starts the API |
| `target.ts` | Addresses: building and reading them, the layouts, themes and heights |
| `controller.ts` | `EmbedController`: the platform, the catalog, the player and the stream lifecycle |
| `catalog.ts` | `EmbedCatalog` over `@fxm/core`'s metadata providers |
| `api.ts` | The postMessage API |
| `view.ts` | The view model the layouts render, also for the share dialog's preview |
| `components/` | The two layouts and their parts |
| `embed-app.tsx`, `theme.ts`, `embed.css` | The React root, the theme and the styles |
| `integration.ts` | The touch-points with stages that hadn't merged (below) |
| `testing/` | Fakes for the unit tests, and the test doubles of the browser tests' build |

## Touch-points with other stages

Stage 5.2 started before 1.3, 1.4 and 1.6 were in its base (an early start). Everything it needs from them comes through `integration.ts`, behind interfaces the tests already drive with fakes. Until they are wired in, a built player says it can't play its content here.

| Touch-point | Stage | Wire in |
|---|---|---|
| YouTube Music and YouTube metadata | 1.3 | `createYouTubeProviders()`'s `music` and `video` in `createProviderCatalog([…])` |
| Internet Archive and Jamendo metadata and credits | 1.6 | `createArchiveSource()`, `createJamendoSource()` and their attribution |
| YouTube streams | 1.4 | The ladder as the `ytm` `StreamSource`; `withBudgetPriority` (in `controller.ts`) gives it the budget priority the lifecycle asks for |
| Free-source streams | 1.6 | `fromAudioSource(archive)`, `fromAudioSource(jamendo)` |
| Songs for unlinked official videos | 1.7 | A `TrackMatcher` (optional) |
| Lite's kill switch and self-test request | 1.3's config | `embedPlatformOptions()`, `embedSandboxOptions()` |
| The `/embed/*` header rule and the build | 2.8 | `embedPart.build()` runs `vite build -c vite.embed.config.ts --sourcemap hidden --outDir <dir>` in `apps/web` |

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/embed apps/web/src/features/share   # unit tests (part of make test)
scripts/run.sh pnpm --filter @fxm/web e2e:embed                                  # browser tests, Chromium and Firefox
FXM_SCREENSHOTS=1 scripts/run.sh pnpm --filter @fxm/web e2e:embed                # also screenshots, in apps/web/screenshots/embed/
```

- **Unit tests** run the controller with the real player and stream lifecycle against fakes: the fake platform (`testing/fake-platform.ts`), fixture providers, the player's fake engine and fake stream sources shaped like 1.4's ladder and 1.6's sources. They cover the tiers, the install hint, Connect appearing, free sources, the catalog mode, the Lite probe's fallback to itag 18, failures and retries, notices, prefetching at its budget priority, every API message and parameter, pairing, the rate limit, the views and the share dialog.
- **Browser tests** (`../../e2e/embed/`, not part of `make test`) build the player with `--mode e2e`, which swaps in test doubles (`testing/e2e-services.ts`): fixture metadata, and a YouTube "ladder" that resolves through the real platform with one `/player` call per rung. Two local origins serve the pages: FXM's site (`fxmusic.pages.dev`, port 6330, with 2.8's header rules) and another site (`music-blog.example`, port 6331) whose page frames the player and drives its API. A services mock (port 6332) answers as InnerTube and googlevideo did when measured, and a proxy (port 6333) routes the host names; nothing reaches the internet. `FXM_EMBED_E2E_PORT` moves all four.

| Done-when and checks | Test |
|---|---|
| It plays in Lite inside a test page on another origin | `plays in Lite inside a page on another origin`: the player pairs with the page, a click plays, the position moves; every InnerTube call came from the sandbox's opaque origin (`Origin: null`, `text/plain`); the capped top-rung URL failed its first request and itag 18 played; media requests carry no Referer; no page reached another host; no policy violation under the app's policy minus `frame-ancestors` |
| The postMessage API | `answers the page that embeds it, and only that page`; `announces itself only to the origin its address names` |
| Free sources plus an install hint | `plays free sources and shows the install hint without Lite`: InnerTube refuses opaque origins, so the self-test fails; a YouTube song shows the hint, an Internet Archive track plays with its credits and frames no sandbox |
| Albums, the catalog mode, both layouts, framing | `plays an album from its track list`, `plays a video only in Music + Video mode`, `comes in a compact layout, light or dark`, `frames the player on any site but never the app` |

**Test record.** The browser tests passed on 2026-10-26 on macOS 15.5 (arm64) with Playwright 1.64.0's Chromium 156.0.8078.4 and Firefox 157.0, headless (8 of 8 in each). Safari is not tested.

## Not yet

- **FXM Connect inside other sites:** the extension needs a content-script entry for `https://fxmusic.pages.dev/embed/*` with `all_frames: true` (its bridge already refuses frames).
- **Wiring the real providers** (above) once 1.3, 1.4 and 1.6 are in the player's base, and the build in 2.8's `embedPart`. youtubei.js loads lazily in its own chunk (about 800 KB, 1.3's README), which a YouTube player then loads too.
- **Spotify** tracks, albums and playlists: they need FXM Connect, the Spotify provider (1.5) and the matching engine.
- **Long playlists** play their first page.
- **The site's `AVAILABLE.embed`** stays off until a deployed player plays real songs.
