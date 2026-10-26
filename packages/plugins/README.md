# @fxm/plugins

Runtime-loadable sources and resolvers (stage 8.3). A plugin is a manifest and a script that other people write. FXM ships none, keeps no catalogue and knows no default address: the user adds a plugin from an address or a file they pick, after seeing which hosts it may contact.

- **Checksummed and versioned.** The manifest declares the SHA-256 of the code, and FXM refuses code that doesn't match, when it is added and whenever its stored copy is read. Versions only go up, and an update is installed only once the user approves it.
- **Isolated.** The code runs only in the isolated evaluator of stage 1.11, never in FXM's page, and each plugin gets a document of its own (see [Where plugins run](#where-plugins-run)).
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
// or: const offer = registry.offerFromFile(await file.text(), file.name)
showDialog(offer.package.manifest, offer.addedHosts) // name, version, hosts, what it adds, origin, SHA-256
await registry.install(offer) // on "Add plugin"

// Using: the providers of the plugins that are on.
for (const { metadata, audio, recommendations } of registry.providers()) {
  if (metadata) sources.register(metadata) // MetadataProvider, requestPolicy 'explicit'
}

// Updating: only when the user asks, and installed only once they approve the offer.
const update = await registry.checkForUpdate(id, fetch) // undefined when up to date
```

| `PluginRegistry` | What it does |
|---|---|
| `load()`, `reload()` | Reads the store (again, e.g. when another tab changed it) and starts the plugins that are on |
| `entries()`, `subscribe(listener)` | The installed plugins for the settings page (`PluginEntry`: manifest, origin, `enabled`, dates, and a `problem` when the stored copy fails its checks or needs a newer FXM), by name; the same array until something changes |
| `providers()` | The `PluginProviders` of the plugins that are on and can run: `metadata` (a `MetadataProvider`) when the plugin can `search`, `audio` (an `AudioSource`) when it can `resolve`, `recommendations` (a `RecommendationProvider`) when it has `radio` |
| `hosts()` | The hosts those plugins declare, plus the host of a download in progress: the platform's user hosts |
| `offerFromAddress(address, fetch)`, `offerFromFile(text, name)` | Fetch or read a plugin and check it, without installing anything. The `PluginOffer` holds the package and, for an update, the installed entry and the hosts and operations it adds and drops |
| `install(offer)` | Installs an approved offer, switched on, checking it again first: an offer that is no longer newer than the installed version is refused (`not-newer`) |
| `setEnabled(id, enabled)`, `remove(id)` | Switches a plugin; off, it has no providers, no hosts and no document. Removing also drops its request budget |
| `checkForUpdate(id, fetch)` | Downloads the plugin again from the address it was added from and offers it when its version is higher. A plugin added from a file updates from a newer file |
| `dispose()` | Stops every plugin |

Every failure is a `PluginError`: an `FxmError` with a code the app knows, plus a `pluginCode` (`invalid-manifest`, `invalid-file`, `checksum-mismatch`, `too-large`, `needs-newer-fxm`, `unsupported-api`, `not-newer`, `id-mismatch`, `download-failed`, `load-failed`, `not-implemented`, `plugin-failed`, `bad-result`, `bad-reply`, `timeout`, `too-many-requests`, `disabled`, `unavailable`). A plugin that fails with `fxm.fail('NotFound')`, say, gives the error that `FxmError` code; a bot check is the platform's to report, so a plugin can't claim one.

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
  "minFxmVersion": "1.0.0",
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
| `version`, `minFxmVersion` | `major.minor.patch`, no pre-release. An update must have a higher `version`; FXM older than `minFxmVersion` refuses the plugin (`needs-newer-fxm`) |
| `homepage` | An `https://` URL |
| `hosts` | At most 16 hosts it may contact, `host` or `host:port`, exactly: no wildcards, no IP addresses, no names in the user's own network (`localhost`, `.local`, `.lan`, `.home.arpa`, `.internal` and the like), and no Unicode (write `xn--` names, so that lookalike letters can't hide a host). An empty list is a plugin that reaches nothing |
| `entry` | The code's path relative to the manifest's URL, on the same origin |
| `sha256` | The SHA-256 of the code file's bytes: `shasum -a 256 plugin.js` or `sha256sum plugin.js` |
| `provides` | What it does: `search` (a source; `suggest`, `track`, `album`, `artist`, `playlist` and `radio` need it), `match` (audio for tracks of other sources; needs `resolve`) and `resolve` (stream URLs for its candidates) |
| `requestsPerHour` | Its request budget, 1 to 600; 120 when absent |

