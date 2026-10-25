# The YouTube resolver module (`youtube/module/`)

The YouTube glue (the client ladder, the request shapes and the parsers, with youtubei.js inside) as one versioned ES module (stage 1.13). Every app ships a copy. The desktop and Android apps also download newer signed copies from FXM's static site, so a YouTube change that breaks a parser is fixed without an app update. The web app gets the same code by redeploy.

```ts
import { createYouTubeModuleHost } from '@fxm/sources/youtube/module'

const youtube = createYouTubeModuleHost({ visitorDataStore, healthStore })
const { tracks } = await youtube.music.search('Radiohead Creep', { types: ['track'] }, ctx)
const options = await youtube.audio.resolve(candidate, ctx, prefs)
```

On desktop and Android, `@fxm/platform`'s updater keeps the module and the config current: `codeArtifact(youtube.updates.module)` and `jsonArtifact(youtube.updates.config)`. Signing, verification, rollback protection and the F-Droid opt-in are in [its README](../../../../platform/src/updates/README.md).

## The contract

A module exports `youtubeModule`, a `YouTubeModule` (`api.ts`):

| Member | What it is |
|---|---|
| `api` | The app-module contract, `YOUTUBE_MODULE_API` (1). An app loads only modules of its own contract, from `youtube-module-<api>.js` |
| `version` | `YOUTUBE_MODULE_VERSION`. Apps take a module only when its version is higher than the one they have |
| `config` | The `youtube-config.json` it was built with |
| `checkConfig(document)` | Checks a config document (its metadata part and its `streams` ladder) and returns its `revision`, or throws a `Parse` `FxmError` |
| `create(options)` | The providers on one shared session, from a config and the app's stores, with no request: `music` (`ytm`), `video` (`yt`) and `audio` (the stream ladder) |

Only the types of `api.ts` cross: those members, the providers as `YouTubeModuleMusic`, `YouTubeModuleVideo` and `YouTubeModuleAudio` (the provider interfaces of `@fxm/core` plus the YouTube extras), the options, and `@fxm/core`'s entities. youtubei.js's objects never do: a provider's `session` stays inside the module, because it changes with every youtubei.js release.

`contract-1.ts` freezes that shape, written out in full. `contract.test.ts` makes the type checker fail when `api.ts` stops being compatible with it in either direction: an old app must be able to use a new module, and a new app an old module. A change that breaks it needs a new `YOUTUBE_MODULE_API`, a new file name and a `contract-2.ts`; older apps then keep their last module of the old contract until they update. No module is published yet, so contract 1 still follows `api.ts`, which has taken in stage 1.4's stream API (`hasFallback`, `reportPlaybackSuccess`, the playback failure reasons, `checkStatus`, and `rungs` and `probe` instead of `skipRungs`) and the providers' `topResult` and `getDescription`; after the first module is signed, `contract-1.ts` never changes.

Some things outlive the module that made them, so every later module of the same contract must still read what earlier ones wrote:

- **Cursors.** A page's `nextCursor` (search, playlists, radio) is kept, and put in URLs: a cursor works after a reload, and after a module update.
- **Rung IDs.** The config names rungs by ID, the health store keys its counters by rung ID, and the app keeps options that name their rung.
- **Store formats.** The visitorData store holds a visitorData string; the health store holds the ladder's health JSON. A new module reads both as an old one wrote them.
- **Stream options.** `YouTubeStreamOption`'s fields (`videoId`, `rung`, `itag`, `label`, `contentLength`, `peakBitrateKbps`) and `StreamOption`'s, which the app keeps in its queue and downloads and hands back to `reportPlaybackSuccess`, `reportPlaybackFailure` and `checkStatus`.
- **IDs and errors.** Entity IDs in `@fxm/core`'s format, and errors named `FxmError` with their codes, and `YouTubeUnplayableError` with its state, which the app reads with `isFxmError` and `unavailableStateOf`.

Versions continue across contracts: the first module of contract 2 has a higher version than the last of contract 1 (devices keep one floor per kind).

Errors cross as they are: a module carries its own copy of `@fxm/core`, so its `FxmError`s are not `instanceof` the app's. Use `isFxmError` and `unavailableStateOf`, which recognize them by name and code.

## The config

