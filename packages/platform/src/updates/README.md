# Signed updates (`src/updates/`)

YouTube changes often, and some fixes need new code, not just new settings. The web app gets both by redeploy. The desktop and Android apps would need an app update, so they download two signed files from FXM's static site instead (stage 1.13):

| Artifact | File on the site | Its version | Made by |
|---|---|---|---|
| The YouTube config: client versions, search parameters, the stream ladder | `youtube-config.json` | its `revision` | `scripts/sign-config.sh` |
| The YouTube resolver module: the client ladder, request shapes and parsers, youtubei.js included ([its README](../../../sources/src/youtube/module/README.md)) | `youtube-module-1.js` (`1` is the app-module contract) | `YOUTUBE_MODULE_VERSION` | `scripts/sign-module.sh` |

Each file has a signature file next to it (`<file>.sig`). FXM has no servers: the site is static files on Cloudflare Pages, and everything below runs on the user's device.

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
  store: indexedDbUpdateStore(),
  state: localStorage,
  distribution, // 'fdroid' in F-Droid builds
})
const report = await updater.start() // restore, then check; never throws for network problems
youtube.music.search(…) // live providers: they follow the module in use
```

1. **Restore** (no request): each artifact's last good version comes back from IndexedDB, verified again (signature, size, SHA-256). A copy that fails, is older than what the app ships, or failed to load before is dropped, and the app uses the copy it ships with.
2. **Check:** for each URL of the list (`DEFAULT_UPDATE_BASE_URLS`, the site's `/updates/` folder), fetch the small `.sig` file and verify it. Only when it names a higher version is the artifact downloaded, checked against the signed size and SHA-256, loaded, kept as the last good version and switched to. Code goes first, so the newest module is in place when a new config arrives.

What can't happen:

| Attempt | What the updater does |
|---|---|
| A file signed by a key the build doesn't trust, a forged or damaged signature | Refuses it (`unknown-key`, `bad-signature`, `malformed`) and tries the next URL |
| A signed config served under the module's name, a signature for another contract | Refuses it (`wrong-artifact`) |
| Different or extra bytes under a valid signature | Refuses them (`hash-mismatch`, `too-large`); reading stops at the signed size |
| An older version than the one in use | Keeps the one in use and downloads nothing |
| A **rollback**: a validly signed version below the highest this device ever accepted | Refuses it (`rollback`). The highest version (the floor) is kept apart from the stored copy, so losing that copy doesn't reopen the door |
| A version that verified but failed to load | Remembers it (`known-bad`) and never downloads it again; the next higher version is tried |
| An unreachable host, an HTTP error, a timeout | Tries the next URL; when none answers, keeps what it has (`failed`) |
| A build without a real key (the placeholder) | Fetches and accepts nothing (`no-key`): it **fails closed** |
| An F-Droid build without the user's opt-in | Leaves code alone (`needs-opt-in`), and loads no stored module either |

Every problem is in the report, for logs and Diagnostics; none stops the app. `updater.status()` gives each artifact's version, origin (`bundled`, `stored`, `fetched`), floor and last check.

The web app doesn't create an updater: whoever controls the site controls the web app anyway, and it gets the same code by redeploy.

## The signature format

The key never signs the artifact itself. It signs a short JSON **statement** about it, so one signature binds what the artifact is, its version and its exact bytes, and the version is known before a large file is downloaded:

```json
{"kind":"youtube-module","version":3,"api":1,"file":"youtube-module-1.js","size":726809,"sha256":"cd29…79ee","signedAt":"2026-10-26T10:00:00.000Z"}
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

Readers verify the bytes as they are and never re-encode the statement. `format.ts` has the rules: kinds and file names are short ASCII names without a path, versions are whole numbers from 1, sizes are at most 64 MiB, and unknown statement fields are ignored, so a later format can add some.

**Why not minisign.** Minisign is Ed25519 too, but its default mode signs a BLAKE2b-512 hash of the file, which WebCrypto doesn't have, and it adds a second signature over a free-text "trusted comment" where the version would live. A JSON statement signed once uses only what WebCrypto has (Ed25519, with SHA-256 for the file), and the version is a field, not text to parse.

## Keys