Fields FXM doesn't know are ignored. FXM shows `hosts` before the plugin is added, and again, with what changed, before an update.

### The code

The code is the body of a function of `fxm`, in strict mode, in a document of its own with no network, no storage and no access to FXM's page. It registers one async handler per operation it `provides`:

```js
const API = 'https://api.example.org'

async function get(ctx, path) {
  const response = await ctx.fetch(API + path, { headers: { accept: 'application/json' } })
  if (response.status === 404) fxm.fail('NotFound', 'Not in the archive')
  if (!response.ok) throw new Error('The archive answered ' + response.status)
  return response.json()
}

fxm.register({
  async search(query, options, ctx) {
    const data = await get(ctx, '/search?q=' + encodeURIComponent(query))
    return { tracks: { items: data.songs.map(toTrack), nextCursor: data.next } }
  },
  async album(id, ctx) {
    const data = await get(ctx, '/albums/' + encodeURIComponent(id))
    return { id: data.id, name: data.title, artists: [data.artist], tracks: data.songs.map(toTrack) }
  },
  async resolve(candidate, ctx) {
    return [{ url: 'https://media.example.org/' + candidate.id + '.mp3', codec: 'mp3', container: 'mp3', bitrateKbps: 192 }]
  },
})
```

| Handler | Gets | Returns |
|---|---|---|
| `search(query, { types, limit, cursor }, ctx)` | The query; the types FXM wants (`track`, `video`, `album`, `artist`, `playlist`), a page size up to 50, and the cursor of a page the plugin returned | `{ tracks, videos, albums, artists, playlists }`, each a list or `{ items, nextCursor, total }`. Songs and videos are sorted by `kind`, whichever list they are in; `videos` stays empty in Music mode |
| `suggest(query, ctx)` | A partial query | Up to 20 strings |
| `track(id, ctx)`, `album(id, ctx)`, `artist(id, ctx)` | One of its own IDs | One track; an album with `tracks`; an artist with `topTracks`, `albums` and `related` |
| `playlist(id, { limit, cursor }, ctx)` | One of its own IDs, and a page | A playlist with `tracks` as a page |
| `radio(seed, ctx)` | `{ type: 'track', title, artists, album, durationMs, isrc }` or `{ type: 'artist', name }`, with `id` when the seed is its own | Tracks |
| `match(track, ctx)` | `{ title, artists, album, durationMs, isrc }` of a track from any source (its own ID only when it is its own) | Candidates: `{ id, title, artists, durationMs, confidence, kind, evidence }` |
| `resolve(candidate, ctx)` | `{ id, title, artists, durationMs }` of one of its candidates | Streams: `{ url, codec, container, bitrateKbps, sampleRateHz, bitDepth, media, expiresAt, ipBound, capped, downloadAllowed }` |

A track is `{ id, title, artists, album, durationMs, artwork, explicit, isrc, kind, songId, trackNumber, discNumber, releaseDate, popularity, tags }`, where `artists` are names or `{ id, name }`, `album` a name or `{ id, name }`, `artwork` URLs or `{ url, width, height }`, and `kind` `song` (the default), `music-video`, `video` or `episode`. Albums, artists and playlists follow `@fxm/core`'s model the same way. IDs are the plugin's own, spelled one way only; FXM makes `plugin.<id>:<kind>:<native ID>` of them. Anything malformed in a list is dropped, a malformed result as a whole fails the call (`bad-result`), texts are cut (titles to 300 characters, lists to 200 items), and artwork and stream URLs must be `https:` on a declared host.

