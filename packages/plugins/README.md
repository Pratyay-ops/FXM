# @fxm/plugins

Runtime-loadable sources and resolvers (stage 8.3). A plugin is a manifest and a script that other people write. FXM ships none, keeps no catalogue and knows no default address: the user adds a plugin from an address or a file they pick, after seeing which hosts it may contact.

- **Checksummed and versioned.** The manifest declares the SHA-256 of the code, and FXM refuses code that doesn't match, when it is added, when it is installed and whenever its stored copy is read. Versions only go up, and an update is installed only once the user approves it.
- **Isolated.** The code runs only in a worker that the isolated evaluator of stage 1.11 starts, never in FXM's page and never in the evaluator's document itself, and each plugin gets a document and a worker of its own (see [Where plugins run](#where-plugins-run)).
- **Fenced in.** A plugin reaches the network only through `ctx.fetch`, which the host checks against the hosts its manifest declares and its request budget, and which goes out through the platform's own `fetch` (see [The network](#the-network)).
- **Checked.** What a plugin returns is checked and turned into `@fxm/core`'s types. FXM builds every ID itself, and every URL in a result must be on a declared host.

FXM has no servers: plugins run on the user's device, like every built-in provider.

## For the app

```ts
import { createSandboxEvaluator } from '@fxm/platform'
import { createPluginRegistry, isolatedSandboxes } from '@fxm/plugins'

const registry = createPluginRegistry({
  store, // a PluginStore: IndexedDB in the web app (apps/web/src/features/plugins/plugins-db.ts)
  sandboxes: isolatedSandboxes(() => createSandboxEvaluator()), // a document per plugin
  budgetStorage: localStorage, // the plugins' request budgets, shared by tabs and reloads
})
await registry.load()

// Platform: the hosts of the plugins that are on, and of a download in progress, are user hosts.
const platform = await createPlatform({ userHosts: () => registry.hosts() })

// Adding: fetch and check, show the offer, install only what the user approved.
const offer = await registry.offerFromAddress(address, (url, init) => platform.transport.fetch(url, init))
// or: const offer = await registry.offerFromFile(await file.text(), file.name)
showDialog(offer.package.manifest, offer.addedHosts) // name, version, hosts, what it adds, origin, SHA-256
await registry.install(offer) // on "Add plugin": checks the package again, then stores it

// Using: the providers of the plugins that are on.
for (const { metadata, audio, recommendations } of registry.providers()) {
  if (metadata) sources.register(metadata) // MetadataProvider, requestPolicy 'explicit'
}

// Updating: only when the user asks, and installed only once they approve the offer.
const update = await registry.checkForUpdate(id, fetch) // undefined when up to date
```

| `PluginRegistry` | What it does |
|---|---|
| `load()`, `reload()` | Reads the store (again, e.g. when another tab changed it) and starts the plugins that are on. A read that failed (IndexedDB busy, say) is tried again by the next `load()`, and a `reload()` that works takes its place |
| `entries()`, `subscribe(listener)` | The installed plugins for the settings page, by name; the same array until something changes. A `PluginEntry` has its `name`, `version`, origin, `enabled` and dates, and either its `manifest` (it can run) or a `problem` (it can't): `{ code: 'damaged' }` for a stored copy that fails its checks, `{ code: 'needs-newer-fxm', minFxmVersion, appVersion }` for one this FXM is too old for. Each has an English `message` for logs; the app words the codes itself |
| `providers()` | The `PluginProviders` of the plugins that are on and can run: `metadata` (a `MetadataProvider`) when the plugin can `search`, `audio` (an `AudioSource`) when it can `resolve`, `recommendations` (a `RecommendationProvider`) when it has `radio`. Each has `requestPolicy: 'explicit'` (see [The network](#the-network)) |
| `hosts()` | The hosts those plugins declare, plus the host of a download in progress: the platform's user hosts |
| `offerFromAddress(address, fetch)`, `offerFromFile(text, name)` | Fetch or read a plugin and check it, without installing anything, against the stored copies (both read the store first). The `PluginOffer` holds the package and, for an update, the installed entry and the hosts and operations it adds and drops |
| `install(offer)` | Installs an approved offer, switched on. It checks the package again as if it had just been read (manifest, checksum, origin, FXM version), so an offer built by hand gets no further, and against the installed version as it is now: an offer that is no longer newer is refused (`not-newer`) |
| `setEnabled(id, enabled)`, `remove(id)` | Switches a plugin; off, it has no providers, no hosts and no document. Removing also drops its request budget |
| `checkForUpdate(id, fetch)` | Downloads the plugin again from the address it was added from and offers it when its version is higher. A plugin added from a file updates from a newer file |
| `dispose()` | Stops every plugin |

Versions only go up, with one exception: a plugin that can't run (`problem`) may be replaced by any version, which repairs it, and `checkForUpdate` then offers whatever its address serves.

### Errors

The failures of plugins and of the checks are `PluginError`s: `FxmError`s with a code the app knows, plus a `pluginCode`: `invalid-manifest`, `invalid-file`, `checksum-mismatch`, `too-large`, `needs-newer-fxm`, `unsupported-api`, `not-newer`, `id-mismatch`, `download-failed`, `load-failed`, `not-implemented`, `plugin-failed`, `bad-result`, `bad-reply`, `timeout`, `too-many-requests`, `disabled`, `wrong-source`, `unreachable`, `unavailable`. A store that fails rejects with its own error, and a cancelled call with its signal's reason.

The `FxmError` code decides what the player does with a plugin's track (`classifyFailure` of `@fxm/player`), so one broken plugin or track never stops the queue:

| `code` | The player | `pluginCode`s |
|---|---|---|
| `Unavailable` | Skips the item | `load-failed`, `not-implemented`, `plugin-failed` (unless the plugin named a code below), `bad-result`, `bad-reply`, `too-many-requests`, `disabled`, and every request that breaks the plugin's rules (an undeclared host, a method, header or body it may not send, a redirect elsewhere, a response over 2 MiB) |
| `NotFound`, `GeoBlocked` | Skips the item | `wrong-source` (`NotFound`), or what the plugin failed with |
| `Network`, `RateLimited`, `Parse`, `Expired` | Retries | `timeout` (`Network`), the plugin's request budget or its host's `429` (`RateLimited`), or what the plugin failed with |
| `Unsupported` | Stops until the user acts | `unavailable` (no isolated evaluator, or no worker in it), `unreachable` (the platform closed its route to the plugin's hosts: the `cause` is its `RouteUnavailableError`, which says what would open it) |

A plugin may fail with `fxm.fail(code)` for the codes `NotFound`, `Unavailable`, `GeoBlocked`, `RateLimited` (its `retryAfterMs` kept within an hour), `Network`, `Parse` and `Expired` (`PLUGIN_FAIL_CODES`); any other code becomes `Unavailable`. A bot check, a login or "FXM can't reach this here" are the platform's to report: a plugin can't claim them. The adding and updating codes (`invalid-manifest` to `download-failed`) never reach the player.

## Writing a plugin

A plugin is two files, or one plugin file that holds both.

### The manifest (`fxm-plugin.json`)

```json
{
  "fxmPlugin": 1,
  "id": "example-radio",
  "name": "Example Radio",
  "version": "1.2.0",
  "description": "Songs from the Example Radio archive.",
  "author": "Someone",
  "homepage": "https://example.org/fxm",
  "license": "MIT",
  "minFxmVersion": "0.1.0",
  "hosts": ["api.example.org", "media.example.org"],
  "entry": "plugin.js",
  "sha256": "<the SHA-256 of plugin.js, 64 hexadecimal digits>",
  "provides": ["search", "album", "resolve"],
  "requestsPerHour": 120
}
```

| Field | Rule |
|---|---|
| `fxmPlugin` | The plugin API version: `1`. A newer one is refused with `unsupported-api` |
| `id` | Its name in IDs, like a DNS label: 1 to 63 lower-case letters, digits and hyphens, not starting or ending with a hyphen. Its source is `plugin.<id>` (`@fxm/core`), and an update must keep it |
| `name`, `description`, `author`, `license` | Text for people, at most 60, 500, 100 and 64 characters; control characters and runs of white space become one space |
| `version` | `major.minor.patch`, no pre-release. An update must have a higher one |
| `minFxmVersion` | The oldest FXM your plugin runs on, `major.minor.patch`. Every FXM that speaks `fxmPlugin` 1 runs a plugin whose `minFxmVersion` is at most its own version, so `"0.1.0"` means any of them; set a later one when your plugin needs something a later FXM added (Settings shows the version). An older FXM refuses the plugin with `needs-newer-fxm`, before it reads any other field, so a plugin that lists an operation or a form of host only a newer FXM knows is refused for its version, not as invalid. A build made from source between releases reports `0.0.0` (`DEVELOPMENT_VERSION`) and runs any plugin, for testing |
| `homepage` | An `https://` URL |
| `hosts` | At most 16 hosts it may contact, `host` or `host:port`, exactly: no wildcards, no IP addresses, no names in the user's own network (`localhost`, `.local`, `.lan`, `.home.arpa`, `.internal` and the like), no Unicode (write `xn--` names, so that lookalike letters can't hide a host), and none of the hosts FXM itself reaches with its own privileges: YouTube's and YouTube Music's, googlevideo, Spotify and Last.fm's stations (`reservedServiceOf`, from `@fxm/platform`'s host table). A plugin's requests there would go out through FXM Connect or the Lite tier's YouTube document, and draw on the device's YouTube budget. FXM's open services, such as MusicBrainz or Internet Archive, are allowed. An empty list is a plugin that reaches nothing |
| `entry` | The code's path relative to the manifest's URL, on the same origin |
| `sha256` | The SHA-256 of the code file's bytes: `shasum -a 256 plugin.js` or `sha256sum plugin.js` |
| `provides` | What it does: `search` (a source; `suggest`, `track`, `album`, `artist`, `playlist` and `radio` need it), `match` (audio for tracks of other sources; needs `resolve`) and `resolve` (stream URLs for its candidates) |
| `requestsPerHour` | Its request budget, 1 to 600; 120 when absent |

Fields FXM doesn't know are ignored. FXM shows `hosts` before the plugin is added, and again, with what changed, before an update.

The host rules check names only: FXM resolves nothing when it reads a manifest, so a public name whose DNS points at `127.0.0.1` or a private address, or that changes its address between requests (DNS rebinding), passes them. On the web, what a plugin could read there is limited by the opaque origin its requests come from (the answer needs `Access-Control-Allow-Origin`) and by Chromium's Private Network Access. The native user-host fetches of the desktop and Android apps have neither, which is one reason plugins wait there (see [Pending](#pending)).

### The code

The code is the body of a function of `fxm`, in strict mode, in a worker of its own with no network, no storage, no DOM and no access to FXM's page. It registers one async handler per operation it `provides`; each handler gets one input object, then `ctx`:

```js
const API = 'https://api.example.org'

async function get(ctx, path) {
  const response = await ctx.fetch(API + path)
  if (response.status === 404) fxm.fail('NotFound', 'Not in the archive')
  if (!response.ok) throw new Error('The archive answered ' + response.status)
  return response.json()
}

fxm.register({
  async search({ query, cursor }, ctx) {
    const data = await get(ctx, '/search?q=' + encodeURIComponent(query))
    return { tracks: { items: data.songs.map(toTrack), nextCursor: data.next } }
  },
  async album({ id }, ctx) {
    const data = await get(ctx, '/albums/' + encodeURIComponent(id))
    return { id: data.id, name: data.title, artists: [data.artist], tracks: data.songs.map(toTrack) }
  },
  async resolve({ candidate }, ctx) {
    return [{ url: 'https://media.example.org/' + candidate.id + '.mp3', codec: 'mp3', container: 'mp3', bitrateKbps: 192 }]
  },
})
```

| Handler | Input | Returns |
|---|---|---|
| `search(input, ctx)` | `{ query, types, limit, cursor }`: the query, the types FXM wants (`track`, `video`, `album`, `artist`, `playlist`), a page size up to 50, and the cursor of a page the plugin returned | `{ tracks, videos, albums, artists, playlists }`, each a list or `{ items, nextCursor, total }`. Songs and videos are sorted by `kind`, whichever list they are in; `videos` stays empty in Music mode |
| `suggest(input, ctx)` | `{ query }`: a partial query | Up to 20 strings |
| `track`, `album`, `artist` | `{ id }`: one of its own IDs | One track; an album with `tracks`; an artist with `topTracks`, `albums` and `related` |
| `playlist(input, ctx)` | `{ id, limit, cursor }`: one of its own IDs, and a page | A playlist with `tracks` as a page |
| `radio(input, ctx)` | `{ seed }`: `{ type: 'track', title, artists, album, durationMs, isrc }` or `{ type: 'artist', name }`, with `id` when the seed is its own (or FXM linked the track to it before) | Tracks |
| `match(input, ctx)` | `{ track }`: `{ title, artists, album, durationMs, isrc }` of a track from another source. FXM never calls it for its own tracks, or for tracks FXM linked to it before: it uses their IDs | Candidates: `{ id, title, artists, durationMs, confidence, kind, evidence }` |
| `resolve(input, ctx)` | `{ candidate }`: `{ id, title, artists, durationMs }` of one of its candidates | Streams: `{ url, codec, container, bitrateKbps, sampleRateHz, bitDepth, media, expiresAt, ipBound, capped, downloadAllowed }` |

Later versions of FXM may add fields to these inputs; a plugin ignores those it doesn't know.

A track is `{ id, title, artists, album, durationMs, artwork, explicit, isrc, kind, songId, trackNumber, discNumber, releaseDate, popularity, tags }`, where `artists` are names or `{ id, name }`, `album` a name or `{ id, name }`, `artwork` URLs or `{ url, width, height }`, and `kind` `song` (the default), `music-video`, `video` or `episode`. Albums, artists and playlists follow `@fxm/core`'s model the same way. IDs are the plugin's own, spelled one way only; FXM makes `plugin.<id>:<kind>:<native ID>` of them. Anything malformed in a list is dropped, a malformed result as a whole fails the call (`bad-result`), texts are cut (titles to 300 characters, lists to 200 items), a whole result may be at most 4 MiB of JSON, and artwork and stream URLs must be `https:` on a declared host.

FXM can't check a plugin's stream URL, so every stream is `unverified` (the player's first request is the probe) unless the plugin says it is `capped`; only progressive streams are taken, and none carries request headers. The playback policy and the matching engine weigh a plugin's candidates like any other; a plugin's own `confidence` is only its claim.

In the web app, streams play from any HTTPS host (the app's policy has `media-src https:`), but images load only from the hosts its `img-src` lists, so artwork on a plugin's own host doesn't show there; the desktop app's policy allows images from any HTTPS host.

`ctx` has `fetch`, `mode` (`music` or `all`), `platform`, `locale`, `region` and `signal`, which aborts when FXM gives up on the call. `fxm.fail(code, message, { retryAfterMs })` throws an error FXM reports with that `FxmError` code (see [Errors](#errors) for the codes it takes).

### `ctx.fetch`

`ctx.fetch(url, { method })` resolves with a `Response` once the host has fetched it:

- only `https:` URLs on the manifest's hosts, exactly as declared;
- `GET` or `HEAD`, without request headers and without a body: what the platforms' route to a plugin's hosts carries on every platform (a plugin's hosts are user hosts of `@fxm/platform`, whose route sends nothing else). A later plugin API may allow more;
- bodies come back as text (UTF-8), at most 2 MiB, within 20 s; binary bodies aren't supported;
- at most 30 requests per call, and `requestsPerHour` an hour.

A refused or failed request rejects with an error whose `code` says why: `host-not-declared`, `bad-request`, `rate-limited`, `redirect`, `too-large`, `refused` (the platform refused it) or `network`, and whose `fxmCode` is the code the call fails with if the plugin doesn't handle it (see [Errors](#errors)). The platforms never follow a redirect of a plugin's request to another host. In the web app, a plugin's own hosts are reached through the Lite tier's `userhost.html`, a document with an opaque origin, so the requests carry `Origin: null` and no cookies, and a plugin's host must answer with `Access-Control-Allow-Origin: *` (or `null`) for the web app to read the answer. So a plugin that works everywhere sends plain `GET`s to hosts that allow any origin, as many public APIs do.

### A plugin file

To hand someone one file, put both into a plugin file (`createPluginFile(manifest, code)` writes one):

```json
{ "fxmPluginFile": 1, "manifest": { "fxmPlugin": 1, "id": "example-radio", "…": "…" }, "code": "fxm.register({ … })" }
```

The `sha256` in its manifest is still the code's. A plugin file can also be served at an address.

### Hosting

An address serves the manifest, or the plugin file, itself, over HTTPS, without a redirect, with the code at `entry` on the same origin. The web app downloads through the same opaque-origin document as a plugin's own requests, so the files must allow any origin (`Access-Control-Allow-Origin: *`), as GitHub Pages and `raw.githubusercontent.com` do. FXM checks for an update by downloading the same address again, only when the user asks.

### Testing your plugin

The tests here use `@fxm/plugins/testing`: the tiny local test plugin (`TEST_PLUGIN_CODE`, an invented catalog on `catalog.fxm-plugin.test` under the `.test` domain that RFC 2606 keeps for tests), its manifest and plugin file, `fakeCatalogFetch()`, which answers it offline, and `inProcessSandboxes()`. Install your plugin in a registry over `inProcessSandboxes()`, which runs `eval.html`'s runtime in your test's realm and the plugin's worker in a fresh realm of the test process (`TestWorker`), and call its providers with a context whose `fetch` answers your requests. Its isolation is the browser's, so `browser.test.ts` checks that part in Chromium and Firefox.

## Where plugins run

The plugin's code runs only in a worker that a document of the isolated evaluator of stage 1.11 starts (`@fxm/platform`, [its README](../platform/src/evaluator/README.md)): on the web, `/sandbox/eval.html` in a `sandbox="allow-scripts"` frame, with an opaque origin and a policy that allows no network (`connect-src 'none'`), no images, no frames and workers only from `blob:` URLs (`worker-src blob:`). A worker started that way inherits the document's policy.

Why a worker, and not the document itself: a document's own scripts can open WebRTC connections, which no content security policy covers, and navigate their document, which carries data out in the URL; a script in the document also shares its thread with the page, in browsers that run the sandboxed frame in the page's process, so a loop that never ends would freeze FXM. A worker has no DOM, no `RTCPeerConnection` and no way to navigate, its `fetch`, sockets and imports reach nothing, and it runs on a thread of its own, which the document can stop.

| Piece | Where | What it does |
|---|---|---|
| The relay (`src/runtime/document.ts`) | The plugin's evaluator document | Starts the plugin's worker from a `blob:` URL holding the worker's runtime, hands it the plugin's code as text, then each message of the host, and gives the host its answer. It never compiles the plugin's code. It stops the worker when it hasn't answered within about 18 s (`hung`, so a plugin that loops forever is stopped), when it answers more than 4 MiB (`too-large`) or outside the protocol (`bad-reply`), and when it has sat idle for 90 s, so a plugin can't keep working between calls; the next call starts a new one. A worker that fails before it announces itself (its runtime always compiles) is one the browser can't start there: no plugin runs (`unavailable`) |
| The worker's runtime (`src/runtime/worker.ts`) | The plugin's worker | Compiles the plugin's code as the body of a function (`new Function`, which the policy's `'unsafe-eval'` allows there), so code that doesn't compile is a `load-failed` answer and can't reach outside its function; runs its handlers, gives them `ctx.fetch`, and answers in the plugin protocol (`src/runtime/protocol.ts`). It takes `postMessage` away before the plugin's code loads, so only it speaks to the document |
| The host (`src/host.ts`) | FXM's page | Sends each call to the plugin's document through `Evaluator.evaluate`, relays the plugin's requests through the fetch broker, and checks every reply |

A call goes back and forth: `call` starts it, and the worker answers `done`, `failed`, `fetch` (the requests the handler made in one turn) or `idle` (the handler waits for something else); the host answers `fetch` with `resume` and the responses, `idle` with an empty `resume`, and sends `cancel` when it gives up. The host trusts nothing the document sends: every reply arrives as JSON text, longer than 4 MiB is refused before it is parsed, and every reply, request and result is checked. A call may take 45 s, a plugin runs 4 calls at once, and a worker 32.

| `PluginSandboxes` | Where | How |
|---|---|---|
| `isolatedSandboxes(create)` | The web: `create` is `() => createSandboxEvaluator()` | A document per plugin, created on its first call, stopped when the plugin is switched off, removed or updated. It refuses an evaluator of kind `in-process`, which would run plugins in the page; tests pass `IN_PROCESS_FOR_TESTS` through `inProcessSandboxes()` of `@fxm/plugins/testing` |

The relay and the worker's runtime are sent as text (`String(pluginRelay)`, `String(pluginWorker)`), so they use nothing outside their own functions; `worker.test.ts` runs the worker's script in a fresh realm to keep it so.

**Browsers.** Chromium and Firefox run plugins this way (`browser.test.ts` passes in both, `FXM_BROWSER_ENGINE=firefox` for the second). WebKit, and so Safari, starts no worker from the `blob:` URL of an opaque origin ("blocked … from loading", Playwright's WebKit 2370 on 2026-10-26), so plugins don't run there: every call fails with `unavailable`, and nothing runs in the document instead (see [Pending](#pending)).

## The network

Each request a plugin makes passes the fetch broker (`src/broker.ts`), in this order:

1. **Declared hosts only:** `https:`, no credentials, the host exactly as declared, and none of FXM's own privileged hosts (checked again here). Anything else is refused before a byte is sent.
2. **A shape FXM can carry:** `GET` or `HEAD`, no headers, no body.
3. **The plugin's request budget:** a `RequestBudget` of `@fxm/platform` (stage 1.2) per plugin, with `requestsPerHour` as its hourly limit, stored under `fxm.plugins.budget.<id>`, so reloads and tabs share it. Each request takes its slot at the priority of its operation: `resolve` (a song is waiting) at `current-track`, everything else at `interactive`. Searches and pages stop with a quarter of the hour left and prefetching with a tenth (`pluginReserves`), so the stream of the song the user is waiting for can still be found. A `429` from a plugin's host pauses its requests for its `Retry-After`, from one minute to one hour.
4. **The platform's `fetch`:** the request goes out through the `ctx.fetch` of the provider call, so the platform's rules apply on top: its host table and user hosts, `credentials: 'omit'`, no `Origin` or `Cookie`. A route the platform has closed (the web app's sandbox documents missing, say) fails the call as `unreachable`, which the host knows from the platform's own error, never from the plugin.
5. **The answer:** a response that ended on an undeclared host is refused; `Set-Cookie` is never passed on.

**Only what the user asks of it.** Each of a plugin's providers has `requestPolicy: 'explicit'` (`@fxm/core`'s `MetadataProvider`, `AudioSource` and `RecommendationProvider`): its catalog is called only for a search with its source picked or one of its pages, its `match` only for a track the user asked it about, and its radio only when the user asked it for one. FXM never sends a plugin the user's other searches, the songs they play from other sources, or background work. Its `resolve` runs whenever one of its own candidates plays.

What a plugin can still do: learn what the user asks of it, send that to its declared hosts, return wrong results within the checks above, and use its own worker's CPU and memory until the relay stops it. What it can't: run in FXM's page or in its evaluator document, read FXM's storage, library, tokens or cookies, contact another host (also not through WebRTC, a navigation, an import or a socket), read another plugin's state, or exceed its budget.

## F-Droid builds

F-Droid's inclusion policy (Security & Legal Compliance, item 5, quoted in [`@fxm/platform`'s signed updates](../platform/src/updates/README.md#f-droid-builds)) forbids downloading executable code without explicit, opt-in consent that says the user bypasses F-Droid's checks. So an F-Droid build (`parseDistribution(FXM_DISTRIBUTION)` of `@fxm/platform`; `pluginPolicy(distribution).needsOptIn`) keeps plugins off, downloads and runs none and shows no way to add one, until the user turns them on with `PLUGINS_CONSENT`:

> **Turn on plugins?**
>
> Plugins add music sources and ways to play songs that other people write. With plugins on, FXM downloads a plugin only from an address or a file you choose, shows which addresses it can contact, and asks before it installs an update.
>
> Plugins are code from their authors. They don’t come from F-Droid, and F-Droid hasn’t checked them: if you turn this on, you choose to bypass F-Droid’s checks for every plugin you add.
>
> You can turn plugins off again at any time in Settings. FXM then runs none of them.
>
> [Turn on] [Not now]

Both answers are buttons of the same style, neither preselected. The setting that turns plugins off again is labelled "Plugins (bypasses F-Droid’s checks)". Standard builds need no opt-in: adding a plugin is the user's explicit act, after the dialog that shows its hosts.

## Tests

```sh
scripts/run.sh pnpm vitest run packages/plugins                     # unit tests (offline)
FXM_BROWSER=1 scripts/run.sh pnpm vitest run packages/plugins/src/browser.test.ts
FXM_BROWSER=1 FXM_BROWSER_ENGINE=firefox scripts/run.sh pnpm vitest run packages/plugins/src/browser.test.ts   # or webkit
```

The unit tests cover the manifest's rules (FXM's own hosts, forward compatibility, development builds), checksums, plugin files and downloads (also cancelled, oversized, mismatched and from other origins) and checking a package again, the worker's runtime (in a fresh realm), the relay (a worker of its own, code that doesn't compile, a plugin that stops answering or sits idle, a worker that answers too much or outside the protocol, a document without workers), the host's protocol loop over the real evaluator runtime in-process (requests in one turn, refused hosts, the budget and its priorities, the request limit, timeouts, cancelling, code that doesn't load, the codes a plugin may fail with, a closed route, oversized and malformed replies, concurrency), the broker's rules, every result mapper, the sandboxes, the registry (offers, approvals, re-checks at install, updates, downgrades and repairs, damaged copies, a changed copy of the same length, switching, removing, downloads' hosts, other tabs, a store that fails once) and the providers end to end with the tiny local test plugin. The web app's tests play a plugin's song through the stream lifecycle and the player, and skip one whose plugin breaks its rules. `browser.test.ts` runs the committed `eval.html` in headless, muted Chromium (or Firefox, or WebKit, where it checks that plugins fail closed), served with stage 2.8's header policy and driven by `createSandboxEvaluator`: it installs the test plugin and searches it through the real evaluator; a probe plugin finds its worker opaque, without a DOM, WebRTC or `postMessage`, with `fetch`, `importScripts`, sockets, nested workers, navigation and storage blocked, reaching only what the host fetches for it, in a document of its own, while no request leaves the browser; a plugin whose code doesn't compile is reported as one that can't load; a plugin that loops forever is stopped after about a second while the page's own timers run on; and a document whose policy allows no workers runs no plugin.

## Pending

- **Desktop and Android.** The evaluator plugins of 1.11 there open one document at a time (a new `open` destroys the last, whoever opened it), and their native networking reaches user hosts only after the user approves each in a native dialog (`createDesktopUserHosts().approve`, `createAndroidHttp().approveHosts`). Before plugins run there:
  - an evaluator owner in `@fxm/platform` that leases documents to 1.11's rungs and to plugins alike, a fresh one whenever the holder changes, and a `PluginSandboxes` over it;
  - checking in the apps themselves that the worker isolation holds in their webviews (no WebRTC, no navigation, no network from the worker, workers from `blob:` URLs at all, which the `fxm-eval:` scheme and the Android WebView's base URL may treat differently);
  - the owner's decision on running third-party code in the Android evaluator, whose document runs at `https://www.youtube.com` (its worker has that origin too, in a WebView profile of its own that is cleared when it opens and closes);
  - native user-host fetches that resolve each connection's address and refuse loopback, private, link-local and unique-local ones on every connection, so that a plugin's public name can't reach the user's own network, with a test for it;
  - asking the native host lists about a plugin's hosts when it is added.

  Until then the web app's Plugins section says that plugins come to those apps later.
- **Safari.** WebKit refuses workers from an opaque origin's `blob:` URLs (see [Browsers](#where-plugins-run)), so plugins can't run in Safari. It does start a worker from a `data:` URL, which the evaluator's policy would have to allow (`worker-src blob: data:`): before that, check in every engine that such a worker inherits the evaluator document's policy, and so reaches nothing either.
- **Matching and radio.** The web app adds every plugin's `audio` to its stream lifecycle (`StreamLifecycle.addSource`), so a plugin's own songs play through its `resolve`. Its `match` (audio for tracks of other sources) and its `radio` are ready but unused: the app's matching engine and radio take their sources from the composition root, which doesn't follow plugins yet. When they do, they keep to `requestPolicy: 'explicit'`: only for a track or a radio the user asked that plugin for.
- **Artwork on the web.** The web app's `img-src` lists FXM's own image hosts only, so a plugin's artwork doesn't show there; allowing it would mean `img-src https:` in stage 2.8's policy, which lets the page load images from any host.
