# @fxm/platform

The platform layer under every provider. It does three jobs:

1. **Gives every provider the right `fetch`** for where FXM runs: a browser page (with or without the FXM Connect extension, or in the experimental Lite tier), the Tauri desktop app, the Capacitor Android app, or Node in tests.
2. **Tells the app which tier it is in**, as the `NetworkCapabilities` of `@fxm/core`, and keeps them up to date when FXM Connect appears or goes away.
3. **Makes every YouTube call draw from one request budget**, so background work can never get the user's IP address flagged and break their own playback.

FXM has no servers: all of this runs on the user's device. Providers only ever use the `ctx.fetch` this package builds.

## Quick start

```ts
import { createPlatform } from '@fxm/platform'

// Picks the environment, wires the transport, the budget, FXM Connect and the Lite tier,
// and resolves after the first capability detection.
const platform = await createPlatform({
  sandbox, // the Lite tier's sandbox documents (stage 1.10); leave out for no Lite tier
  killSwitches: () => remoteConfig.killSwitches, // { lite?: boolean }
})

platform.capabilities.current // { youtube: 'full' | 'simple' | 'none', spotify, mediaBytes, fileSystem }
platform.capabilities.subscribe((capabilities) => render(capabilities))

// One ProviderContext per provider call, with the fetch for what the call is for.
const ctx = platform.context({ mode: 'music', priority: 'current-track' })
const streams = await youtube.resolve(candidate, ctx, prefs)
```

`platform.connect` is the FXM Connect client (detection status, the Spotify session bridge), `platform.lite` the Lite tier's gate and `platform.budget` the request budget.

## Tiers

On the web, what FXM reaches depends on the tier:

| | Free only | Lite (experimental, no install) | Full (FXM Connect) |
|---|---|---|---|
| CORS-friendly hosts (MusicBrainz, LRCLIB, Internet Archive, Jamendo, …) | ✅ direct | ✅ direct | ✅ direct |
| InnerTube API calls (search, browse, `next`, `player`) | — | ✅ through the sandbox | ✅ through the page |
| Other YouTube pages (player JS, `sw.js_data`) | — | — | ✅ |
| googlevideo bytes (downloads, probes, MediaSource) | — | — | ✅ |
| Spotify | — | — | ✅ (logged-in token through the bridge) |
| Last.fm station JSON | — | — | ✅ |
| Capabilities | `youtube: 'none'` | `youtube: 'simple'` | `youtube: 'full'`, `mediaBytes: true` |

`<audio src>` plays googlevideo URLs on every tier: playback needs no `fetch`. The desktop app reaches everything through its native HTTP (stage 7.2), the Android app will once stage 6.2 supplies its own, and Node always does.

A refused request rejects with an `Unsupported` `FxmError` that names what is missing, before any budget is spent. Every request goes out with `credentials: 'omit'`, and no transport sends a caller's `Origin` or `Cookie` header.

## Hosts

`src/hosts.ts` holds the typed table of every host FXM contacts. It doubles as the network allow-list: each transport classifies a URL first and refuses anything else (`Unsupported`), so a provider can never reach an unlisted host. Only `https:` URLs on the default port and without credentials match.

| Class | Hosts | On the web |
|---|---|---|
| `open` | `musicbrainz.org`, `coverartarchive.org`, `api.listenbrainz.org`, `labs.api.listenbrainz.org`, `ws.audioscrobbler.com`, `lrclib.net`, `archive.org` and `*.archive.org`, `api.jamendo.com` and `*.jamendo.com`, `itunes.apple.com`, `sponsor.ajay.app`, `i.ytimg.com`, `*.ggpht.com`, `i.scdn.co` | Direct |
| `innertube` | `www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com` | FXM Connect, or the Lite sandbox for `/youtubei/v1/…` |
| `googlevideo` | `*.googlevideo.com` | FXM Connect |
| `spotify` | `open.spotify.com`, `clienttoken.spotify.com`, `api-partner.spotify.com`, `spclient.wg.spotify.com` | FXM Connect |
| `lastfm-web` | `www.last.fm`, paths under `/player/station/` only | FXM Connect |

A wildcard (`*.archive.org`) matches sub-domains at any depth but not the domain itself.

**Hosts the user adds** in Settings, such as an Invidious instance or a Spotify secret source, can be passed as `userHosts` (`host` or `host:port`, HTTPS only). They get `GET` and `HEAD` only, without any header. On the web they go through the sandbox's user-host document (`SandboxTransport.userHost`, stage 1.10), because the app's CSP does not list them; elsewhere they go direct.