FXM can't check a plugin's stream URL, so every stream is `unverified` (the player's first request is the probe) unless the plugin says it is `capped`; only progressive streams are taken, and none carries request headers. The playback policy and the matching engine weigh a plugin's candidates like any other; a plugin's own `confidence` is only its claim.

In the web app, streams play from any HTTPS host (the app's policy has `media-src https:`), but images load only from the hosts its `img-src` lists, so artwork on a plugin's own host doesn't show there; the desktop app's policy allows images from any HTTPS host.

`ctx` has `fetch`, `mode` (`music` or `all`), `platform`, `locale`, `region` and `signal`, which aborts when FXM gives up on the call. `fxm.fail(code, message, { retryAfterMs })` throws an error FXM reports with that `FxmError` code.

### `ctx.fetch`

`ctx.fetch(url, { method, headers, body })` resolves with a `Response` once the host has fetched it:

- only `https:` URLs on the manifest's hosts, exactly as declared;
- `GET`, `HEAD` or `POST`, with only the `Accept`, `Accept-Language`, `Content-Type` and `Range` headers, and a text body only on a `POST`, at most 256 KiB;
- bodies come back as text (UTF-8), at most 2 MiB, within 20 s; binary bodies aren't supported;
- at most 30 requests per call, and `requestsPerHour` an hour.

A refused or failed request rejects with an error whose `code` says why: `host-not-declared`, `bad-request`, `rate-limited`, `redirect`, `too-large`, `refused` (the platform refused it) or `network`. In the web app, a plugin's own hosts are user hosts of the platform, which go out only as `GET` or `HEAD` without headers, through the Lite tier's `userhost.html`, and never follow a redirect; hosts FXM itself uses keep their usual routes. That document has an opaque origin, so its requests carry `Origin: null` and no cookies, and a plugin's host must answer them with `Access-Control-Allow-Origin: *` (or `null`) for the web app to read the answer. So a plugin that works everywhere sends plain `GET`s to hosts that allow any origin, as many public APIs do.

### A plugin file

To hand someone one file, put both into a plugin file (`createPluginFile(manifest, code)` writes one):

```json
{ "fxmPluginFile": 1, "manifest": { "fxmPlugin": 1, "id": "example-radio", "…": "…" }, "code": "fxm.register({ … })" }
```

The `sha256` in its manifest is still the code's. A plugin file can also be served at an address.

### Hosting

An address serves the manifest, or the plugin file, itself, over HTTPS, without a redirect, with the code at `entry` on the same origin. The web app downloads through the same opaque-origin document as a plugin's own requests, so the files must allow any origin (`Access-Control-Allow-Origin: *`), as GitHub Pages and `raw.githubusercontent.com` do. FXM checks for an update by downloading the same address again, only when the user asks.

### Testing your plugin

The tests here use `@fxm/plugins/testing`: the tiny local test plugin (`TEST_PLUGIN_CODE`, an invented catalog on `catalog.fxm-plugin.test` under the `.test` domain that RFC 2606 keeps for tests), its manifest and plugin file, and `fakeCatalogFetch()`, which answers it offline. Install your plugin in a registry over `isolatedSandboxes(() => createInProcessEvaluator())` (from `@fxm/platform/testing`), the runtime of `eval.html` in your test's realm, and call its providers with a context whose `fetch` answers your requests.

## Where plugins run

The plugin's code runs only in documents of the isolated evaluator of stage 1.11 (`@fxm/platform`, [its README](../platform/src/evaluator/README.md)): on the web, `/sandbox/eval.html` in a `sandbox="allow-scripts"` frame, with an opaque origin and a policy that allows no network (`connect-src 'none'`), no images and no frames. The host compiles the code there once, under a key named by its checksum, and keeps it there: `evaluate` with that key sends only messages afterwards.

| `PluginSandboxes` | Where | How |
|---|---|---|
| `isolatedSandboxes(create)` | The web: `create` is `() => createSandboxEvaluator()` | A document per plugin, created on its first call, stopped when the plugin is switched off, removed or updated |
| `exclusiveSandbox(create)` | Hosts that run one document at a time, such as the desktop and Android evaluator plugins of 1.11: `create` is `() => createTauriEvaluator({ invoke })` or `() => createCapacitorEvaluator({ plugin, html })` | One document at a time: a plugin's calls hold it, and another plugin's call waits and then gets a fresh one, so plugins never share a document |

**The runtime** (`src/runtime/document.ts`) is the code FXM puts into the document next to the plugin's: it loads the plugin, runs its handlers, hands their requests to the host, and answers in the plugin protocol (`src/runtime/protocol.ts`). A call goes back and forth: `call` starts it, and the runtime answers `done`, `failed`, `fetch` (the requests the handler made in one turn) or `idle` (the handler waits for something else); the host answers `fetch` with `resume` and the responses, `idle` with an empty `resume`, and sends `cancel` when it gives up. The host trusts nothing the document sends: every reply, request and result is checked. A call may take 45 s, a plugin runs 4 calls at once, and a document 32.

The runtime is sent as text (`String(pluginRuntime)`), so it uses nothing outside its own function; `document.test.ts` runs it in a fresh realm to keep it that way.

## The network

Each request a plugin makes passes the fetch broker (`src/broker.ts`), in this order:

1. **Declared hosts only:** `https:`, no credentials, the host exactly as declared. Anything else is refused before a byte is sent.
2. **A shape FXM can carry:** the methods, headers and body sizes above.
3. **The plugin's request budget:** a `RequestBudget` of `@fxm/platform` (stage 1.2) per plugin, with `requestsPerHour` as its hourly limit and no reserves, stored under `fxm.plugins.budget.<id>`, so reloads and tabs share it. A `429` from a plugin's host pauses its requests for its `Retry-After`, from one minute to one hour.
4. **The platform's `fetch`:** the request goes out through the `ctx.fetch` of the provider call, so the platform's rules apply on top: its host table and user hosts, `credentials: 'omit'`, no `Origin` or `Cookie`, and the shared YouTube request budget (stage 1.2) for any request to a YouTube API host, which a plugin may declare.
5. **The answer:** a response that ended on an undeclared host is refused; `Set-Cookie` is never passed on.

A plugin's catalog is called only for what the user asks of it (`requestPolicy: 'explicit'`): a search with its source picked, or one of its pages. FXM never sends a plugin the user's other searches, suggestions or background work.

What a plugin can still do: learn what the user asks of it, send that to its declared hosts, and return wrong results within the checks above. What it can't: run in FXM's page, read FXM's storage, library, tokens or cookies, contact another host, read another plugin's state, or exceed its budget. A plugin that loops forever is stopped by the evaluator's timeout, after which its document is replaced; in a browser that runs the sandboxed frame in the page's own process, such a loop can still slow the page until then.

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
```

The unit tests cover the manifest's rules, checksums, plugin files and downloads (also cancelled, oversized, mismatched and from other origins), the runtime (in this realm and in a fresh one), the host's protocol loop with the real evaluator runtime in-process (requests in one turn, refused hosts, the budget, the request limit, timeouts, cancelling, code that doesn't load, error codes, concurrency), the broker's rules, every result mapper, both sandbox strategies, the registry (offers, approvals, updates and downgrades, damaged copies, switching, removing, downloads' hosts, other tabs) and the providers end to end with the tiny local test plugin. `browser.test.ts` runs the committed `eval.html` in headless, muted Chromium, served with stage 2.8's header policy and driven by `createSandboxEvaluator`: it installs the test plugin and searches it through the real evaluator, and a probe plugin finds its document opaque, with `fetch`, `localStorage`, the parent's DOM and images blocked, reaching only what the host fetches for it, in a document of its own.

## Pending

- **Desktop and Android.** The evaluator plugins of 1.11 there open one document at a time (a new `open` destroys the last), and their native networking reaches user hosts only after the user approves each in a native dialog (`createDesktopUserHosts().approve`, `createAndroidHttp().approveHosts`). `exclusiveSandbox` already keeps plugins in documents of their own on such hosts; what remains is the apps' wiring: an evaluator owner shared with 1.11's rungs, and asking the native host lists about a plugin's hosts when it is added. Until then the web app's Plugins section says that plugins come to those apps later.
- **Matching and radio.** The web app adds every plugin's `audio` to its stream lifecycle (`StreamLifecycle.addSource`), so a plugin's own songs play through its `resolve`. Its `match` (audio for tracks of other sources) and its `radio` are ready but unused: the app's matching engine and radio take their sources from the composition root, which doesn't follow plugins yet.
- **Artwork on the web.** The web app's `img-src` lists FXM's own image hosts only, so a plugin's artwork doesn't show there; allowing it would mean `img-src https:` in stage 2.8's policy, which lets the page load images from any host.