- **Compiled in.** `update-keys.json` lists the public keys a build trusts (`{ id, publicKey }`, the key in Base64). Changing them takes an app update, so a hijacked site or a leaked Cloudflare token can't push anything installed apps accept. Entries are checked when the build loads them: 32 bytes that decode to a point of the prime-order group in RFC 8032's strict encoding (small-order keys, which would accept forgeries, are refused), listed under their own ID.
- **The placeholder.** Until the owner creates the key pair, the file holds a placeholder that is not a key. `UPDATE_SIGNING_READY` is then `false` and every build fails closed. A release job (7.5, 6.6) can check it to refuse to ship such a build.
- **Key IDs** are `ed25519-` and the first 16 hexadecimal digits of the public key's SHA-256 (`keyIdOf`).
- **The private key never reaches the deploy job.** The owner signs locally. Alternatively, CI may sign in a GitHub environment whose secret only the owner's approval of each run releases (below). Either way, the deploy job only copies files that are already signed.
- **Rotation:** add the new key to `update-keys.json` and ship an app update; sign with the new key; remove the old key once no supported app version needs it.
- **A leaked private key:** remove it from `update-keys.json` and ship an app update at once. Until users update, publish the newest good versions signed with a new key under higher version numbers, so a rollback to anything the attacker signs at a lower version is refused.

### Owner actions

1. Create the key pair, in a folder outside the repository:

   ```sh
   scripts/make-signing-key.sh ~/fxm-keys
   ```

   It writes `fxm-update-signing-key.pem` (the private key, readable only by you) and the public key, and prints the entry to put into `update-keys.json` in place of the placeholder. Commit that file. Keep an offline backup of the private key: a lost key means every app needs an update before it accepts the next signed file.
2. Sign and publish, whenever the config or the YouTube code changes:

   ```sh
   # raise "revision" in packages/sources/src/youtube/youtube-config.json first
   scripts/sign-config.sh --key ~/fxm-keys/fxm-update-signing-key.pem
   # raise YOUTUBE_MODULE_VERSION in packages/sources/src/youtube/module/version.ts first
   scripts/sign-module.sh --key ~/fxm-keys/fxm-update-signing-key.pem
   ```

   They write the file and its `.sig` into `apps/site/public/updates/`, which the site serves at `/updates/`, after checking the signature the way the apps will. They refuse a version that is not higher than the one already there, and a key that `update-keys.json` doesn't list. Commit both files and deploy.
3. **To undo a bad release,** sign the previous good content again with a higher version: apps never go back to a lower one.

**Signing in CI instead** (optional, not set up): create a GitHub environment, for example `update-signing`, with the owner as its required reviewer, and store the PEM as its secret `FXM_UPDATE_SIGNING_KEY`. A manually started workflow that uses that environment runs `scripts/sign-config.sh --key-env FXM_UPDATE_SIGNING_KEY` (and `sign-module.sh`) and commits the result. The deploy job never uses that environment.

## Loading code

`codeArtifact` turns the verified bytes into a module with `importModuleFromBytes`: a `blob:` URL made from exactly those bytes (nothing is fetched again between the check and the import), imported, then revoked.

- **Content Security Policy.** The page's `script-src` must allow `blob:`. The desktop app's does (`apps/desktop/src-tauri/tauri.conf.json`). The Android app has no policy yet; one added later must include `blob:` in `script-src`. The web app's never does.
- **The host allow-lists still apply.** The module gets nothing but the `ctx.fetch` of each call, the platform transport that refuses every host not in `src/hosts.ts`. Underneath, the native layers limit what any code in the webview could reach: on desktop the HTTP plugin's scope (`capabilities/default.json`), and the page's `connect-src`, from which stage 7.2 drops `https:`; on Android the OkHttp plugin's host list (6.2), plus the `connect-src` of the policy the Android build still has to get. A signed module runs with the app's own rights, so the signature is what keeps foreign code out.
- **Updating the module's host list** therefore always takes an app update: a module that needed a new host could not reach it.

## Verifying on each platform

Signatures are checked with WebCrypto's Ed25519 where the platform has it and it passes a known-answer test (RFC 8032, test 2, and a forged copy that must fail), and otherwise with [`@noble/curves`](https://github.com/paulmillr/noble-curves) 2.4 (MIT; audited at 2.3.0 by Trail of Bits in August 2026, and for Ed25519 at 1.6.0 by Cure53 in September 2024), in RFC 8032's strict mode (no ZIP-215 leniency). SHA-256 always comes from `@noble/hashes`, so it needs no secure context.

