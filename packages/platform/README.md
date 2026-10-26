# @fxm/platform

The platform layer under every provider. It does three jobs:

1. **Gives every provider the right `fetch`** for where FXM runs: a browser page (with or without the FXM Connect extension, or in the experimental Lite tier), the Tauri desktop app, the Capacitor Android app, or Node in tests.
2. **Tells the app which tier it is in**, as the `NetworkCapabilities` of `@fxm/core`, and keeps them up to date when FXM Connect appears or goes away and when the Lite tier's state changes.
3. **Makes every YouTube call draw from one request budget**, so background work can never get the user's IP address flagged and break their own playback.

FXM has no servers: all of this runs on the user's device. Providers only ever use the `ctx.fetch` this package builds.

## Quick start

```ts
import { createKillSwitchStore, createPlatform, createSandboxTransport } from '@fxm/platform'

const killSwitches = createKillSwitchStore() // set it whenever the remote config changes

// Picks the environment and wires the transport, the budget, FXM Connect and the Lite tier.
// Resolves once FXM Connect detection is done (at most 800 ms); the Lite self-test, a round
// trip to YouTube, goes on in the background.
const platform = await createPlatform({
  sandbox: createSandboxTransport(), // the Lite tier's sandbox documents; leave out for no Lite tier
  killSwitches, // or a function: () => remoteConfig.killSwitches
})

platform.capabilities.current // { youtube: 'full' | 'simple' | 'none', spotify, mediaBytes, fileSystem }
platform.capabilities.subscribe((capabilities) => render(capabilities)) // e.g. 'simple' once Lite passed

// One ProviderContext per provider call, with the fetch for what the call is for.
const ctx = platform.context({ mode: 'music', priority: 'current-track' })
try {
  const streams = await youtube.resolve(candidate, ctx, prefs)
} catch (error) {
  platform.report(error) // a provider's BotCheck pauses bulk work too
}
```

