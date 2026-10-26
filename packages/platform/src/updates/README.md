# Signed updates (`src/updates/`)

YouTube changes often, and some fixes need new code, not just new settings. The web app gets both by redeploy. The desktop and Android apps would need an app update, so they download two signed files from FXM's static site instead (stage 1.13):

| Artifact | File on the site | Its version | Made by |
|---|---|---|---|
| The YouTube config: client versions, search parameters, the stream ladder | `youtube-config-1.json` (`1` is the config's schema) | its `revision` | `scripts/sign-config.sh` |
| The YouTube resolver module: the client ladder, request shapes and parsers, youtubei.js included ([its README](../../../sources/src/youtube/module/README.md)) | `youtube-module-1.js` (`1` is the app-module contract) | `YOUTUBE_MODULE_VERSION` | `scripts/sign-module.sh` |

Each file has a signature file next to it (`<file>.sig`). FXM has no servers: the site is static files on Cloudflare Pages, and everything below runs on the user's device.

The number in each file name is a contract: every app that fetches a name must be able to read whatever is published under it. A config that needs a newer module, or a module that older apps can't take, is published under a new name (a new schema or contract), and older apps keep the last file of their own name.

## How a device updates

```ts
import {
  codeArtifact, createUpdater, indexedDbUpdateStore, jsonArtifact, updateFetchFromNative,
} from '@fxm/platform'
import { createYouTubeModuleHost } from '@fxm/sources/youtube/module'

const youtube = createYouTubeModuleHost({ visitorDataStore, healthStore })
const updater = createUpdater({
  artifacts: [codeArtifact(youtube.updates.module), jsonArtifact(youtube.updates.config)],
  fetch: updateFetchFromNative(nativeHttp), // stage 7.2 (desktop) or 6.2 (Android)
  store: indexedDbUpdateStore(), // required
  state: localStorage, // required: the floors live here
  distribution, // parseDistribution(FXM_DISTRIBUTION): 'fdroid' in F-Droid builds
})
const report = await updater.start() // restore, then check; never throws for network problems
youtube.music.search(…) // live providers: they follow the module in use
```

1. **Restore** (no request): each artifact's last good version comes back from IndexedDB, verified again (signature, size, SHA-256). A copy that fails, is not newer than what is in use, is revoked or failed to load before is dropped, and the app uses the copy it ships with.
2. **Check:** for each URL of the list (`DEFAULT_UPDATE_BASE_URLS`, the site's `/updates/` folder), fetch the small `.sig` file and verify it. Only when it names a version higher than the one in use is the artifact downloaded, checked against the signed size and SHA-256, loaded, kept as the last good version and switched to. Code goes first, so the newest module is in place when a new config arrives.

The updater runs one call at a time, in order, so a restore never undoes a check under way; concurrent checks share one run, and a caller that cancels (`signal`) stops only its own wait. The version it compares with is the one really in use: the host reports it (`inUse`), for example a config that a downloaded module brought along, newer than the one on the site.

What can't happen:

| Attempt | What the updater does |
|---|---|
| A file signed by a key the build doesn't trust, a forged or damaged signature | Refuses it (`unknown-key`, `bad-signature`, `malformed`) and tries the next URL |
| A key that isn't a valid Ed25519 public key (a small-order point would verify forgeries) | `createUpdater` throws, and the verifier verifies nothing with it, whichever way it got there |
| A signed config served under the module's name, a signature for another contract or schema | Refuses it (`wrong-artifact`) |
| Different or extra bytes under a valid signature | Refuses them (`hash-mismatch`, `too-large`); reading stops at the signed size |
| An older version than the one in use | Keeps the one in use and downloads nothing |
| A **rollback**: a validly signed version below the highest this device ever accepted from a key the build trusts | Refuses it (`rollback`). The highest versions (the floors) are kept apart from the stored copy, so losing that copy doesn't reopen the door |
| A version the build lists as revoked (`update-keys.json`) | Refuses it from the site and drops it from the store (`revoked`) |
| A version that verified but failed to load | Remembers it (`known-bad`) and doesn't download it again until the next app update; the next higher version is tried |
| A version this app can't use now, such as a config the module in use can't read | Keeps what it has (`unusable`) without remembering the version or raising a floor, and tries again later |
| A platform that can't load code at all (no `blob:` in `script-src`) | Downloads no code and remembers nothing as bad (`code-unsupported`) |
| A module or config that starts badly once in use | The host goes back to its own copy and tells the updater, which remembers the version as bad and drops the stored copy |
| An unreachable host, an HTTP error, a timeout | Tries the next URL; when none answers, keeps what it has (`failed`) |
| A build without a real key (the placeholder) | Fetches and accepts nothing (`no-key`): it **fails closed** |
| An F-Droid build without the user's opt-in | Leaves code alone (`needs-opt-in`), and loads no stored module either |

Every problem is in the report, for logs and Diagnostics; none stops the app. `updater.status()` gives each artifact's version in use, its origin (`bundled`, `stored`, `fetched`), floor, bad versions and last check.

The web app doesn't create an updater: whoever controls the site controls the web app anyway, and it gets the same code by redeploy.

### What signatures don't stop

Signatures decide which files a device accepts, not which files it is offered. Someone who controls the site (a hijack, a leaked Cloudflare token, or the `pages.dev` name taken over after the project is deleted) can:

- **Freeze** devices: serve nothing, or keep serving an old file. Devices stay on what they have.
- **Replay a superseded version**: serve any earlier signed version that is still above a device's floor, including one the owner replaced because it was bad. Every signed version stays public in the history of `apps/site/public/updates/`. A device that already took the higher version refuses it as a rollback; one that didn't yet may take it.

A leaked private key is worse: until an app update removes the key, its holder can sign anything devices accept (see [Keys](#keys)).

Signed versions don't expire. An expiry date in each statement would end replays, but apps would then need the owner to sign again before every expiry, and the deploy job can't sign by design, so it isn't done. The defence against a replay is the revocation list below.

## The signature format

The key never signs the artifact itself. It signs a short JSON **statement** about it, so one signature binds what the artifact is, its version and its exact bytes, and the version is known before a large file is downloaded:

```json
{"kind":"youtube-module","version":3,"api":1,"file":"youtube-module-1.js","size":744722,"sha256":"…","source":"<the git commit it was built from>","signedAt":"2026-10-26T10:00:00.000Z"}
```

The **signature file** carries the statement's exact bytes and an Ed25519 signature (RFC 8032, pure Ed25519) of `"FXM signed update, format 1\n"` followed by those bytes. The prefix keeps a signature made for FXM updates from being valid for anything else the key might sign.

```json
{
  "format": "fxm-signed-update-1",
  "keyId": "ed25519-5a18047d04f4c2a7",
  "statement": "<Base64 of the statement's bytes>",
  "signature": "<Base64 of the 64-byte signature>"
}
```

Readers verify the bytes as they are and never re-encode the statement. `format.ts` has the rules: kinds and file names are short ASCII names without a path, versions are whole numbers from 1 to 2^31 − 1 that go on rising across contracts and keys, sizes are at most 64 MiB, `source` is a commit ID that apps don't read, and unknown statement fields are ignored, so a later format can add some.

**Why not minisign.** Minisign is Ed25519 too, but its default mode signs a BLAKE2b-512 hash of the file, which WebCrypto doesn't have, and it adds a second signature over a free-text "trusted comment" where the version would live. A JSON statement signed once uses only what WebCrypto has (Ed25519, with SHA-256 for the file), and the version is a field, not text to parse.

## Keys

- **Compiled in.** `update-keys.json` lists what a build trusts: the public keys (`{ keyId, publicKey }`, the key in Base64) and the revoked versions. Changing either takes an app update. Entries are checked when the build loads them: 32 bytes that decode to a point of the prime-order group in RFC 8032's strict encoding (small-order keys, which would accept forgeries, are refused), listed under their own ID.
- **Two keys from the start.** `scripts/make-signing-key.sh` creates a signing key and a backup key, and both are listed. The owner signs with the first and keeps the second offline, so a leaked or lost signing key never leaves apps without a key they trust.
- **The placeholder.** Until the owner creates the keys, the file holds a placeholder that is not a key. `UPDATE_SIGNING_READY` is then `false` and every build fails closed. A release job (7.5, 6.6) can check it to refuse to ship such a build.
- **Key IDs** are `ed25519-` and the first 16 hexadecimal digits of the public key's SHA-256 (`keyIdOf`).
- **Floors are kept per key.** A device remembers the highest version it accepted from each key; the floor that counts is the highest among the keys the build still trusts. When an app update removes a key, the floors it set no longer count, so versions signed with a leaked key, even 2^31 − 1, can't block later updates.
- **The private key never reaches the deploy job.** The owner signs locally. Alternatively, CI may sign in a GitHub environment whose secret only the owner's approval of each run releases (below). Either way, the deploy job only copies files that are already signed.
- **Rotation:** add the new key to `update-keys.json` and ship an app update; sign with the new key once the supported app versions trust it; remove the old key in a later app update. Versions go on rising: never start again from 1.
- **A leaked signing key:** sign the next releases with the backup key at once: apps already trust it. Ship an app update that removes the leaked key and adds a new backup key. Until users update, the leaked key still works on their devices: they accept what it signs, and refuse as a rollback any backup-signed version lower than one they took from the leaked key; the app update ends both. If both keys leak, only an app update with new keys helps.
- **A lost signing key:** the same, without the urgency: sign with the backup key, and replace the lost key in the next app update.

### Revoked versions

A release that is dangerous, not just broken, must be revoked: someone who controls the site could otherwise still serve it to devices below it. Add its version to `revoked` in `update-keys.json`, for example `"revoked": { "youtube-module": [4] }`, and ship an app update. Builds with the entry refuse that version from the site and drop it from their store, whoever signed it.

### Owner actions

1. Create the key pairs, in a folder outside the repository:

   ```sh
   scripts/make-signing-key.sh ~/fxm-keys
   ```

   It writes `fxm-update-signing-key.pem` and `fxm-update-backup-key.pem` (the private keys, readable only by you) and their public keys, and prints the two entries to put into `update-keys.json` in place of the placeholder. Commit that file. Move the backup key to offline storage and delete it from the machine.
2. Sign and publish, whenever the config or the YouTube code changes:

   ```sh
   # raise "revision" in packages/sources/src/youtube/youtube-config.json, and commit
   scripts/sign-config.sh --key ~/fxm-keys/fxm-update-signing-key.pem
   # raise YOUTUBE_MODULE_VERSION in packages/sources/src/youtube/module/version.ts, and commit
   scripts/sign-module.sh --key ~/fxm-keys/fxm-update-signing-key.pem
   ```

   They write the file and its `.sig` into `apps/site/public/updates/`, which the site serves at `/updates/`, after checking the signature the way the apps will. They refuse to sign uncommitted sources (the statement records the commit), a version that is not higher than every version of that kind already there, a key that `update-keys.json` doesn't list, and a config that the module built from the same commit can't read. Commit both files and deploy.
3. **To undo a bad release,** sign the previous good content again with a higher version: devices that took the bad version move on, and the others skip it. If the bad release is dangerous, also revoke it (above): until devices have the app update with the revocation, someone who controls the site can still serve it to those below it.
4. **To check a published module** against its sources, run `node --experimental-strip-types scripts/sign-update.mjs verify module` (through `scripts/run.sh`) at the commit its statement names, or any later one that didn't change the module's sources: the build is reproducible, so it must give the same SHA-256. A CI job could run it on every change to `apps/site/public/updates/`.

**Signing in CI instead** (optional, not set up): create a GitHub environment, for example `update-signing`, with the owner as its required reviewer, and store the PEM as its secret `FXM_UPDATE_SIGNING_KEY`. Use two jobs on the same commit. The first, without the environment, installs the dependencies, builds and checks the file (`scripts/sign-update.mjs build module --out youtube-module-1.js`) and uploads it. The second uses the environment, installs nothing but `@noble/hashes` and `@noble/curves` (all the signing code imports), and runs `scripts/sign-module.sh --from youtube-module-1.js --key-env FXM_UPDATE_SIGNING_KEY`, which takes the key out of its environment before anything else runs. The same goes for the config. The deploy job never uses that environment.

## Loading code

`codeArtifact` turns the verified bytes into a module with `importModuleFromBytes`: a `blob:` URL made from exactly those bytes (nothing is fetched again between the check and the import), imported, then revoked. Before any code is restored or downloaded, `canImportModules` imports a one-line module, once, to find out whether the platform can load code at all.

- **Content Security Policy.** The page's `script-src` must allow `blob:`. The desktop app's does (`apps/desktop/src-tauri/tauri.conf.json`). The Android app has no policy yet; one added later must include `blob:` in `script-src`. The web app's never does.
- **The host allow-lists still apply to the module's requests.** The module reaches the network only through the `ctx.fetch` of each call, the platform transport that refuses every host not in `src/hosts.ts`; `bundle.test.ts` in the module's folder makes every other way out (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`) throw while the bundle searches and resolves.
- **But the module runs in the page, with the app's rights.** Nothing in the page stops code from calling those APIs itself: the desktop policy still has `https:` in `connect-src` until stage 7.2 drops it, and `img-src` and `media-src` allow GET requests to any HTTPS host. The native layers limit what any code in the webview could reach: on desktop the HTTP plugin's scope (`capabilities/default.json`), on Android the OkHttp plugin's host list (6.2). The signature is what keeps foreign code out; running the module in a dedicated Worker, with no DOM, storage or IPC and `ctx.fetch` over `postMessage`, would contain it further.
- **Updating the module's host list** therefore always takes an app update: a module that needed a new host could not reach it.

## Verifying on each platform

Signatures are checked with WebCrypto's Ed25519 where the platform has it and it passes a known-answer test (RFC 8032, test 2, and a forged copy that must fail), and otherwise with [`@noble/curves`](https://github.com/paulmillr/noble-curves) 2.4 (MIT; audited at 2.3.0 by Trail of Bits in August 2026, and for Ed25519 at 1.6.0 by Cure53 in September 2024), in RFC 8032's strict mode (no ZIP-215 leniency). SHA-256 always comes from `@noble/hashes`, so it needs no secure context.

| Platform | Ed25519 in WebCrypto | Engine |
|---|---|---|
| Android System WebView, WebView2 (Windows), Chrome, Edge | 137 and later | WebCrypto, else the library |
| WKWebView (macOS), Safari | 17 and later (macOS 12 and later, once Safari 17 is installed) | WebCrypto; macOS 11 uses the library |
| WebKitGTK (Linux) | Depends on the build | Whichever passes the test |
| Firefox | 129 and later | WebCrypto, else the library |
| Node (tests, scripts) | 22 | WebCrypto |

Versions from MDN's browser-compat-data, read 2026-10-26. The known answer is test 2, not test 1, because WebKit's Ed25519 refuses test 1's valid signature of an empty message while it verifies non-empty ones (measured 2026-10-26 in Playwright's WebKit 27.2 and in the desktop app's WKWebView on macOS 15). FXM never signs an empty message. The library needs only `BigInt` (Chrome 67, Safari 14, Firefox 68), and importing a `blob:` module needs dynamic `import()` (Chrome 63, Safari 11.1, Firefox 67), so every webview the apps support can verify and load updates.

## F-Droid builds

F-Droid's [inclusion policy](https://f-droid.org/docs/Inclusion_Policy/) (Security & Legal Compliance, item 5; the text as of 2026-10-26, last changed 2026-10-16) says: "Applications must not download additional executable binary files (e.g. add-ons, auto-updates, etc.) without explicit user consent. Consent means it needs to be opt-in (it must not be harder to decline than to accept or presented in a way users are likely to press accept without reading) and structured in a way that clearly explains to users that they're choosing to bypass F-Droid's checks if they activate it."

So a build with `distribution: 'fdroid'` (`parseDistribution(FXM_DISTRIBUTION)`, set by the F-Droid build of stage R.3, which takes `fdroid` or `f-droid`, and `standard` or nothing for the standard build, and fails the build on anything else, so a typo can't make a standard build):

- downloads and loads the module only while `allowCode()` says the user opted in, and goes back to the bundled module when they opt out. It asks again right before a module loads and before it goes into use, so a module that was downloading, or being read from the store, when the user opted out never runs or stays in use, and isn't stored (`needs-opt-in`). The config is data, so it is still fetched;
- turns FXM's own app-update check off: `updatePolicy('fdroid').appUpdateCheck` is `false` for 6.6 to honour;
- asks with `CODE_UPDATES_CONSENT`: a title, three short paragraphs that say the code comes from FXM, not F-Droid, and that turning it on bypasses F-Droid's checks, and two equal buttons, "Turn on" and "Not now". Show them in the same style, with neither preselected. The setting's label repeats that it bypasses F-Droid's checks.

## Hosting

The signed files live in `apps/site/public/updates/` once the owner publishes them, and the site serves them at `https://fxmusic.pages.dev/updates/`. A stage that renames the site changes `DEFAULT_UPDATE_BASE_URLS`. The apps fetch them through their native HTTP, so the site needs no CORS headers for them, but the desktop HTTP plugin's scope and the Android plugin's host list must include that folder. Update URLs are HTTPS folders without credentials or a query (`http://localhost` and `http://127.0.0.1` are allowed for development). Requests are plain GETs with `credentials: 'omit'` that follow no redirect, with a 15 s limit for signature files and 60 s for artifacts. Over native HTTP (`updateFetchFromNative`) they go on the `open` route with no headers and no `Origin`, and a redirect, which native HTTP hands back unfollowed, fails the request like an unreachable host.

## Entry points

`@fxm/platform` exports what the apps use: `createUpdater`, `codeArtifact` and `jsonArtifact`, the stores, `updateFetchFromNative`, the F-Droid policy, `UPDATE_SIGNING_KEYS` and `UPDATE_SIGNING_READY`, `createSignatureVerifier` (its `engine()` is for Diagnostics) and the types. Signing (`sign.ts`) and the format's encoders are only for the owner's scripts and the tests, which import those files directly. `@fxm/platform/testing` has the test helpers for the apps that wire the updater (7.2, 6.2): `createTestSigner`, `fakeUpdateSite` and `nodeModuleImporter`.

## Tests

- `format.test.ts`, `verify.test.ts`, `keys.test.ts`: the format, signing, both verification engines (a forged, flipped or relabelled signature, an unknown key, a small-order key, a changed statement, the wrong artifact, a lying or missing WebCrypto), key and revocation lists, including small-order keys and the placeholder.
- `updater.test.ts`: restore and check against a fake site: bad signatures, rollback attempts (also after the stored copy is lost), floors per key across a key rotation, revoked versions, unreachable hosts and timeouts, HTTP errors, damaged or oversized files, versions that fail to load or that the app can't use, a platform that can't load code, a failing store or state, F-Droid opt-in and opt-out (also while a module downloads, is read from the store or loads), one call at a time and cancelling callers, and the fallbacks to the next URL, the last good version and the bundled copy.
- `youtube.test.ts`: the real module bundle, built as `scripts/sign-module.sh` builds it, fixing a deliberately broken bundled parser after a signed update, also through a method the app took before the update, and still fixed after a restart without a request; a changed or foreign-signed module, a build with only the placeholder key and an F-Droid build without the opt-in all leave the bundled copy in place; a config the module can't read, and one older than the module's own, change nothing.
- `e2e/`: the same flow in real browser engines under the desktop app's Content Security Policy, loading the module from a `blob:` URL, and in the desktop app itself (`e2e/desktop.mjs`, run on macOS on 2026-10-26). Neither is part of `make test`; see `e2e/README.md`.
- `live.test.ts` (`make live-smoke`): what the site publishes verifies against the compiled keys and matches its signatures, and the config reads as a config. It never runs the downloaded module. Skipped while the key is the placeholder.

```sh
scripts/run.sh pnpm vitest run packages/platform/src/updates
```
