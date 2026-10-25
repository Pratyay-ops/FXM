# @fxm/mobile

The FXM Android app: the web app (`apps/web`) in a [Capacitor](https://capacitorjs.com) 8 WebView. This stage (6.1) is the shell and its repo-local toolchain. Native networking (6.2) and the Media3 player for background audio (6.3) come later.

## Build it

```sh
make android-setup   # once: JDK and Android SDK in .tools/
make apk             # apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Installing it on a phone, disk usage, licenses and cleanup are covered in [DEVELOPMENT.md](../../docs/DEVELOPMENT.md#android-app). `make test` runs this package's tests, which only read files and need no Android tools.

## Layout

```
capacitor.config.ts   app id, the web build to wrap, plugin settings (`cap sync` copies it into android/)
android/              the native project from `cap add android`, committed; build output is gitignored
  app/src/main/       AndroidManifest.xml, MainActivity, res/ (theme, icons, backup rules)
  variables.gradle    SDK levels and AndroidX versions from Capacitor's template
scripts/
  build-apk.sh        make apk
  icons.ts            the launcher and splash icons, drawn from the FXM mark
  generate-icons.ts   writes them into android/app/src/main/res (`pnpm icons`)
  png.ts              a minimal PNG encoder and decoder
*.test.ts             checks of the config and the native project
```

Run Capacitor commands through the package script, which sets `CI=1` so the CLI stays non-interactive and sends no telemetry:

```sh
scripts/run.sh pnpm --filter @fxm/mobile cap sync android
```

## How it works

- **Web app.** `build:mobile` in `apps/web` builds the app with base `/` into `apps/web/dist-mobile`, and `cap sync` copies it into the APK. The WebView serves it from `https://localhost/`, so the router's basename, which follows `import.meta.env.BASE_URL`, is `/` instead of the web's `/app/`. Stage 6.2's header policy has to account for that origin.
- **Networking.** Capacitor's global `CapacitorHttp` patch stays **disabled**: it drops the Cookie, Origin and Referer headers and corrupts binary bodies. Stage 6.2 injects an explicit native `fetch`. Until then the app reaches only the hosts that the web app reaches without FXM Connect.
- **System bars and splash.** The app uses the web app's dark theme: `backgroundColor` and the window background are `#0b0b0f`, and the status and navigation bars are dark with light icons (`SystemBars.style: 'DARK'`). Android 15 and later draw the app edge to edge. Then `SystemBars.insetsHandling: 'native'` passes the insets to the page on WebView 140 and later, where the page's `viewport-fit=cover` and `env(safe-area-inset-*)` keep content clear of the bars. On older WebViews it pads the WebView instead. The splash screen shows the FXM mark on the same background: Android 12's splash API, through `core-splashscreen` on older versions.
- **Backups.** `android:allowBackup="false"` plus `res/xml/data_extraction_rules.xml` keep app data out of cloud backups and device-to-device transfers, because the app will hold sign-in sessions (stage 6.5).
- **Versions.** Capacitor's defaults: minSdk 24 (Android 7), compileSdk and targetSdk 36, Android Gradle plugin 8.13 and Gradle 8.14.3. `versionName` comes from this package's `version`, and `versionCode` stays 1 until release builds (stage 6.6).

What differs from Capacitor's template:

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
2. Run `make apk` and commit the regenerated `android/capacitor.settings.gradle`, which points into pnpm's store by version, and `android/app/capacitor.build.gradle`.
3. For a new major version, follow Capacitor's upgrade guide. Compare `android/` with the template in `node_modules/@capacitor/cli/assets/android-template.tar.gz`, and move `SDK_PLATFORM` and `SDK_BUILD_TOOLS` in `scripts/android-setup.sh` along with the new SDK levels. A test fails while the platform differs.