`platform.connect` is the FXM Connect client, `platform.lite` the Lite tier's gate, `platform.budget` the request budget and `platform.spotifySession` the token source of the user's Spotify login (see [The Spotify login](#the-spotify-login)).

The package exports only this public API. The routing core (`createTransport`, `Router`), the request forms and the storage helpers stay inside it, so later stages can change them freely; code inside the package (the sandbox of stage 1.10) imports them by path.

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

`<audio src>` plays googlevideo URLs on every tier: playback needs no `fetch`. The desktop and Android apps reach everything through their native HTTP (stages 7.2 and 6.2), and Node always does.

Routes are decided when a request is sent, from FXM Connect's status and the Lite tier's readiness at that moment. A request that draws from the budget asks twice: before it takes a slot, so a closed route costs nothing, and right before it is sent, so a route that closed while the call waited (FXM Connect disabled, the Lite kill switch set) is never used. `transport.canReach(url)` asks the same question without sending anything, e.g. to skip Last.fm stations without FXM Connect.

Every request goes out with `credentials: 'omit'`, and no transport sends a caller's `Origin` or `Cookie` header.

## Errors

A request a transport refuses rejects before anything is sent, with an `FxmError` whose code `@fxm/core` knows and a field that says which case it is, so the app never parses messages:

| Error | Code | When |
|---|---|---|
| `RouteUnavailableError` | `Unsupported` | The route is closed right now. `route` names it, `needs` lists what would open it (`connect`, `lite`, `native` for the desktop or Android app's native networking, `sandbox` for the sandbox documents) and `connectFeature` the FXM Connect feature it takes. The onboarding UI offers the fix |
| `TransportError`, `reason: 'unknown-host'` | `Unsupported` | The host is not in the table and the user did not add it: a bug, never a tier gap |
| `TransportError`, `reason: 'bad-request'` | `Unsupported` | A request its route cannot carry: an InnerTube body that is not JSON, a `POST` to a user host, a relative URL |
| `TransportError`, `reason: 'redirect'` | `Unsupported` | A redirect left the host table or the host's class, there were more than 5, or the request said `redirect: 'error'` |
| `BudgetError` | `RateLimited` | The budget refused the call: `reason` is `paused`, `reserve` or `spacing`, and `retryAfterMs` says when a slot is expected |
| `ConnectBridgeError` | per code | FXM Connect's bridge refused (see below) |
| `FxmError` | `BotCheck` | A YouTube request was sent to Google's "unusual traffic" page |
| `SandboxRefusedError`, a `TransportError` with `reason: 'bad-request'` or `'redirect'` | `Unsupported` | Lite: a sandbox document refused the request before sending it, or did not follow a redirect. `sandboxCode` says why, e.g. `preflight` ([the sandbox's errors](src/sandbox/README.md#errors)) |
| `SandboxFailedError` | `Network`, `Parse` | Lite: a sandbox request failed once sent: no complete response in time (`timeout`), a network or CORS failure (`network`), or a response over the cap (`too-large`, `Parse`) |

`isTransportError(error, reason?)`, `isRouteUnavailable(error)`, `isBudgetError(error, reason?)` and `isSandboxError(error, sandboxCode?)` also recognize errors from a second copy of the package. Programming errors (an unknown priority, a negative wait limit) throw a `RangeError`.

## Hosts

`src/hosts.ts` holds the typed table of every host FXM contacts. It doubles as the network allow-list: each transport classifies a URL first and refuses anything else, so providers cannot send a request to an unlisted host. Only `https:` URLs on the default port and without credentials match.

| Class | Hosts | On the web |
|---|---|---|
| `open` | `musicbrainz.org`, `coverartarchive.org`, `api.listenbrainz.org`, `labs.api.listenbrainz.org`, `ws.audioscrobbler.com`, `lrclib.net`, `archive.org` and `*.archive.org`, `api.jamendo.com` and `*.jamendo.com`, `itunes.apple.com`, `sponsor.ajay.app`, `i.ytimg.com`, `*.ggpht.com`, `i.scdn.co` | Direct |
| `innertube` | `www.youtube.com`, `music.youtube.com`, `youtubei.googleapis.com` | FXM Connect, or the Lite sandbox for `/youtubei/v1/…` |
| `googlevideo` | `*.googlevideo.com` | FXM Connect |
| `spotify` | `open.spotify.com`, `clienttoken.spotify.com`, `api-partner.spotify.com`, `spclient.wg.spotify.com` | FXM Connect |
| `lastfm-web` | `www.last.fm`, paths under `/player/station/` only | FXM Connect |

A wildcard (`*.archive.org`) matches sub-domains at any depth but not the domain itself.

**Redirects** stay inside the table too. Desktop, Android and Node send every request with `redirect: 'manual'` and the transport follows redirects itself, at most 5, checking each hop before it is sent: it must stay in the table and in the host's class (`archive.org` → `ia800300.us.archive.org` is fine, `archive.org` → `www.youtube.com` is not), user hosts on the same host. The Fetch standard's rules apply on the way: a `303`, or a `301`/`302` after a `POST`, becomes a `GET` without a body, and `Authorization` is dropped on another origin. In a browser the browser follows redirects itself, so the transport refuses a response that ended outside the table or the class; the web app's content security policy (`connect-src`) is what keeps the page from contacting such a host at all.

**Hosts the user adds** in Settings, such as an Invidious instance or a Spotify secret source, can be passed as `userHosts` (`host` or `host:port`, HTTPS only). They get `GET` and `HEAD` only, without any header. On the web they go through the sandbox's user-host document (`SandboxTransport.userHost`, stage 1.10), because the app's CSP does not list them; elsewhere they go direct.

## One InnerTube request shape

`toSimpleInnerTubeRequest(input, init)` turns any InnerTube API request, such as the ones youtubei.js makes, into the CORS-simple shape FXM uses on every platform:

- `POST` with the JSON payload as a string body (`Content-Type: text/plain;charset=UTF-8`, which InnerTube parses as JSON);
- no other header: no `Content-Type: application/json`, `X-Goog-*`, `X-YouTube-*` or `Authorization`, no `Origin`, `Cookie` or `User-Agent`. `X-Goog-Visitor-Id` and `X-YouTube-Client-Version` move into `context.client.visitorData` and `.clientVersion` unless the payload already has them;
- `prettyPrint=false` in the URL, and `credentials: 'omit'`.

A payload that needs no change is sent byte for byte. Non-JSON bodies, such as protobuf, are refused (`bad-request`): they would need a `Content-Type` that triggers a preflight, which InnerTube refuses from the Lite tier's opaque origin. Every transport applies the shape again, whatever the provider sent, and the tests check that no preflight-triggering header survives (`isCorsSimpleRequest` in `src/cors.ts` follows the Fetch standard's safelist).

## The request budget

`createRequestBudget()` is one budget per device for every InnerTube call: playback, search, matching and imports. `createPlatform` creates it in `localStorage`, so every tab and reload shares it, and hands it to the transport; every transport factory requires one, so no transport can quietly count on its own. Every request to a YouTube API host (`innertube` class) draws one slot.

- **The cap:** at most 600 calls in any rolling hour, half of yt-dlp's guest-session figure.
- **Priorities**, highest first: `current-track`, `prefetch`, `interactive`, `bulk`. Each may use the hour only while it leaves its reserve for the ones above it: bulk stops while 100 or fewer calls remain, interactive calls while 30 or fewer do, prefetching while 10 or fewer do, and the current track may use the last one. The middle reserves are FXM's choice; all four are options (`budget.settings` shows them).
- **Waiting:** bulk calls queue in order and start at least 5 s apart. The other priorities never wait: they get a slot at once or reject with a `BudgetError` (`reserve`).
- **Bot checks:** the first `LOGIN_REQUIRED` or 429 pauses bulk work for 30 minutes while playback and interactive calls go on. A bot check soon after a pause ended doubles the next pause, up to 4 hours; once bulk work has run as long as the last pause without one, the next starts at 30 minutes again. A report during a pause extends it.
- **Persistence:** the hour's calls and the pause are stored (the storage is injectable), so a reload never resets them. Times in the future, which only a clock set back explains, are moved to now. If the storage refuses writes, the budget keeps counting in memory.

Pick the priority when building the provider context: `platform.context({ mode, priority })` requires one, and `transport.withPriority(priority)` gives the `fetch` for it. The player uses `current-track` and `prefetch`, the UI `interactive` (also `transport.fetch`), imports and re-matching `bulk`.

**Job runners** (imports, re-matching, the matching recorder) never let a bulk call wait long inside a provider's `fetch`, where the provider's request timeout would cut it off and report a network error. Through the transport, a bulk call waits for its turn at most the spacing plus a second (`bulkMaxWaitMs`), enough for the calls of one provider operation to follow each other; one that cannot start by then, which is always the case during a pause, rejects at once with a `BudgetError`. So a runner waits outside every timeout before each provider call, and keeps its progress when a call is turned away:

```ts
while (progress.done < tracks.length) {
  await platform.budget.whenAvailable('bulk', { signal }) // through pauses, spacing and a used-up hour
  try {
    const ctx = platform.context({ mode, priority: 'bulk', signal })
    await matcher.match(tracks[progress.done], ctx)
    progress.done += 1 // saved, so the import resumes here after a reload
  } catch (error) {
    if (isBudgetError(error)) continue // turned away meanwhile: wait again, then retry this track
    platform.report(error)
    throw error
  }
}
```

`budget.nextSlotAt('bulk')` says when the next bulk call could start, for a progress display ("Import resumes at 14:30").

**Who reports bot checks:**

- The transports report an HTTP 429 from a YouTube API host, a redirect from YouTube to Google's "unusual traffic" page, and a `LOGIN_REQUIRED` playability status in a `/youtubei/v1/player` answer (read from a clone, so the caller still gets the body). Age gates and private videos answer `LOGIN_REQUIRED` too and are not counted: the language-independent `desktopLegacyAgeGateReason`, and the English reasons, which stream requests ask for, tell them apart. A `LOGIN_REQUIRED` in another language without that field is counted, which errs on the safe side. `reportLoginRequired: false` turns this off once the stream resolver reports what it tells apart itself. A 403 is never counted: InnerTube answers it to origins it refuses.
- Providers that notice a bot check themselves reject with a `BotCheck` `FxmError`; the player and job runners pass every provider error to `platform.report(error)`, which forwards those to the budget.

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

The client detects again by itself when the marker appears, changes or goes away (a `MutationObserver`), when the page gets the focus back or becomes visible, and after the bridge answered `login-disabled` or `private-tab`. FXM Connect announces nothing when the user changes its options (often in another tab), so coming back to the FXM tab is what refreshes the `spotify-login` feature; `connect.detect()` does it on demand. A pong that arrives after the timeout still counts, and `subscribe` listeners hear of every change.

**The Spotify session bridge:** `spotifyToken(params)` asks FXM Connect for `open.spotify.com/api/token` with the browser's own Spotify login, and `spotifyServerTime()` for `/api/server-time`. Both resolve with `{ status, json }`. They need a `present` FXM Connect, refuse parameters outside the extension's allow-list before sending anything, time out after 15 s (`Network`) and honour an abort signal. A reply counts only from the page itself with the request's own ID. The extension's error codes map to `FxmError` codes in a `ConnectBridgeError`, which keeps the original as `connectCode`:

| `connectCode` | `FxmError` code |
|---|---|
| `login-disabled` | `AuthRequired`: the user has to turn on "Use my Spotify login from this browser" |
| `private-tab` | `AuthRequired`: the browser's normal Spotify login does not apply in private windows and container tabs |
| `bad-request`, `unsupported` | `Unsupported` |
| `rate-limited` | `RateLimited`, `retryAfterMs` 60 s |
| `network-error`, `timeout`, `unavailable`, `internal`, and unknown codes | `Network` |
| `too-large` | `Parse` |

Anonymous tokens need no bridge: with FXM Connect the page fetches `open.spotify.com/api/token` itself.

## The Spotify login

`platform.spotifySession` is one `SessionTokenSource` for every platform: `requestToken(params, { signal })` resolves with the token endpoint's `{ status, json }`. Its shape matches the Spotify provider's `SessionTokenSource` (stage 1.5), so it can be passed to it as it is, and a provider's `ProviderContext` fits as the options.

- **Web:** FXM Connect's bridge (`connectSessionSource(connect)`). It serves tokens while FXM Connect announces `spotify-login`, rejects with `AuthRequired` when the login is off or the tab is private, and with `Unsupported` without FXM Connect.
- **Desktop, Android and Node:** `createPlatform({ spotifySession })`, the login window's token command of stages 7.4 and 6.5. Spotify is `account` exactly when it is given.

`capabilities.spotify` says whether the source can serve a token right now (`account`).

## Capabilities

`resolveCapabilities(inputs)` is the pure rule, `detectCapabilities(options)` runs it once, and `createCapabilityMonitor(options)` keeps the result current and has `subscribe`:

- **Web:** FXM Connect `present` with feature `youtube` gives `youtube: 'full'`, plus `mediaBytes` with `googlevideo`. Otherwise `'simple'` once the Lite self-test passed and no kill switch is set, else `'none'`. Spotify is `anonymous` with feature `spotify` and `account` with `spotify-login` as well, otherwise `unreachable`.
- **Desktop and Android:** `full`, media bytes, and Spotify `anonymous` (or `account` with a login token source) once their native HTTP exists: in the desktop app, `createPlatform()` brings stage 7.2's by itself, and on Android the `FxmHttp` plugin (stage 6.2). Without it, their transports are stubs and they honestly report `youtube: 'none'` and Spotify `unreachable`.
- `mediaBytes` is only ever `true` with `youtube: 'full'`, as `NetworkCapabilities` requires.

Detection follows the architecture's order: FXM Connect first, and the Lite self-test only when it gives no full access. The monitor follows FXM Connect and the Lite tier by itself: a self-test that ended, a kill switch set or lifted through a `KillSwitchSource`, FXM Connect appearing or going away. `capabilities.refresh()` detects again and waits for a self-test it starts; `refresh({ waitForLite: false })`, which `createPlatform` uses, does not, and the subscribers hear the outcome. With kill switches read through a function, call `refresh()` after they change.

## The Lite tier

`src/lite.ts` holds the `SandboxTransport` contract that stage 1.10 implements with `/sandbox/innertube.html` and `/sandbox/userhost.html`:

- `selfTest({ signal })` sends one real InnerTube request and resolves with `'pass'`, `'refused'` or `'unreachable'`. `refused` is a definite answer from InnerTube: a readable error status, an unusable body, or a request that failed while the network otherwise works (in a browser a CORS refusal looks like a network error, so the sandbox checks that another request gets through). `unreachable` says nothing about the sandbox: offline, a timeout, a document that did not load. A rejection counts as `unreachable`. It must stop when `signal` aborts.
- `innerTube(request)` sends a request in the simple shape and resolves with InnerTube's response whatever its status (the transport reads 429 and `LOGIN_REQUIRED` from it), rejects with a `Network` `FxmError` when no response arrives, and refuses other hosts, paths and shapes with `Unsupported` before sending anything.
- The optional `userHost(url, init)` fetches from a user-added host, `GET` or `HEAD` only, never following a redirect to another host.

`createLiteTier({ sandbox, killSwitches, budget })` is the gate the transport and the capabilities share. `ready` is true while the self-test passed and the kill switch is off, so flipping the switch closes the route at once; `state` (`unchecked`, `checking`, `passed`, `refused`, `unreachable`, `killed`) is for Settings → Diagnostics, and `subscribe` reports its changes. The self-test draws one `interactive` slot and the gate waits for it at most 10 s (`selfTestTimeoutMs`), then aborts it. Only a definite answer is kept for the session: after an `unreachable` one the tier tries again by itself after 15 s, then twice as long each time up to 5 minutes, for 8 attempts, and whenever the browser comes back online, so a PWA opened offline reaches Lite without a reload. `check({ force: true })` runs the self-test again; the tier stays ready while a forced re-run after a pass is under way.

`killSwitches` is a function or a `KillSwitchSource` (`get()` and `subscribe()`); `createKillSwitchStore()` is one the app sets whenever a new remote config arrives.

`createSandboxTransport()` (`src/sandbox/`) is the implementation: it frames each document on first use, hidden, with `sandbox="allow-scripts"` and a random token in the URL's fragment that the document must send back, and talks to it over a private `MessagePort`. Refused requests reject with a `SandboxRefusedError` (a `TransportError`), failed ones with a `SandboxFailedError` (`Network` or `Parse`). Both documents are generated from `src/sandbox/document.ts` into `apps/web/sandbox/`. How they stay opaque, what each sends, their errors and protocol, the browser tests, and the 2026-10-26 test record (Chromium 156 and Firefox 157 played a song to its end through the sandbox, with stage 1.3's search and 1.4's resolver; Safari not tested) are in [src/sandbox/README.md](src/sandbox/README.md).

## Native transports

Desktop and Android reach every host directly through a `NativeHttp` function: `(url, init) => Promise<Response>`. On top of it, `createNativeTransport` applies the routing, the budget, the header policy and the redirect checks. `init` carries:

| Field | Meaning |
|---|---|
| `method`, `body`, `signal` | As in `fetch`; the body as text or bytes |
| `headers` | Every header to send, a plain object with lower-case names, never `origin` or `cookie`. Headers never travel inside a `Request` object, whose forbidden headers a webview drops |
| `origin` | The `Origin` header: `null` for none, else the value. `null` for everything but Spotify, which gets `https://open.spotify.com`: InnerTube refuses every webview origin (`tauri://localhost`, `http(s)://tauri.localhost`, `https://localhost`, a dev server) with 403 |
| `route` | How the transport routed the request. `user` routes go through the check of the user's approved hosts |
| `credentials` | Always `omit`: the request neither sends nor stores cookies |
| `redirect` | Always `manual`: return the 3xx response with its `Location`; the transport follows it |

The native HTTP must resolve with a `Response` for every HTTP status and reject only when no response arrives. Its client keeps no cookie jar at all: OkHttp with `CookieJar.NO_COOKIES` (Media3 may keep a client of its own), plugin-http built without its `cookies` feature. The user's Spotify login cookies are only ever used by the token commands of stages 7.4 and 6.5, through `spotifySession`, never through `NativeHttp`. With `userAgent`, YouTube and Spotify requests that carry no `User-Agent` get that browser one: Spotify refuses non-browser agents.

- **Tauri (stage 7.2):** `createTauriTransport({ budget, http: createDesktopFetch() })`, which `createPlatform()` sets up by itself when it finds Tauri's runtime (`isTauriRuntime()`). `createDesktopFetch()` wraps `@tauri-apps/plugin-http` built with `unsafe-headers`: it passes `''` for `origin: null` (the plugin then removes the header), `maxRedirections: 0`, and sends `user` routes through a Rust command that checks the approved list, since plugin-http's scopes cannot change at run time. See [Desktop](#desktop).
- **Capacitor (stage 6.2):** `createCapacitorTransport({ budget, http: createAndroidHttp() })`. `createAndroidHttp` (`src/android-http.ts`) is the `NativeHttp` over `FxmHttp`, FXM's OkHttp plugin in [`apps/mobile/android/fxm-http`](../../apps/mobile/android/fxm-http/README.md), whose client has no cookie jar (`CookieJar.NO_COOKIES`) and is shared with the Media3 player. `createPlatform` uses it by itself on Android when the app has the plugin (`androidHttpIfAvailable`). Never Capacitor's global `CapacitorHttp` patch or `CapacitorHttp.request`: the patch drops headers and corrupts binary bodies, and both send and store WebView cookies. The app replaces Capacitor's built-in `CapacitorHttp` plugin with one that refuses every call.

  The adapter sends `init.origin` as the plugin's `origin` header (`''` for `null`, which the plugin sends as no `Origin`) and every request with `redirect: 'manual'`. The response resolves once its headers are in, and its body streams: JavaScript pulls base64 chunks of up to 256 KiB from the plugin, so any byte survives the bridge. Aborting cancels the native call. Failures are as in `fetch` (`TypeError`), except that refusals by the plugin's own copy of FXM's rules are `TransportError`s with the reason the transports give for the same refusal (`unknown-host`, `bad-request`, `redirect`). On Android leave `userAgent` unset: the plugin gives every request without one a reduced Chrome agent, without the device model, Android build and WebView marker that `navigator.userAgent` carries there.

  **Read or cancel every body.** The plugin holds each open response in one of 64 slots until its body is read to the end or cancelled (`response.body?.cancel()`). A body dropped unread is released when the page collects it (a `FinalizationRegistry`), and the plugin frees a slot nobody reads after a minute, or after five seconds when every slot is taken; until then it holds memory and a connection.

  **User hosts.** A `user` route whose own host the user has not approved shows a system dialog, once per host at a time, and is retried if they allow it. After "Don't allow", requests to that host fail at once (`unknown-host`) for the rest of the session; only `approveHosts`, which Settings calls, asks again. No dialog ever names a host of FXM's own services or the target of a redirect: the adapter asks only about the request's own host, and the plugin refuses to approve a host on the table. `approveHosts`, `approvedHosts` and `revokeHosts` on the returned function serve Settings; every `createAndroidHttp` over the same plugin shares the questions and refusals. The bridge protocol and the native rules are in the module's [README](../../apps/mobile/android/fxm-http/README.md).

Without `http`, both are stubs: CORS-friendly hosts through the webview's own `fetch` (on Android the unpatched one, `unpatchedFetch()`), and a `RouteUnavailableError` (needs `native`) naming the missing stage for everything else.

`createNodeTransport({ budget })` reaches everything directly with Node's `fetch`, with the same allow-list, request shape, redirect checks and budget, for tests and the live smoke tests (`FXM_LIVE=1`).

## Desktop

`createDesktopFetch()` (`src/desktop.ts`) is the desktop app's `NativeHttp`. It loads Tauri's bindings (`@tauri-apps/plugin-http` and `@tauri-apps/api`) on its first request, so a browser never downloads them, and sends:

- **Hosts in the table** through Tauri's HTTP plugin, whose scope in the app's `capabilities/default.json` lists exactly those hosts and whose `scopeRedirects` setting checks every redirect against it. A refused address, a redirect's included, rejects with an `Unsupported` `FxmError`; a network failure with a `TypeError`, and an abort with the signal's reason, as `fetch` does. Reading the body fails the same way: the plugin's own stream errors with bare strings, which `createDesktopFetch()` turns into the signal's reason or a `TypeError`.
- **Any other host** through the app's `user_host_fetch` Rust command, which reaches only hosts the user approved, by `GET` or `HEAD`, over HTTPS, to public addresses, never through a proxy, with at most 8 MiB in 30 s. Its refusals reject with an `Unsupported` `FxmError` (`Parse` for a response that is too large).

Error messages name a URL only by its scheme, host and path (`describeUrl`, `redactUrls`): a googlevideo URL's query carries the user's IP address and signatures. The plugin's own error stays in `cause`.

It enforces the header policy once more at the last step, whatever the caller sent:

- `origin` is `''` (no `Origin` header, which needs the plugin's `unsafe-headers` feature) unless it is the `https:` origin of a real site, such as Spotify's: the webview's own origin (`tauri://localhost`, `http(s)://tauri.localhost`, a dev server's) never goes out (`siteOrigin`);
- a request that names no User-Agent gets one by service (`sendsBrowserAgent`), never the plugin's `tauri-plugin-http/<version>`, which Spotify refuses:

  | Hosts | User-Agent |
  |---|---|
  | Every host YouTube (Google) or Spotify runs: InnerTube, googlevideo, Spotify's API hosts and their image servers `i.ytimg.com`, `*.ggpht.com` and `i.scdn.co`; Last.fm's web player | A browser's (`desktopBrowserUserAgent`: the webview's own, completed to Safari's on macOS), as on the web, so FXM's traffic doesn't stand out from the same address's other requests |
  | Services that ask apps to name themselves: MusicBrainz, Cover Art Archive, ListenBrainz, the Last.fm API, LRCLIB, Internet Archive, Jamendo, iTunes Search, SponsorBlock | FXM's own (`fxmUserAgent`) |

- headers go only in `init.headers`, as a plain object; `Cookie` and `Host` are never sent, and `Set-Cookie` never reaches the caller.

These rules bind whatever calls `ctx.fetch`. Page script that calls Tauri's IPC itself bypasses this module. The desktop app's isolation hook applies the `Origin`, `Cookie` and `Host` rules to what reaches the plugin and drops its per-request `proxy` option, whatever the message's shape or command, except in a start-up gap (see [apps/desktop/README.md](../../apps/desktop/README.md#what-page-script-can-reach)).

`createDesktopUserHosts()` is the client for the approved hosts: `refresh()` and `current()` read the list, which Rust keeps, `revoke(host)` shrinks it, and `approve(host)` asks the user in a native dialog. Only that dialog can grow the list, so no page script can make `user_host_fetch` reach a host the user didn't approve. That binds this command only: the app's README lists what else page script can reach. Rust asks only while FXM's window is in front, at most once every 10 seconds after the last answer, and never again about a host the user refused this session; on macOS and Windows "Don't Allow" is the default button. Pass `userHosts: () => hosts.current()` to `createPlatform()`, so the transport routes those hosts.

The app side, its scope, permissions and content security policy are in [apps/desktop/README.md](../../apps/desktop/README.md#network).

## Test helpers

`@fxm/platform/testing` exports fakes for this package's tests and the apps' (never import it from app code):

- `createFakeClock()`: a `Clock` whose time only the test moves; `advanceAsync` lets promises settle between timers.
- `createFakeSandbox()`: a `SandboxTransport` that refuses requests the real sandbox could not send (not CORS-simple, or not one of the allowed InnerTube paths) and records the rest. `selfTest` answers `'pass'` unless told otherwise.
- `installFakeConnect(window)`: marks a page and answers pings and bridge requests the way FXM Connect's content script does.
- `createFakeFxmHttp(options)`: the Android app's `FxmHttp` plugin, answering from a handler that returns a `Response`. It streams bodies in chunks, honours aborts, hands redirects back as they are, and refuses hosts as the native plugin does (`HOST_NOT_APPROVED` with `data.host`, which `answer` can then approve). `fxmHttpError(code)` makes the errors the plugin rejects with.
- `createTestSigner()`, `fakeUpdateSite()` and `nodeModuleImporter`: a throwaway update signing key, a fake static site for signed updates, and a way to load verified modules in Node ([`src/updates/`](src/updates/README.md)).

Tests that need a page create their own happy-dom `Window` at the FXM origin: in Vitest's global happy-dom environment, a message's `event.source` is not the page's `window`. happy-dom delivers `postMessage` on real timers, so the clients take an injectable `clock` for their timeouts.

```sh
scripts/run.sh pnpm vitest run packages/platform                      # this package's tests
scripts/run.sh pnpm vitest run --coverage --coverage.include='packages/platform/src/**' packages/platform
scripts/run.sh pnpm --filter @fxm/platform typecheck
scripts/run.sh pnpm --filter @fxm/platform test:e2e                 # the sandbox documents in Chromium and Firefox
scripts/run.sh pnpm --filter @fxm/platform test:e2e:updates         # a signed module loaded from blob: (src/updates/e2e)
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | The public API |
| `src/platform.ts` | `detectEnvironment`, `createPlatform`, `FxmPlatform.context` and `report` |
| `src/transport.ts` | The shared transport core: classification, request forms, budget draws, redirects, bot-check reports |
| `src/web.ts`, `src/node.ts`, `src/native.ts`, `src/tauri.ts`, `src/capacitor.ts` | One transport per environment, and the native contract |
| `src/android-http.ts` | The Android app's native HTTP over the `FxmHttp` plugin (stage 6.2) |
| `src/desktop.ts` | The desktop app's native HTTP and its approved hosts (stage 7.2) |
| `src/errors.ts` | `TransportError` and `RouteUnavailableError` |
| `src/hosts.ts`, `src/cors.ts`, `src/innertube.ts` | The host table, the CORS safelist and the InnerTube request shape |
| `src/budget.ts` | The shared request budget and `BudgetError` |
| `src/connect.ts` | FXM Connect detection and the bridge client |
| `src/spotify-session.ts` | The Spotify login's token source |
| `src/lite.ts` | The `SandboxTransport` contract, the Lite tier's gate and the kill switches |
| `src/capabilities.ts` | Capability rules, detection and the monitor |
| `src/clock.ts`, `src/storage.ts` | Injectable time and key-value storage |
| `src/testing/` | The test helpers |
| `src/sandbox/` | The Lite tier's sandbox documents and `createSandboxTransport` (stage 1.10, [its README](src/sandbox/README.md)) |
| `src/updates/` | Signed updates for the desktop and Android apps: the YouTube config and resolver module, verified with Ed25519 ([its README](src/updates/README.md), stage 1.13) |

`src/evaluator/` (1.11) belongs to a later stage.

See [ARCHITECTURE.md §8](../../docs/ARCHITECTURE.md#8-platforms-and-network-transports).
