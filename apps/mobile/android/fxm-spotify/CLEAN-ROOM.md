# Clean-room log: fxm-spotify

Where each fact this module relies on comes from, with the date it was checked. The code was written from these facts and from the public APIs of Capacitor (MIT), androidx (Apache-2.0), OkHttp and Okio (Apache-2.0) and the Android SDK. No code was copied, and no GPL or AGPL project (Spotube or its Spotify plugin, Bloomee, NewPipe) was opened for it. The Spotify protocol facts are also indexed in Spotify's own log, [`packages/sources/src/spotify/CLEAN-ROOM.md`](../../../../packages/sources/src/spotify/CLEAN-ROOM.md), as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks.

## Spotify (checked 2026-10-26)

| Fact | Source |
|---|---|
| `GET https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F` answers `307` to `/en/login?continue=https%3A%2F%2Fopen.spotify.com%2F` and sets a `__Host-sp_csrf_sid` cookie. Its content security policy lets the page load Google's reCAPTCHA (`www.google.com/recaptcha/`, `www.gstatic.com/recaptcha/`), OneTrust's cookie banner, Google Analytics and Tag Manager, Sentry and Facebook profile images, and allows forms to post to the page's own origin only (`form-action 'self'`) | One request from this Mac with a browser `User-Agent`, 2026-10-26 05:46 UTC (no account, no cookie sent) |
| Spotify's login sets the `sp_dc` cookie for `.spotify.com`; `open.spotify.com/api/token` with `reason=transport` and that cookie answers a logged-in token (`isAnonymous: false`), with the same TOTP parameters as the anonymous token | [The user-side research memo](../../../../docs/research/2026-10-25-userside-memo.md), sections 3.2 and 3.6 (2026-10-25), and the token flow in the Spotify provider's log; not yet confirmed with a real account (see the README's checks on a device) |
| When the cookie no longer logs in, the token endpoint answers an anonymous token, which the provider refuses for the account (`isAnonymous` not `false` → `login-required`) | The Spotify provider's token manager (stage 1.5, `packages/sources/src/spotify/token.ts`) |
| An account made with Google signs in with its email address once it has a Spotify password: "Create a Spotify password to log in with your email address instead … you don't need to use the Google button to log in", through the password reset form at `https://www.spotify.com/password-reset` | Spotify Support, ["Logging in to Spotify with Google"](https://support.spotify.com/ca-en/article/google-login-help/), read 2026-10-26 |
| FXM Connect's bridge forwards only `reason`, `productType`, `totp`, `totpServer` and `totpVer` to the token endpoint, at most about ten requests a minute, reads at most 64 KiB and refuses redirects; this module keeps the same limits | `apps/extension/src/bridge.ts` and `messages.ts` (FXM's own code), `SPOTIFY_TOKEN_PARAM_FORMS` in `packages/platform/src/connect.ts` |

## Sign-ins that refuse embedded WebViews (read 2026-10-26)

| Fact | Source |
|---|---|
| Google blocks its OAuth sign-in in embedded webviews: announced on 2021-06-23 for 2021-09-30, the user gets a `disallowed_useragent` error. Google recommends the system browser (Custom Tabs) instead | Google Developers Blog, ["Upcoming security changes to Google's OAuth 2.0 authorization endpoint in embedded webviews"](https://developers.googleblog.com/en/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/) (2021) |
| Facebook Login stopped supporting Android embedded browsers (WebViews) on 2021-10-05 | Meta for Developers, ["Deprecating Facebook Login support on Android WebViews"](https://developers.facebook.com/docs/facebook-login/android/deprecating-webviews) |
| An Android WebView's `User-Agent` keeps the real Android version and device model and ends its platform part in `; wv`; Chrome for Android's reduced agent is `Mozilla/5.0 (Linux; Android 10; K) … Chrome/<major>.0.0.0 Mobile Safari/537.36` | Chromium, ["User-Agent Reduction"](https://www.chromium.org/updates/ua-reduction/) (recorded in fxm-http's log, 2026-10-26) |

FXM keeps the `; wv` marker in the login window's agent: it does not try to pass the window off as a browser to Google or Facebook.

## Capacitor 8.5.3 (`@capacitor/android`, read 2026-10-26)

| Fact | Source |
|---|---|
| `CapacitorCookies` (registered in every app, callable from the page's JavaScript as `Capacitor.Plugins.CapacitorCookies`) reads and writes cookies through `CapacitorCookieManager`, whose store is `android.webkit.CookieManager.getInstance()`, the default WebView profile's: `getCookies`, `setCookie`, `deleteCookie`, `clearCookies`, `clearAllCookies` | `capacitor/src/main/java/com/getcapacitor/plugin/CapacitorCookies.java`, `CapacitorCookieManager.java` |
| A plugin starts an activity for a result with `startActivityForResult(call, intent, callbackName)`; the method named `callbackName` must carry `@ActivityCallback` and takes `(PluginCall, ActivityResult)`. The launchers are registered for every such method when the plugin is loaded. The call is saved with `bridge.saveCall`, and the callback gets the saved call or, failing that, `getPluginCallForLastActivity()`, which may be `null` when the page that asked is gone | `Plugin.java` (`initializeActivityLaunchers`, `startActivityForResult`, `triggerActivityCallback`), `Bridge.java` (`saveCall`, `releaseCall`) |
| `Bridge.executeOnMainThread(Runnable)` runs work on the main thread | `Bridge.java` |

Capacitor facts recorded in fxm-http's log apply here too: plugin methods run on one thread, plugins outside npm packages are registered before `BridgeActivity.onCreate`, `loggingBehavior: 'none'` keeps plugin results out of logcat, and Capacitor's process-wide `CookieHandler` reads the default profile's cookies for every `HttpURLConnection`.

## Android and androidx (read 2026-10-26)

| Fact | Source |
|---|---|
| androidx.webkit 1.9.0 (2023-11-29) added profiles: "separate browsing sessions between WebViews, each profile has its own data (e.g. cookies)"; a profile's `CookieManager` and `WebStorage` "are specific to the profile, and information is not shared between different profiles"; `CookieManager#getInstance` keeps working on the default profile. `WebViewCompat.setProfile` assigns a profile to a WebView (before it is used), and `ProfileStore` creates, finds and deletes them; both are `@UiThread`, and need `WebViewFeature.MULTI_PROFILE`, without which they throw `UnsupportedOperationException` | [androidx.webkit release notes](https://developer.android.com/jetpack/androidx/releases/webkit), 1.9.0-alpha01 to 1.9.0; the `Profile`, `ProfileStore` and `WebViewCompat` classes of androidx.webkit 1.14.0 (`javap` on the AAR in Gradle's cache) |
| `CookieManager.getCookie(url)` returns the cookies for a URL as `name=value` pairs separated by `; `, HttpOnly ones included; `removeAllCookies(callback)` calls back on the calling thread's looper; `flush()` writes the store to disk | Android API reference, `android.webkit.CookieManager` |
| `WebViewClient.shouldOverrideUrlLoading(WebView, WebResourceRequest)` is not called for POST requests, may be called for subframes (`isForMainFrame`), and is called for server redirects. The default `WebChromeClient` refuses permission requests, file choosers and new windows | Android API reference, `WebViewClient`, `WebResourceRequest`, `WebChromeClient` |
| Android Keystore AES keys (`KeyGenParameterSpec`, `AES/GCM/NoPadding`) never leave the keystore; with randomized encryption (the default) the keystore chooses each nonce, which `Cipher.getIV()` returns; keys of an app are deleted with it | Android developers, "Android keystore system"; `KeyGenParameterSpec.Builder` reference |
| `Context.getNoBackupFilesDir()` holds files that automatic backup never includes | Android API reference, `Context.getNoBackupFilesDir` |
| From Android 15 (targetSdk 35 and later) activities draw edge to edge, so an activity applies the system bar, cutout and keyboard insets itself (`WindowInsetsCompat.Type.systemBars()`, `displayCutout()`, `ime()`) | Android developers, "Display content edge-to-edge in your app" |
