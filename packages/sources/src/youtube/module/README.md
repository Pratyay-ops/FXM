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

A module exports `youtubeModule`, a `YouTubeModule`:

| Member | What it is |
|---|---|
| `api` | The app-module contract, `YOUTUBE_MODULE_API` (1). An app loads only modules of its own contract, from `youtube-module-<api>.js` |
| `version` | `YOUTUBE_MODULE_VERSION`. Apps take a module only when its version is higher than the one they have |
| `config` | The `youtube-config.json` it was built with |
| `checkConfig(document)` | Checks a config document (its metadata part and its `streams` ladder) and returns its `revision`, or throws a `Parse` `FxmError` |
| `create(options)` | The providers on one shared session: `music` (`ytm`), `video` (`yt`) and `audio` (the stream ladder), from a config and the app's stores. Makes no request |

The contract covers the shape of everything that crosses between app and module: these members, the provider interfaces of `@fxm/core` and its entities. A change older apps can't take (a removed or retyped field, a new required option) needs a new `YOUTUBE_MODULE_API`, and therefore a new file name, so older apps keep their last module of the old contract until they update.

Errors cross as they are: a module carries its own copy of `@fxm/core`, so its `FxmError`s are not `instanceof` the app's. Use `isFxmError` and `unavailableStateOf`, which recognize them by name and code.

## The host

`createYouTubeModuleHost(options)` holds what the app uses:

- **The module in use:** the bundled one, or a verified downloaded one (`updates.module`). A downloaded module must pass `isYouTubeModule`, have the signed version, and read its own config and start before it is taken. If one later fails to start, the host goes back to the bundled module.
- **The config in use:** the newest of a verified downloaded config (`updates.config`), the module's own and the app's, that the module in use can read. A downloaded config must have the signed revision. One that the module in use can't read is kept but not used: a config published for a newer module waits for that module.
- **Live providers:** `music`, `video` and `audio` read the module and config in use on every call, so the app keeps one set of objects and an update takes effect on the next call. `providers()` returns the current instances, and `subscribe(listener)` tells when they change. The stores passed to the host (`visitorDataStore`, `healthStore`) are shared by every instance, so a new module keeps the device's YouTube session and the ladder's health.

## Building and publishing

`build.mjs` bundles `entry.ts` with Vite (Rolldown) into one minified file, about 730 KB (185 KB compressed), with no imports, chunks or assets, so it runs from a `blob:` URL. The owner builds and signs it in one step:

```sh
# raise YOUTUBE_MODULE_VERSION in version.ts first
scripts/sign-module.sh --key ~/fxm-keys/fxm-update-signing-key.pem
```

That writes `youtube-module-1.js` and its signature to `apps/site/public/updates/`, served at `/updates/`. Raise the version by one for every module published; the script refuses a version that is not higher than the one already there. To undo a bad module, publish the previous code again with a higher version.

## Tests

- `entry.test.ts`, `host.test.ts`: the contract, config checks (no host outside InnerTube's), the providers and the stores, module and config updates, live providers, the fallback to the bundled module.
- `bundle.test.ts`: the real bundle, imported from its bytes alone, searches and resolves a song from the recorded answers. Built with `brokenFormatParser()`, a test-only plugin that breaks the parser of a `/player` answer's formats on purpose, it finds no audio: the stand-in for a YouTube change in the update tests of `@fxm/platform` (`src/updates/youtube.test.ts` and the browser e2e test).
- `live.test.ts` (`FXM_LIVE=1`, `make live-smoke`): the bundle searches and resolves a song from live YouTube, three requests.

```sh
scripts/run.sh pnpm vitest run packages/sources/src/youtube/module
```