| Platform | Ed25519 in WebCrypto | Engine |
|---|---|---|
| Android System WebView, WebView2 (Windows), Chrome, Edge | 137 and later | WebCrypto, else the library |
| WKWebView (macOS), Safari | 17 and later (macOS 12.6 and later can have it) | WebCrypto; macOS 11 uses the library |
| WebKitGTK (Linux) | Depends on the build | Whichever passes the test |
| Firefox | 129 and later | WebCrypto, else the library |
| Node (tests, scripts) | 22 | WebCrypto |

Versions from MDN's browser-compat-data, read 2026-10-26. The known answer is test 2, not test 1, because WebKit's Ed25519 refuses test 1's valid signature of an empty message while it verifies non-empty ones (measured 2026-10-26 in Playwright's WebKit 27.2 and in the desktop app's WKWebView on macOS 15). FXM never signs an empty message. The library needs only `BigInt` (Chrome 67, Safari 14, Firefox 68), and importing a `blob:` module needs dynamic `import()` (Chrome 63, Safari 11.1, Firefox 67), so every webview the apps support can verify and load updates.

## F-Droid builds

F-Droid's [inclusion policy](https://f-droid.org/docs/Inclusion_Policy/) (Security & Legal Compliance, item 5; the text as of 2026-10-26, last changed 2026-10-16) says: "Applications must not download additional executable binary files (e.g. add-ons, auto-updates, etc.) without explicit user consent. Consent means it needs to be opt-in (it must not be harder to decline than to accept or presented in a way users are likely to press accept without reading) and structured in a way that clearly explains to users that they're choosing to bypass F-Droid's checks if they activate it."

So a build with `distribution: 'fdroid'` (`parseDistribution(FXM_DISTRIBUTION)`, set by the F-Droid build of stage R.3):

- downloads and loads the module only while `allowCode()` says the user opted in, and goes back to the bundled module when they opt out. The config is data, so it is still fetched;
- turns FXM's own app-update check off: `updatePolicy('fdroid').appUpdateCheck` is `false` for 6.6 to honour;
- asks with `CODE_UPDATES_CONSENT`: a title, three short paragraphs that say the code comes from FXM, not F-Droid, and that turning it on bypasses F-Droid's checks, and two equal buttons, "Turn on" and "Not now". Show them in the same style, with neither preselected. The setting's label repeats that it bypasses F-Droid's checks.

## Hosting

The signed files live in `apps/site/public/updates/` once the owner publishes them, and the site serves them at `https://fxm-music.pages.dev/updates/`. A stage that renames the site changes `DEFAULT_UPDATE_BASE_URLS`. The apps fetch them through their native HTTP, so the site needs no CORS headers for them, but the desktop HTTP plugin's scope and the Android plugin's host list must include that folder. Update URLs are HTTPS folders without credentials or a query (`http://localhost` and `http://127.0.0.1` are allowed for development). Requests are plain GETs with `credentials: 'omit'` that follow no redirect, with a 15 s limit for signature files and 60 s for artifacts.

## Tests

- `format.test.ts`, `verify.test.ts`, `keys.test.ts`: the format, signing, both verification engines (a forged, flipped or relabelled signature, an unknown key, a changed statement, the wrong artifact, a lying or missing WebCrypto), and key checks, including small-order keys and the placeholder.
- `updater.test.ts`: restore and check against a fake site: bad signatures, rollback attempts (also after the stored copy is lost), unreachable hosts and timeouts, HTTP errors, damaged or oversized files, versions that fail to load, a failing store, F-Droid opt-in and opt-out, and the fallbacks to the next URL, the last good version and the bundled copy.
- `youtube.test.ts`: the real module bundle, built as `scripts/sign-module.sh` builds it, fixing a deliberately broken bundled parser after a signed update, and still fixed after a restart without a request; a changed or foreign-signed module, a build with only the placeholder key and an F-Droid build without the opt-in all leave the bundled copy in place.
- `e2e/`: the same flow in real browser engines under the desktop app's Content Security Policy, loading the module from a `blob:` URL, and in the desktop app itself (`e2e/desktop.mjs`, run on macOS on 2026-10-26). Neither is part of `make test`; see `e2e/README.md`.
- `live.test.ts` (`make live-smoke`): what the site publishes verifies and loads; skipped while the key is the placeholder.

```sh
scripts/run.sh pnpm vitest run packages/platform/src/updates
```
