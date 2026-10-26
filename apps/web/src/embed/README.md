# The embeddable mini-player (stage 5.2)

An `<iframe>` player for a track, an album or a playlist, served from FXM's site at `/embed/…` so that any website can show it. It plays YouTube through FXM Connect when the visitor has it, otherwise through the experimental Lite tier, otherwise free sources, with an install hint for what needs YouTube. Like the rest of FXM it runs entirely in the visitor's browser: FXM hosts static files only.

The app's share dialog (`src/features/share/`), which the "Share" entry of an album's or a playlist's "More options" menu opens, writes the code:

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

"Open in FXM" (the FXM mark) and the install hint open the app or the landing page's "Get FXM" section on the embed's own origin, in a new tab. Albums and playlists open their page in the app; a track, which has no page of its own, opens the app's search for its title and artist (`/app/search?q=…`), or the app's home while its title isn't known.

Opened as a page of its own (the share dialog's "Copy player link"), the player sits centred on the page at the size its layout is designed for. In another site's iframe it fills the frame and draws a hairline edge, so a light player stands out on a white page.

## Where it plays

The player creates the platform of `@fxm/platform` as the app does, and its tier decides what plays (`controller.ts`). It does so only for content its providers can load (`WIRED_SOURCES` in `wired.ts`): for anything else it says it can't play the content here without creating the platform, so it contacts no service, runs no Lite self-test and looks for no FXM Connect.

| Tier | YouTube Music and YouTube | Internet Archive, Jamendo |
|---|---|---|
| Full (FXM Connect) | Plays, with the end-of-file probe where bytes are readable | Plays |
| Lite (no install, experimental) | Plays: InnerTube calls go through the sandbox document, nested inside the player, and the media element's first request is the probe (stage 2.3) | Plays |
| Free only | The install hint: "FXM can't reach YouTube Music in this browser. Add the free FXM Connect extension" (", or get the FXM app" once the desktop or Android app is out, `RELEASED`) | Plays |

- **Lite inside other sites.** The player frames `/sandbox/innertube.html` with `sandbox="allow-scripts"`, as the app does. The sandbox documents set no `frame-ancestors`, so they load inside a player inside any page, and their messages check only the player (their parent, at FXM's origin). The Lite self-test runs only for YouTube content, so a free-source player costs no InnerTube call. Its remote kill switch is the YouTube config's: the one the build ships with until YouTube's code has loaded, then the config in use, which a newer signed config from FXM's site replaces (stage 1.13), so the owner can switch Lite off for players on every site.
- **FXM Connect inside other sites.** Its header rules apply to the player's requests (they are scoped to the requests' initiator, FXM's origin), but its content script is declared with `all_frames: false`, so it doesn't mark a player framed by another page, and the player can't detect it there: it uses Lite. Opened at top level, the player detects Connect and uses it. That is deliberate for now: see "Not yet" for why turning it on in frames would let sites tell whether their visitors have Connect.
- **Catalog mode.** A song plays in both modes. In Music mode, an official video plays as the song it links (`Track.songId`); for one without a link the app's matching engine looks for its song on YouTube Music (loaded with the first such video; Auto stays off, so only a song it is sure of plays), and the mode hides other videos. A single video that can't play says "This is a video, and this player plays songs only"; an album or a playlist leaves such tracks out.
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

**Visibility.** Commands that start or skip playback (`play`, `toggle` from a player that isn't playing, `next` and `previous`) run only while the player is visible (`visibility.ts`); otherwise they answer `not-visible`. Visible means: at least half of the player inside the page's viewport, a frame of at least 200 × 80 CSS pixels, and, in Chromium (IntersectionObserver v2), nothing covering it and no ancestor making it transparent, filtering it or transforming it beyond moving it. Firefox and Safari can't tell the last part. So a site can't run the player as a hidden engine behind its own buttons. `pause`, `seek`, `setVolume`, `setMuted` and `getState` work regardless, and so does the visitor's own click in the player.

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

Any other field, a value of the wrong type or out of range, gets an error. `pause`, `setVolume`, `setMuted` and `getState` work at any time; the others answer `not-ready` until the content has loaded, or when it can't play here, and those that start or skip playback answer `not-visible` while the player is hidden (above).

**Player → page** (posted to the paired origin only):

| Message | Fields |
|---|---|
| `fxm-embed:ready` | `embed: { kind, id, title, trackCount }` (`title` is `null` when the content couldn't load) and `state` |
| `fxm-embed:state` | `state`, whenever anything but the position changes, and the position at most once a second while playing (at once after a seek) |
| `fxm-embed:error` | `code` (`bad-request`, `unsupported`, `rate-limited`, `not-ready`, `not-visible`), plus the `id` and `command` when known |

`state` is `{ status, buffering, index, trackCount, positionMs, durationMs, volume, muted, track }`: `status` is `preparing` (loading its content), `unavailable` (it can't play its content here), `idle` (ready, not started), `loading`, `playing`, `paused`, `ended` or `error`; `track` is `{ id, title, artists }` or `null`. Every message carries `protocol: 1`.

**What a page can't learn or do.** The API's messages report only what the player shows; none of them names the tier. A page can also see a little of the player itself: how many frames it has, since `window.length` is readable across origins, and the player frames the sandbox document only without FXM Connect. Inside another site the player never sees Connect (above), so that count doesn't depend on it. Opened at top level, where it would, the deploy's `Cross-Origin-Opener-Policy: same-origin` cuts the player off from the page that opened it, which then sees a closed window with no frames (the browser tests check this). Commands that start resolving a track (`play` with an `index`, `next`, `previous`, and `play` or `toggle` from a player that hasn't started, has ended or has failed) are limited to 10 a minute, so a page can't use a player to spend its visitor's YouTube request budget; a refusal for visibility costs no slot. The player never answers its own message types, so a page that echoes messages back can't start a loop.

## Security and privacy

- **Framing.** `/embed/*` is the only part of FXM that other sites may frame; `/app/*` keeps `frame-ancestors 'none'`. Nothing in the player acts on the visitor's account or data: its actions are playback and links that open new tabs.
- **Opener.** `/embed/*` sends `Cross-Origin-Opener-Policy: same-origin`, so a page that opens the player in a popup or a new tab can't reach it (see "What a page can't learn or do"). Browsers ignore the header in frames, so embedding works as before.
- **Storage.** In another site's iframe, browsers partition the player's storage by that site, so the request budget (1.2) and the "Connect was seen" memory are kept per embedding site, not shared with the app. Each embedding site's players share one budget of 600 calls an hour.
- **The sandbox frame.** A page that embeds the player can try to navigate the player's sandbox frame to a document of its own before the frame's handshake. Browsers check that navigation against the player's own `frame-src 'self'`, whoever starts it, so they refuse it: the page's document never loads. Should a document of its own get there anyway, as it does once `frame-src` also allows the page's site, it still gets no port: the handshake asks for the token in the frame's URL, which only the document loaded at that URL can read ([the sandbox README](../../../../packages/platform/src/sandbox/README.md#the-protocol)). The browser tests check both. The deploy must keep `frame-src` exactly `'self'` ("Headers" below).
- **Credits.** A free-source track's credits link only to the source's own site or the licence's: HTTPS on `archive.org`, `jamendo.com`, `creativecommons.org` or their subdomains, with plain HTTP to them upgraded (`creditLink` in `view.ts`). An Internet Archive item's licence URL is whatever its uploader typed, so any other link, such as another site or an app's own scheme (`ms-msdt:`, `intent:`), is dropped and the provider's name stays as text.
- **Referrer.** The player's page sends `Referrer-Policy: no-referrer` (a `<meta>` here; the deploy also sends the header), so googlevideo sees no Referer.
- **Visitors of other sites.** A player loads its content as soon as the page shows it (`loading="lazy"` in the share code: when it scrolls near the screen): for YouTube content, the Lite self-test and the metadata calls go to YouTube, and the cover art comes from YouTube's image servers, before anyone presses play. So people who never chose FXM, and never click, send their IP address and the embedded item's ID to Google, as with YouTube's own embeds. The share dialog tells the site owner to mention it in their privacy notice, and the site's privacy page describes it. A click-to-load option is in "Not yet".

## Headers (stage 2.8)

The deploy serves the build of `vite.embed.config.ts` at `/embed/`, with the app's policy minus `frame-ancestors` (`appPolicy({ embeddable: true })` in 2.8), plus one header. `embed/headers.ts` holds the rule as the browser tests and the preview server send it:

- no inline script (`script-src 'self'` suffices; the app's theme-script hash is harmless), and styles from its own files;
- `frame-src 'self'` for the sandbox documents at `/sandbox/`, and it **must stay exactly `'self'`**: never `blob:`, `data:`, `https:` or another host. It is what keeps an embedding site out of the player's sandbox frame ("Security and privacy");
- the app's `img-src`, `media-src` and `connect-src` hosts: it contacts no service the app doesn't, though for people who never chose FXM ("Visitors of other sites" above);
- **`Cross-Origin-Opener-Policy: same-origin`**, so a page that opens the player at top level can't count its frames and so tell whether the visitor has FXM Connect. Recommended for `/app/*` too, before 2.7 wires the platform into the app: the app's frame tree also depends on the tier;
- the single-page fallback: every `/embed/…` path serves `index.html` (2.8 copies it to `embed/404.html`).

The browser tests serve the player with exactly that rule and check that it reports no violation. `pnpm --filter @fxm/web preview:embed` sends it too; the dev server can't, because React's refresh preamble is an inline script.

## Layout

| Path | What |
|---|---|
| `../../embed/`, `../../vite.embed.config.ts` | The embed's page (`index.html`) and entry (`main.ts`), and its build: root `embed/`, base `/embed/`, output `dist-embed/` |
| `../../embed/headers.ts` | The `/embed/*` header rule, for the browser tests and the preview server |
| `main.tsx` | Reads the address, applies the theme, creates the controller, renders and starts the API |
| `target.ts` | Addresses: building and reading them, the layouts, themes and heights |
| `controller.ts` | `EmbedController`: the platform, the catalog, the player and the stream lifecycle |
| `catalog.ts` | `EmbedCatalog` over `@fxm/core`'s metadata providers |
| `api.ts`, `visibility.ts` | The postMessage API, and the rule for when it may start playback |
| `view.ts` | The view model the layouts render, also for the share dialog's preview |
| `components/` | The two layouts and their parts; they adapt to the player's own width (container queries), so the preview matches the iframe |
| `embed-app.tsx`, `theme.ts`, `embed.css` | The React root, the theme and the styles |
| `integration.ts`, `wired.ts` | The providers, stream sources and matcher the player uses (below), and the sources wired in |
| `testing/` | Fakes for the unit tests, and the test doubles of the browser tests' build |

## Providers (touch-points with other stages)

Stage 5.2 started before 1.3, 1.4 and 1.6 were in its base (an early start), so everything it needs from them comes through `integration.ts` and `wired.ts`, behind interfaces the tests drive with fakes. Stage 2.9b wired them in, through the composition root's adapters in `src/app/services` (`youtube.ts`, `matcher.ts`, `updates.ts`), so the player and the app load and play YouTube the same way. A player for a source outside `WIRED_SOURCES` still says it can't play its content here, without contacting any service. Production builds of the app offer the Share entry now that the embed is released (`RELEASED.embed` in `features/connect/config.ts`, on with the site's `AVAILABLE.embed`), and only for the wired sources (`canShare` in `features/share/share-store.ts`; development builds and the tests always offer it, so the dialog can be tried).

| Touch-point | Stage | Wired as |
|---|---|---|
| YouTube Music and YouTube metadata | 1.3 | The YouTube module host's live `music` and `video` providers in `createProviderCatalog([…])`, loaded with the first YouTube content; `ytm` and `yt` in `WIRED_SOURCES` |
| Internet Archive metadata and credits | 1.6 | `createArchiveSource()`, with each track's credits (its item page and licence) read when the catalog loads it; `archive` in `WIRED_SOURCES` |
| YouTube streams | 1.4 | The ladder as the `ytm` `StreamSource` (`youtubeStreamSource`); the stream lifecycle gives its calls their budget priority (`context(priority)` in `controller.ts`), and its bot checks reach the platform's budget |
| Free-source streams | 1.6 | `fromAudioSource(archive)` |
| Songs for unlinked official videos | 1.7, 1.12 | The app's `TrackMatcher` over YouTube Music, with the matching config's options (Auto off) |
| Lite's kill switch and self-test request | 1.3, 1.13 | `embedPlatformOptions()`: the config's kill switches, the bundled config's until YouTube's code loads, then the config in use, kept current from FXM's site (`keepYouTubeCurrent`); `embedSandboxOptions()`: the self-test asks as the config's YouTube Music client |
| The `/embed/*` header rule and the build | 2.8 | The rule in "Headers" above, with `Cross-Origin-Opener-Policy: same-origin`; `make dist` builds the player into `/embed/` (`embedPart.build()`) |

Jamendo stays out until the build has a `client_id` for it. `integration.test.ts` fails when `WIRED_SOURCES` and the catalog's providers disagree, or a wired source has no stream source, and drives the real providers and ladder against the composition root's fake network. The browser tests below use test doubles for YouTube; the live check under "Tests" plays the deployed player, with these providers, against YouTube itself. It passed, so the site's `AVAILABLE.embed` and the app's `RELEASED.embed`, and with it the Share entry in production builds, are on.

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/embed apps/web/src/features/share   # unit tests (part of make test)
scripts/run.sh pnpm --filter @fxm/web e2e:embed                                  # browser tests, Chromium and Firefox
FXM_SCREENSHOTS=1 scripts/run.sh pnpm --filter @fxm/web e2e:embed                # also screenshots, in apps/web/screenshots/embed/
```

- **Unit tests** run the controller with the real player and stream lifecycle against fakes: the fake platform (`testing/fake-platform.ts`), fixture providers, the player's fake engine and fake stream sources shaped like 1.4's ladder and 1.6's sources. They cover the tiers, the install hint, Connect appearing, free sources, content the providers can't load (no platform at all), the catalog mode, the Lite probe's fallback to itag 18, failures and retries, notices, prefetching at its budget priority, every API message and parameter, pairing, the rate limit, the visibility rule, the views, the credits' links, the touch-points and the share dialog (also under StrictMode).
- **Browser tests** (`../../e2e/embed/`, not part of `make test`) build the player with `--mode e2e`, which swaps in test doubles (`testing/e2e-services.ts`): fixture metadata, and a YouTube "ladder" that resolves through the real platform with one `/player` call per rung. Two local origins serve the pages: FXM's site (`fxmusic.pages.dev`, port 6330, with 2.8's header rules) and another site (`music-blog.example`, port 6331) whose page frames the player and drives its API. A services mock (port 6332) answers as InnerTube and googlevideo did when measured, and a proxy (port 6333) routes the host names; nothing reaches the internet. `FXM_EMBED_E2E_PORT` moves all four.

| Done-when and checks | Test |
|---|---|
| It plays in Lite inside a test page on another origin | `plays in Lite inside a page on another origin`: the player pairs with the page, a click plays, the position moves; every InnerTube call came from the sandbox's opaque origin (`Origin: null`, `text/plain`); the capped top-rung URL failed its first request and itag 18 played; media requests carry no Referer; no page reached another host; no policy violation under the app's policy minus `frame-ancestors` |
| The postMessage API | `answers the page that embeds it, and only that page`; `announces itself only to the origin its address names` |
| Free sources plus an install hint | `plays free sources and shows the install hint without Lite`: InnerTube refuses opaque origins, so the self-test fails; a YouTube song shows the hint, an Internet Archive track plays with its credits and frames no sandbox |
| Albums, the catalog mode, both layouts, framing | `plays an album from its track list`, `plays a video only in Music + Video mode`, `comes in a compact layout, light or dark`, `frames the player on any site but never the app` |
| Every message fits, also at phone widths | `fits the install hint in the compact layout, also on phones` (320 and 375 px: nothing clamped); `fits every message in the track card at phone widths` (the install hint at 320 and 343 px, a notice with its action at 320 and 768 px) |
| A page can't count a top-level player's frames | `keeps a page that opens the player from seeing its frames`: the popup framed its sandbox, the opener sees a closed window with no frames |
| A page can't take over the sandbox frame | `keeps the embedding page out of its sandbox frame`: with `frame-src` relaxed to its site the page's document loads but gets no port, for want of the handshake's token; under the rule, a `frame-src` violation, no request for that document and no port |
| The API starts playback only while the player is visible | `starts playback from the page only while the player is visible`: a 1 × 1 frame, an off-screen one and (Chromium) a transparent one answer `not-visible`; shown, it plays |
| A shared player link | `shows a shared player link as a page of its own`: centred at the card's height, and it plays |

**Test record.** The browser tests passed on 2026-10-26 on macOS 15.5 (arm64) with Playwright 1.64.0's Chromium 156.0.8078.4 and Firefox 157.0, headless (14 of 14 in each), and again the same day on top of develop, with 1.10's final sandbox transport (its handshake token, and Lite's self-test in the background), and once more for v0.4.0, with the release flag on and both browsers muted (`--mute-audio`, Firefox's `media.volume_scale` at 0), 14 of 14 in each. Safari is not tested.

**The live check.** `scripts/build-dist/e2e/embed.e2e.ts` is the check behind the release flags (the site's `AVAILABLE.embed`, the app's `RELEASED.embed`): a page it serves on another site frames the deployed player with the share dialog's code (`embedCode`), pairs with it through the API, and a click inside the frame plays a YouTube Music song in the Lite tier, from googlevideo, for at least 10 s, within 10 requests to YouTube, with no policy violation in any of the three documents. It reaches YouTube for real, so it runs only when asked (`FXM_LIVE=1` and `FXM_DEPLOY_URL`), from a residential connection, and never retries. [The deploy's README](../../../../scripts/build-dist/README.md#the-embed-on-the-deployed-site) says how to run it and keeps its record: it passed on 2026-10-26 against production, `https://fxmusic.pages.dev`, which then served v0.1.0's player. Run it again against production once a release ships a new player.

## Not yet

- **FXM Connect inside other sites:** blocked, on purpose. A content-script entry for `https://fxmusic.pages.dev/embed/*` with `all_frames: true` would make the player use Connect inside other sites, but any embedding page could then tell whether its visitor has Connect, without a click: the player frames the sandbox document only without Connect, and `iframe.contentWindow.length` is readable across origins (measured by the review in Chromium 156 and Firefox 157: 0 frames with Connect, 1 without). The `ready` and `unavailable` answers would differ too whenever Lite is off or fails. It needs a player whose frame tree and timing don't depend on the tier first; until then Connect stays off in third-party frames.
- **Click-to-load** (`?load=click`): a facade that contacts no service until the visitor presses play, for embedders who don't want any third-party request on page load. The press would have to start playback after the content has loaded, outside the gesture that Safari requires for audio, so it needs the player to unlock its audio element on that press first.
- **An offline check of the built player with the real providers.** The browser tests build the player with `--mode e2e`, whose YouTube metadata and ladder are test doubles, and the live check ("Tests") plays the deployed player against YouTube itself, only when asked. A run of the production build against the test network (its InnerTube and googlevideo mocks answering youtubei.js's calls) would check the real providers on every change, without YouTube. A YouTube player loads YouTube's code, youtubei.js included, in one lazy chunk (about 200 KB gzipped).
- **Jamendo**, once the build has a `client_id` for it.
- **Spotify** tracks, albums and playlists: they need FXM Connect, the Spotify provider (1.5) and the matching engine.
- **Long playlists** play their first page.