The config is published as `youtube-config-<schema>.json` (`YOUTUBE_CONFIG_FILE`, schema `YOUTUBE_CONFIG_SCHEMA` 1), and its statements carry that schema. A config published under one name must stay readable by every module that fetches that name, including the module of the oldest app still in use: a config that needs a newer module needs a new schema, and so a new file name. `scripts/sign-config.sh` refuses a config that the module built from the same commit can't read. Revisions continue across schemas.

A config from the network must come through the host's `updates.config` and `@fxm/platform`'s updater, which checks its signature; `pickYouTubeConfig` and `pickYouTubeConfigs` are only for documents that are already trusted.

## The host

`createYouTubeModuleHost(options)` holds what the app uses:

- **The module in use:** the bundled one, or a verified downloaded one (`updates.module`). A downloaded module must pass `isYouTubeModule`, have the signed version, read its own config as its own revision and start before it is taken; whatever it throws on the way counts against it. A switch is all or nothing. If a downloaded module later fails to start, the host goes back to the bundled module and tells the updater (`watch`), which never restores that version again.
- **The config in use:** the newest of a verified downloaded config (`updates.config`), the module's own and the app's, that the module in use can read. A downloaded config must have the signed revision, be readable by the module in use and start it. One the module can't read is refused as `Unsupported`: the updater keeps what it has without remembering the revision, so a later module may take it. A config that fails to start the module once in use is dropped the same way as a module.
- **What is in use, for the updater:** `inUse()` of each artifact. For the config, that is the revision really in use, so a config older than the one a new module brought is not downloaded.
- **Live providers:** `music`, `video` and `audio` read the module and config in use on every call, and their methods are wrappers that do the same, so a method taken from them (`const { resolve } = youtube.audio`) follows updates too. Read values, such as a flag, through the live object each time. `providers()` returns the current instances, and `subscribe(listener)` tells when they change.
- **Stores:** every switch creates new provider instances. The stores passed to the host (`visitorDataStore`, `healthStore`) are shared by all of them, so desktop and Android must pass both: without them, each switch starts a new YouTube session (a new `sw.js_data` request) and forgets the ladder's health.

## Building and publishing

`build.mjs` bundles `entry.ts` with Vite (Rolldown) into one minified file, about 745 KB (190 KB compressed), with no imports, chunks or assets, so it runs from a `blob:` URL. It opens with the licence notices of everything bundled into it (youtubei.js, `@bufbuild/protobuf`, fflate and meriyah, then FXM's Apache License 2.0), generated from the packages the bundle holds, so the signed file carries them wherever it goes. The same sources and lockfile give the same bytes, so a published module can be rebuilt and compared (`scripts/sign-update.mjs verify module`). The owner builds and signs it in one step:

```sh
# raise YOUTUBE_MODULE_VERSION in version.ts, and commit
scripts/sign-module.sh --key ~/fxm-keys/fxm-update-signing-key.pem
```

That builds the module in a process that never sees the key, then writes `youtube-module-1.js` and its signature to `apps/site/public/updates/`, served at `/updates/`, recording the commit it was built from. Raise the version by one for every module published; the script refuses uncommitted sources and a version that is not higher than every module already there. To undo a bad module, publish the previous code again with a higher version, and revoke the bad one if it is dangerous (see the platform README).

`@fxm/sources/youtube/module/build` and `@fxm/sources/youtube/module/testing` export the build and the test helpers (a fake YouTube with recorded answers, a desktop context, `importModuleCode`) for other packages' tests.

## Tests

- `entry.test.ts`, `host.test.ts`: the contract, config checks (no host outside InnerTube's), the providers and the stores, module and config updates (all or nothing, refusals as `Parse` or `Unsupported`), what is in use, live providers and their methods, the fallbacks to the bundled module and config, and the failures they report.
- `contract.test.ts`: `api.ts` against the frozen `contract-1.ts`, both ways, and the config's file name against its schema.
- `bundle.test.ts`: the real bundle, imported from its bytes alone, searches and resolves a song from the recorded answers, also while `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` throw, so it uses nothing but `ctx.fetch`; it opens with the licence notices and builds to the same bytes twice. Built with `brokenFormatParser()`, a test-only plugin that breaks the parser of a `/player` answer's formats on purpose, it finds no audio: the stand-in for a YouTube change in the update tests of `@fxm/platform` (`src/updates/youtube.test.ts` and the browser e2e test).
- `live.test.ts` (`FXM_LIVE=1`, `make live-smoke`): the bundle built from this checkout searches and resolves a song from live YouTube, three requests.

```sh
scripts/run.sh pnpm vitest run packages/sources/src/youtube/module
```