## One InnerTube request shape

`toSimpleInnerTubeRequest(input, init)` turns any InnerTube API request, such as the ones youtubei.js makes, into the CORS-simple shape FXM uses on every platform:

- `POST` with the JSON payload as a string body (`Content-Type: text/plain;charset=UTF-8`, which InnerTube parses as JSON);
- no other header: no `Content-Type: application/json`, `X-Goog-*`, `X-YouTube-*` or `Authorization`, no `Origin`, `Cookie` or `User-Agent`. `X-Goog-Visitor-Id` and `X-YouTube-Client-Version` move into `context.client.visitorData` and `.clientVersion` unless the payload already has them;
- `prettyPrint=false` in the URL, and `credentials: 'omit'`.

A payload that needs no change is sent byte for byte. Non-JSON bodies, such as protobuf, are refused (`Unsupported`): they would need a `Content-Type` that triggers a preflight, which InnerTube refuses from the Lite tier's opaque origin. Every transport applies the shape again, whatever the provider sent, and the tests check that no preflight-triggering header survives (`isCorsSimpleRequest` in `src/cors.ts` follows the Fetch standard's safelist).

## The request budget

`createRequestBudget()` is one budget per device for every InnerTube call: playback, search, matching and imports. `createPlatform` creates it in `localStorage`, so every tab and reload shares it, and hands it to the transport. Every request to a YouTube API host (`innertube` class) draws one slot.

- **The cap:** at most 600 calls in any rolling hour, half of yt-dlp's guest-session figure.
- **Priorities**, highest first: `current-track`, `prefetch`, `interactive`, `bulk`. Each may use the hour only while it leaves its reserve for the ones above it: bulk stops while 100 or fewer calls remain, interactive calls while 30 or fewer do, prefetching while 10 or fewer do, and the current track may use the last one. The middle reserves are FXM's choice; all four are options.
- **Waiting:** bulk calls queue in order and start at least 5 s apart. The other priorities never wait: they get a slot at once or reject with a `RateLimited` `FxmError` whose `retryAfterMs` says when one frees up.
- **Bot checks:** the first `LOGIN_REQUIRED` or 429 pauses bulk work for 30 minutes while playback and interactive calls go on. A bot check soon after a pause ended doubles the next pause, up to 4 hours; once bulk work has run as long as the last pause without one, the next starts at 30 minutes again. A report during a pause extends it.
- **Persistence:** the hour's calls and the pause are stored (the storage is injectable), so a reload never resets them. Times in the future, which only a clock set back explains, are moved to now. If the storage refuses writes, the budget keeps counting in memory.

Pick the priority by building the provider context with `transport.withPriority(priority)` (or `platform.context({ priority })`): the player uses `current-track` and `prefetch`, the UI `interactive` (the default `transport.fetch`), imports and re-matching `bulk`.

**What the transports report themselves:** an HTTP 429 from a YouTube API host, and a `LOGIN_REQUIRED` playability status in a `/youtubei/v1/player` response (read from a clone, so the caller still gets the body). Age-restricted videos answer `LOGIN_REQUIRED` too; counting them only pauses bulk work, which errs on the safe side. Anything else can call `budget.reportBotCheck(cause)`.

Two tabs share the budget through storage but each queues its own bulk calls, so the 5-second spacing holds per tab and only approximately across tabs.

## FXM Connect

