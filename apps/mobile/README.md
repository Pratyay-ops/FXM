# @fxm/mobile

The FXM Android app: the web app (`apps/web`) in a [Capacitor](https://capacitorjs.com) 8 WebView. Stage 6.1 built the shell and its repo-local toolchain, and stage 6.2 its native networking ([`android/fxm-http`](android/fxm-http/README.md)). The Media3 player for background audio (6.3) comes later.

## Build it

```sh
make android-setup   # once: JDK and Android SDK in .tools/
make apk             # apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
make android-test    # the native unit tests (JVM, offline, no device)
```

Installing it on a phone, disk usage, licenses and cleanup are covered in [DEVELOPMENT.md](../../docs/DEVELOPMENT.md#android-app). `make test` runs this package's TypeScript tests, which only read files and need no Android tools.

## Layout

```
capacitor.config.ts   app id, the web build to wrap, plugin settings (`cap sync` copies it into android/)
android/              the native project from `cap add android`, committed; build output is gitignored
  app/src/main/       AndroidManifest.xml, MainActivity, res/ (theme, icons, backup rules)
  fxm-http/           FXM's native HTTP: the shared OkHttp client and the FxmHttp plugin (6.2)
  variables.gradle    SDK levels and AndroidX versions from Capacitor's template, plus OkHttp's
scripts/
  build-apk.sh        make apk
  test-native.sh      make android-test
  native-tables.ts    writes fxm-http's PlatformTables.kt from @fxm/platform (host table, bridge codes)
  icons.ts            the launcher and splash icons, drawn from the FXM mark
  generate-icons.ts   writes them into android/app/src/main/res (`pnpm icons`)
  png.ts              a minimal PNG encoder and decoder
*.test.ts             checks of the config and the native project
```

Run Capacitor commands through the package script. It sets `CI=1`, so the CLI stays non-interactive and sends no telemetry. It also turns on Node's type stripping, which the CLI needs to load `capacitor.config.ts` with TypeScript 7 and which Node 22 enables by default only from 22.18:

```sh
scripts/run.sh pnpm --filter @fxm/mobile cap sync android
```

## How it works

- **Web app.** `build:mobile` in `apps/web` builds the app with base `/` into `apps/web/dist-mobile`, and `cap sync` copies it into the APK. The WebView serves it from `https://localhost/`, so the router's basename, which follows `import.meta.env.BASE_URL`, is `/` instead of the web's `/app/`. Native requests never send that origin to a service: the plugin refuses any `Origin` a host may not receive.
- **Networking.** The web app's `fetch` for providers is `FxmHttp`, FXM's own OkHttp plugin in [`android/fxm-http`](android/fxm-http/README.md): `@fxm/platform` picks it up by itself on Android (`createAndroidHttp`), and the app then reaches YouTube, googlevideo, Spotify and Last.fm like the web app with FXM Connect (`youtube: 'full'`). The plugin keeps its own cookie jar, applies FXM's host and header rules in native code, and only contacts hosts outside FXM's table after the user approved them in a system dialog. Capacitor's global `CapacitorHttp` patch stays **disabled**: it drops the Cookie, Origin and Referer headers, corrupts binary bodies and, like `CapacitorHttp.request`, sends the WebView's cookies. Bridge logging is off (`loggingBehavior: 'none'`), because Capacitor would log response bodies and tokens to logcat; debug the WebView with `chrome://inspect`.
- **System bars and splash.** The app uses the web app's dark theme: `backgroundColor` and the window background are `#0b0b0f`, and the status and navigation bars are dark with light icons (`SystemBars.style: 'DARK'`). Android 15 and later draw the app edge to edge. Then `SystemBars.insetsHandling: 'native'` passes the insets to the page on WebView 140 and later, where the page's `viewport-fit=cover` and `env(safe-area-inset-*)` keep content clear of the bars. On older WebViews it pads the WebView instead. The splash screen shows the FXM mark on the same background: Android 12's splash API, through `core-splashscreen` on older versions.
- **Known gap: the light theme.** The bar icons stay light when you pick the web app's light theme, or its system theme on a phone in light mode. Where the page draws behind the bars (WebView 140 and later), the clock and battery are then hard to read over the light top bar. Following the theme needs a script in the WebView that watches `<meta name="theme-color">` and calls `SystemBars.setStyle`. It must do so only while the page draws behind the bars: where Capacitor pads the WebView, the bars show the dark window background, so light icons stay right there. That script is left to a later stage that injects code into the WebView and can test it on devices.
- **Backups.** `android:allowBackup="false"` plus `res/xml/data_extraction_rules.xml` keep app data out of cloud backups and device-to-device transfers, because the app will hold sign-in sessions (stage 6.5).
- **Versions.** Capacitor's defaults: minSdk 24 (Android 7), compileSdk and targetSdk 36, Android Gradle plugin 8.13 and Gradle 8.14.3. `versionName` comes from this package's `version`, and `versionCode` stays 1 until release builds (stage 6.6).

What differs from Capacitor's template:

- the `fxm-http` module, registered in `MainActivity`, with Kotlin for it;
- the app id and package;
- the icons, the splash screen and the theme colours;
- the backup rules;
- no Google services plugin, because FXM uses no Firebase;
- `versionName` from `package.json`;
- Gradle's smaller `-bin` distribution, checked against its SHA-256;
- Gradle may use only the repo-local JDK;
- the example tests live in the app's package;
- no `app/build/.npmkeep`, so cleaning can delete `app/build`.

## Icons

`scripts/icons.ts` holds the FXM mark in the same 32-unit grid as the web favicon. From it, it draws:

- adaptive launcher icons: vector background, foreground and monochrome layers;
- PNG icons for Android 7, square and round, at five densities;
- the splash icon, kept inside the circle in the middle two thirds that the splash screen shows.

After changing it, run:

```sh
scripts/run.sh pnpm --filter @fxm/mobile icons
```

`scripts/icons.test.ts` fails while the committed resources differ from what the module draws, or when the mark no longer matches the favicon in `apps/web/index.html`.

## Upgrading Capacitor

1. Upgrade all three packages to the same version (pnpm refuses releases younger than 14 days):
   ```sh
   scripts/run.sh pnpm --filter @fxm/mobile add @capacitor/core@^X.Y.Z @capacitor/android@^X.Y.Z
   scripts/run.sh pnpm --filter @fxm/mobile add -D @capacitor/cli@^X.Y.Z
   ```
2. Run `make apk` and commit the regenerated `android/capacitor.settings.gradle`, which points into pnpm's store by version, and `android/app/capacitor.build.gradle`. Without the Android tools, `scripts/run.sh pnpm --filter @fxm/mobile cap update android` regenerates them too. `make test` fails until they are regenerated, and the Android workflow until they are committed.
3. For a new major version, follow Capacitor's upgrade guide. Compare `android/` with the template in `node_modules/@capacitor/cli/assets/android-template.tar.gz`, and move `SDK_PLATFORM` and `SDK_BUILD_TOOLS` in `scripts/android-setup.sh` along with the new SDK levels. A test fails while the platform differs.

## Checks on a device

The unit tests cover the native side on the JVM and the TypeScript side with fakes. What only a device or an emulator can show, for the owner to check (stage 6.2's "done when" needs the first three):

1. **A YouTube Music search.** Needs the YouTube provider (1.3) and a search screen wired to `createPlatform` (2.4). In the app: search for a song; results appear.
2. **A VISIONOS resolve that passes the end-of-file probe.** Needs the stream resolver (1.4). Play a YouTube Music song: the resolver's ranged `GET` of the last 64 KB of the VISIONOS URL returns 206 through the plugin (`fullLength: 'verified'`).
3. **A Spotify search.** Needs the Spotify provider (1.5). With Spotify on in Settings, search; Spotify results appear, which shows the token call and pathfinder accept the WebView's `User-Agent`. If pathfinder answers `403 Client/request not allowed`, set a desktop browser agent as `plugins.FxmHttp.userAgent` in `capacitor.config.ts`.
4. **Cookie isolation on Android itself.** In the console described below, put a cookie into the WebView's jar with `await Capacitor.Plugins.CapacitorCookies.setCookie({ url: 'https://httpbin.org', key: 'webview', value: 'secret' })`, approve the echo service with `await Capacitor.Plugins.FxmHttp.approveHosts({ hosts: ['httpbin.org'] })` (tap "Allow"), then fetch `https://httpbin.org/headers` through the plugin as in the example: the echoed headers have no `Cookie`. The same URL through `Capacitor.Plugins.CapacitorHttp.request({ url: 'https://httpbin.org/headers' })` shows `webview=secret`, the leak the plugin avoids. Revoke the host afterwards (`revokeHosts`).
5. **The approval dialog.** Add an Invidious instance in Settings (when a stage adds that setting) or call `approveHosts` from the console: the system dialog appears; "Don't allow" refuses the host, "Allow" lets its requests through.
6. **Large and binary bodies.** A download or a long playlist page arrives intact, and aborting it (leaving the page) stops the transfer.

To try the plugin before those stages land, open `chrome://inspect` on a computer with the phone connected over USB, inspect the app's WebView and run in its console:

```js
const head = await Capacitor.Plugins.FxmHttp.request({
  id: 'try-1',
  url: 'https://music.youtube.com/sw.js_data',
  method: 'GET',
  headers: { origin: '' },
})
const chunk = await Capacitor.Plugins.FxmHttp.read({ id: 'try-1' })
console.log(head.status, atob(chunk.data).slice(0, 80))
await Capacitor.Plugins.FxmHttp.abort({ id: 'try-1' })
```