`createConnectClient()` detects the companion extension and talks to its Spotify session bridge, using exactly the protocol of `apps/extension/src/messages.ts` (documented in the extension's README, "For the web app"). `connect.contract.test.ts` runs this client against the extension's own content script and validation to keep both sides in step.

**Detection** reads the `data-fxm-connect` marker on `<html>`; without it the answer is immediate. With it, the client posts `fxm-connect:ping` and waits up to 800 ms for the pong with the version and features. Messages count only when `event.source` is the page's own window and `event.origin` its origin, and malformed pongs are ignored. The status is one of:

| `state` | Meaning |
|---|---|
| `present` | It answered, at `MIN_CONNECT_VERSION` (`0.1.0`) or later |
| `outdated` | It answered with an older or unreadable version. The app does not use it and asks the user to update |
| `missing` | It does not answer, but it did on this device before: disabled, removed or blocked by the browser. `lastSeenVersion` says which version. `forget()` drops the memory |
| `absent` | It does not answer and was never seen here |

The client re-detects by itself when the marker appears, changes or goes away (a `MutationObserver`), accepts a pong that arrives after the timeout, and notifies `subscribe` listeners of every change.

**The Spotify session bridge:** `spotifyToken(params)` asks FXM Connect for `open.spotify.com/api/token` with the browser's own Spotify login, and `spotifyServerTime()` for `/api/server-time`. Both resolve with `{ status, json }`. They need a `present` FXM Connect, refuse parameters outside the extension's allow-list before sending anything, time out after 15 s (`Network`) and honour an abort signal. The extension's error codes map to `FxmError` codes in a `ConnectBridgeError`, which keeps the original as `connectCode`:

| `connectCode` | `FxmError` code |
|---|---|
| `login-disabled` | `AuthRequired`: the user has to turn on "Use my Spotify login from this browser" |
| `private-tab`, `bad-request`, `unsupported` | `Unsupported` |
| `rate-limited` | `RateLimited`, `retryAfterMs` 60 s |
| `network-error`, `timeout`, `unavailable`, `internal`, and unknown codes | `Network` |
| `too-large` | `Parse` |

Anonymous tokens need no bridge: with FXM Connect the page fetches `open.spotify.com/api/token` itself.

## Capabilities

`resolveCapabilities(inputs)` is the pure rule, `detectCapabilities(options)` runs it once, and `createCapabilityMonitor(options)` keeps the result current and has `subscribe`:

- **Web:** FXM Connect `present` with feature `youtube` gives `youtube: 'full'`, plus `mediaBytes` with `googlevideo`. Otherwise `'simple'` once the Lite self-test passed and no kill switch is set, else `'none'`. Spotify is `anonymous` with feature `spotify` and `account` with `spotify-login` as well, otherwise `unreachable`.
- **Desktop and Android:** `full`, media bytes, and Spotify `anonymous` (or `account` with a login token source) once their native HTTP exists: in the desktop app, `createPlatform()` brings stage 7.2's by itself. Without one (Android until stage 6.2), their transports are stubs and they honestly report `youtube: 'none'` and Spotify `unreachable`.
- `mediaBytes` is only ever `true` with `youtube: 'full'`, as `NetworkCapabilities` requires.

Detection follows the architecture's order: FXM Connect first, and the Lite self-test only when it gives no full access. The self-test runs once per session (it draws one slot from the budget); `lite.check({ force: true })` runs it again, and `capabilities.refresh()` re-evaluates after the kill switches changed.

## The Lite tier

`src/lite.ts` holds the `SandboxTransport` contract that stage 1.10 implements with `/sandbox/innertube.html` and `/sandbox/userhost.html`: `selfTest()`, `innerTube(request)` for requests in the simple shape, and the optional `userHost(url, init)`. `createLiteTier({ sandbox, killSwitches, budget })` is the gate the transport and the capabilities share: `ready` is true while the self-test passed and the kill switch is off, so flipping the switch closes the route at once.

## Native transports

Desktop and Android reach every host directly through a `NativeHttp` function: `(url, init) => Promise<Response>`, where `init.headers` is a plain object, the only place headers go (a webview drops forbidden headers set on a `Request` object). The native layer must send exactly those headers, treat `origin: ''` as "no `Origin` header" and keep no cookie jar shared with the webview. On top of it, `createNativeTransport` applies the routing, the budget and the header policy:

| Requests to | `Origin` |
|---|---|
| YouTube (InnerTube, other pages, googlevideo), CORS-friendly hosts, user hosts | `''`: none. InnerTube refuses every webview origin (`tauri://localhost`, `http(s)://tauri.localhost`, `https://localhost`, a dev server) with 403 |
| Spotify | `https://open.spotify.com` |

With `userAgent`, YouTube and Spotify requests that carry no `User-Agent` get that browser one: Spotify refuses non-browser agents.

- **Tauri (stage 7.2):** `createTauriTransport({ http: createDesktopFetch() })`, which `createPlatform()` sets up by itself when it finds Tauri's runtime (`isTauriRuntime()`). See [Desktop](#desktop).
- **Capacitor (stage 6.2):** `createCapacitorTransport({ http })`, where `http` wraps FXM's OkHttp plugin with its own cookie jar. Never Capacitor's global `CapacitorHttp` patch or `CapacitorHttp.request`: the patch drops headers and corrupts binary bodies, and both send WebView cookies.

Without `http`, both are stubs: CORS-friendly hosts through the webview's own `fetch` (on Android the unpatched one, `unpatchedFetch()`), and an `Unsupported` error naming the missing stage for everything else.

`createNodeTransport()` reaches everything directly with Node's `fetch`, with the same allow-list, request shape and budget, for tests and the live smoke tests (`FXM_LIVE=1`).

## Desktop

`createDesktopFetch()` (`src/desktop.ts`) is the desktop app's `NativeHttp`. It loads Tauri's bindings (`@tauri-apps/plugin-http` and `@tauri-apps/api`) on its first request, so a browser never downloads them, and sends:

- **Hosts in the table** through Tauri's HTTP plugin, whose scope in the app's `capabilities/default.json` lists exactly those hosts and whose `scopeRedirects` setting checks every redirect against it. A refused address, a redirect's included, rejects with an `Unsupported` `FxmError`; a network failure with a `TypeError`, and an abort with the signal's reason, as `fetch` does.
- **Any other host** through the app's `user_host_fetch` Rust command, which reaches only hosts the user approved, by `GET` or `HEAD`, over HTTPS, to public addresses, with at most 8 MiB in 30 s. Its refusals reject with an `Unsupported` `FxmError` (`Parse` for a response that is too large).

It enforces the header policy once more at the last step, whatever the caller sent:

- `origin` is `''` (no `Origin` header, which needs the plugin's `unsafe-headers` feature) unless it is the `https:` origin of a real site, such as Spotify's: the webview's own origin (`tauri://localhost`, `http(s)://tauri.localhost`, a dev server's) never goes out (`siteOrigin`);
- a request that names no User-Agent gets a browser's for YouTube and Spotify (`desktopBrowserUserAgent`: the webview's own, completed to Safari's on macOS) and FXM's own for every other host (`fxmUserAgent`), never the plugin's `tauri-plugin-http/<version>`, which Spotify refuses;
- headers go only in `init.headers`, as a plain object; `Cookie` is never sent, and `Set-Cookie` never reaches the caller.

`createDesktopUserHosts()` is the client for the approved hosts: `refresh()` and `current()` read the list, which Rust keeps, `revoke(host)` shrinks it, and `approve(host)` asks the user in a native dialog. Only that dialog can grow the list, so no page script can make FXM contact a new host. Pass `userHosts: () => hosts.current()` to `createPlatform()`, so the transport routes those hosts.

The app side, its scope, permissions and content security policy are in [apps/desktop/README.md](../../apps/desktop/README.md#network).

## Test helpers

`@fxm/platform/testing` exports fakes for this package's tests and the apps' (never import it from app code):

- `createFakeClock()`: a `Clock` whose time only the test moves; `advanceAsync` lets promises settle between timers.
- `createFakeSandbox()`: a `SandboxTransport` that refuses requests the real sandbox could not send (not CORS-simple, or not one of the allowed InnerTube paths) and records the rest.
- `installFakeConnect(window)`: marks a page and answers pings and bridge requests the way FXM Connect's content script does.

Tests that need a page create their own happy-dom `Window` at the FXM origin: in Vitest's global happy-dom environment, a message's `event.source` is not the page's `window`. happy-dom delivers `postMessage` on real timers, so the clients take an injectable `clock` for their timeouts.

```sh
scripts/run.sh pnpm vitest run packages/platform                      # this package's tests
scripts/run.sh pnpm vitest run --coverage --coverage.include='packages/platform/src/**' packages/platform
scripts/run.sh pnpm --filter @fxm/platform typecheck
```

## Layout

| Path | What |
|---|---|
| `src/platform.ts` | `detectEnvironment`, `createPlatform`, `FxmPlatform.context` |
| `src/transport.ts` | The shared transport core: classification, request forms, budget draws, bot-check reports |
| `src/web.ts`, `src/node.ts`, `src/native.ts`, `src/tauri.ts`, `src/capacitor.ts` | One transport per environment, and the native contract |
| `src/desktop.ts` | The desktop app's native HTTP and its approved hosts (stage 7.2) |
| `src/hosts.ts`, `src/cors.ts`, `src/innertube.ts` | The host table, the CORS safelist and the InnerTube request shape |
| `src/budget.ts` | The shared request budget |
| `src/connect.ts` | FXM Connect detection and the bridge client |
| `src/lite.ts` | The `SandboxTransport` contract and the Lite tier's gate |
| `src/capabilities.ts` | Capability rules, detection and the monitor |
| `src/clock.ts`, `src/storage.ts` | Injectable time and key-value storage |
| `src/testing/` | The test helpers |

`src/sandbox/` (stage 1.10), `src/updates/` (1.13, signed config and resolver module) and `src/evaluator/` (1.11) belong to later stages.

See [ARCHITECTURE.md §8](../../docs/ARCHITECTURE.md#8-platforms-and-network-transports).
