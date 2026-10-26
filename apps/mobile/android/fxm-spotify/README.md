# fxm-spotify: the Spotify login on Android

The Android app's own Spotify login (stage 6.5): a login window where the user signs in on Spotify's own page, the login it keeps, and `FxmSpotifyLogin`, the Capacitor plugin that gets the Spotify provider its logged-in tokens with that login. The TypeScript side is `packages/platform/src/android-spotify-login.ts`: `createPlatform` uses it by itself on Android as the platform's `spotifySession`, so `capabilities.spotify` is `account` there, and stage 3.5's account sync works as on the web. The web gets the same tokens from FXM Connect's bridge, with the browser's own login.

**FXM never handles the password, and the login cookie never reaches page JavaScript.** JavaScript asks for a token and gets Spotify's answer, as from FXM Connect's bridge; the token stays in the Spotify provider's memory.

## How it works

1. **Connect** in Settings → Spotify account (after its notice) opens the login window when no login is kept, and so does **Log in to Spotify** later.
2. **The login window** (`SpotifyLoginActivity`, not exported) shows Spotify's login page (`https://accounts.spotify.com/login?continue=…open.spotify.com…`) in a WebView of its own:
   - It runs in the WebView profile `fxm-spotify-login` (androidx.webkit's multi-profile support). Its cookies and storage are its own: the app's WebView, Capacitor's `CapacitorCookies` plugin (which any script of the page can call) and Capacitor's process-wide cookie handler all use the default profile's, so Spotify's cookies never reach them. On a WebView without profiles the window doesn't open at all, and Settings asks the user to update Android System WebView.
   - It has no JavaScript interface, runs no script of FXM's and never looks at a request: the password goes from Spotify's page to Spotify. Nothing is injected, intercepted or read but the cookie below.
   - Its main frame stays on Spotify's hosts and Apple's sign-in, over HTTPS. **Google and Facebook refuse sign-ins in embedded WebViews** (Google answers `disallowed_useragent`), so choosing either shows why instead, and the window says so from the start. A link opens Spotify's password reset, which gives an account made with Google or Facebook a password for logging in with its email address. Every other host and scheme (`intent:`, `spotify:`) stays closed.
   - Its `User-Agent` is the WebView's reduced as Chrome for Android sends it (`Android 10; K`, the Chrome major version only), still marked `; wv`: Spotify's page and what it loads don't learn the phone's model, and sign-ins that refuse app windows still see one.
   - Each login starts from an empty profile, and rotating the phone or opening the keyboard keeps the page. While the keyboard is up, the notice and the password reset link make way for the page.
   - **Nothing of a login stays behind.** Whenever the window goes (logged in, closed with ✕ or Back, given up for another app, closed by Android, its renderer lost), it wipes the profile once its WebView is gone: the cookies of a login given up (an Apple ID's, say), any a late response set after the capture, the storage and the network cache (`WebView.clearCache`, which clears the WebView's own profile's, and on newer WebViews `WebStorageCompat.deleteBrowsingData`). WebView deletes a profile only before the app's process loads it, so the plugin deletes it whole at the app's next start, which also covers an app ended with the window open (no `onDestroy` then).
   - **Come back through the recent apps screen.** `MainActivity` is `singleTask`: starting it again, from the launcher icon or the media notification (whose tap opens the app's launch intent), finishes every activity above it, this window included, and the login in progress is lost. The window's notice says so, for the user who leaves it to read a one-time code. Making `MainActivity` `singleTop` would keep the window; that is a follow-up, once a device confirms it.
3. **The cookie.** As soon as Spotify sets its `sp_dc` login cookie in the profile (the window looks after every page and once a second), the window reads it from the profile's `CookieManager`, keeps it, clears the profile's cookies and storage (a first pass: the wipe above follows), and closes. Closing the window without logging in keeps an earlier login.
4. **Kept** (`SessionStore`): sealed with AES-256-GCM under a key in the Android Keystore that never leaves it (`KeystoreCipher`), in a file in the app's no-backup folder (`fxm-spotify-session`), so neither backups nor device transfers carry it (the app's backup rules exclude everything anyway). Only the cookie is kept, not Spotify's other cookies. A login that never opens again (a damaged file, a key gone, invalidated or unrecoverable, bytes of another key) is deleted and counts as logged out. One the keystore can't open just now (it also fails for a moment: secure hardware busy or out of reach) stays kept, and the token call fails with `STORAGE` until it opens again. A key that can't seal any more is replaced with a new one, once.
5. **The token call** (`SpotifyTokenCall`): `GET https://open.spotify.com/api/token` with the query parameters JavaScript sent, only those FXM Connect's bridge forwards (`reason`, `productType`, `totp`, `totpServer`, `totpVer`), each in its form. The URL is fixed in native code. The cookie goes into an `FxmCookieJar` on a client built for this one call with `FxmHttp.withCookies` (fxm-http's shared client, with a jar added), for `open.spotify.com/api/token` alone, and the jar is emptied when the call ends. The shared client, which every plugin request and Media3 use, has no cookie jar (`CookieJar.NO_COOKIES`) and never gets the cookie. FXM's network rules apply as to every native request: HTTPS, the host table, a browser `User-Agent` for Spotify, no `Set-Cookie` kept. A redirect fails the call, so the cookie never follows one. At most 10 calls a minute (as FXM Connect's bridge), answers of at most 64 KiB, 15 s per call.
6. **Logout** (Disconnect in Settings, or Log out of Spotify there while the account is off; `logout`): deletes the kept login and its Keystore key, and wipes the login window's profile. Either deletion is enough for the login never to open again; when neither works, `logout` rejects with `STORAGE`, and Settings says FXM couldn't delete its login and offers Log out of Spotify again, also after a restart. The Spotify session itself stays valid elsewhere; signing out of all devices is in Spotify's account page.

When the kept login stops working (the user changed their password, or signed out everywhere), Spotify answers the token call with an anonymous token; the provider reports `login-required`, and Settings offers the login window again.

## The bridge protocol

The TypeScript side (`packages/platform/src/android-spotify-login.ts`) and `SpotifyLoginPlugin` speak it; `LoginMessages` encodes it here, and `LoginTables.kt` holds the shared constants, generated from `@fxm/platform` by `apps/mobile/scripts/native-tables.ts`.

| Method | Takes | Resolves with |
|---|---|---|
| `status` | — | `loggedIn` (a login is kept), `available` (the window can open: the WebView has profiles) |
| `login` | — | The same, once the window closes. Without profiles it resolves at once, without opening |
| `logout` | — | The same, after logging out; `STORAGE` when the kept login could not be deleted |
| `requestToken` | `params`: the token request's query parameters | `status` and `json` (Spotify's body, `null` when it is no JSON object or array) |

Errors carry a `code` from `FXM_SPOTIFY_LOGIN_ERROR_CODES` (generated into `LoginErrorCode`): `BAD_REQUEST`, `LOGGED_OUT`, `BUSY`, `NO_ACTIVITY`, `RATE_LIMITED` (with `data.retryAfterMs`), `NETWORK`, `TIMEOUT`, `TOO_LARGE`, `STORAGE`. `createAndroidSpotifyLogin` turns them into `FxmError`s the provider understands: `LOGGED_OUT` is `AuthRequired`, so the provider reports `login-required`. Messages never hold the cookie, a token or the parameters' values. Capacitor's bridge logging stays off (`loggingBehavior: 'none'`), so no answer reaches logcat.

## Tests

```sh
make android-test   # the JVM tests of fxm-http, fxm-player and this module: offline, no device
```

- `SpotifyTokenCallTest`, against `FakeSpotify` (a local HTTPS MockWebServer with a test authority, as fxm-http's `FakeInternet`): the cookie goes to the token endpoint alone, with the allow-listed parameters in order and the browser agent, no `Origin` or `Referer`; the shared client carries none; Spotify's `Set-Cookie` is never kept; parameters outside the allow-list and a missing login send nothing; a redirect fails without following; non-JSON answers, answers over 64 KiB, the rate limit, timeouts and an unreachable Spotify; a keystore failure that may pass sends nothing and answers `STORAGE`.
- `SessionStoreTest`: the login sealed (never in plain text), replaced with a fresh nonce, deleted with its key, and deleted when it never opens again (another key, a key gone, an unrecoverable key, a damaged file, a nonce the keystore never makes, bytes sealed for something else), but kept, with `STORAGE`, through a keystore failure that may pass (a `ProviderException`); a key that fails to seal replaced once; logging out failing only when neither the file nor the key could be deleted; the file replaced whole, and its deletion failing when it stays.
- `LoginPageTest`: finding `sp_dc` among other cookies, where the window may go (Spotify, Apple; Google and Facebook told apart; everything else closed) and the window's `User-Agent`.
- `LoginMessagesTest`: the messages and the rate limiter.

The Keystore cipher, the window and the plugin need Android itself: the checks on a device below cover them. `apps/mobile/android-project.test.ts` (part of `make test`) checks that the module is built in and its plugin registered, that the window isn't exported, sets its profile before anything else touches its WebView, never reads the default cookie store and wipes its profile whenever it goes (and the plugin at the app's start), that no file of the module adds a script interface, injects a script or intercepts requests, that the token URL is the Spotify provider's and only the token call builds a client with a cookie jar, and that the login screen says Google sign-in doesn't work there. `packages/platform/src/android-spotify-login.test.ts` covers the TypeScript side against `createFakeFxmSpotifyLogin`, also as the Spotify provider's login source.

## Checks on a device

What only a phone can show, for the owner (FXM has no Spotify account of its own; nothing changes in the account). Install the debug APK as [DEVELOPMENT.md](../../../../docs/DEVELOPMENT.md#android-app) describes, and inspect the app's WebView from `chrome://inspect` on a computer where the steps say so.

1. **Log in with email and password.** Settings → Sources: Spotify on. Settings → Spotify account → Connect your account → Connect: the login window opens on Spotify's page, with FXM's notice above it. Log in. Expect the window to close by itself and Settings to say "Connected as …", then "Last synced just now: …". (The Spotify TOTP secret comes from GitHub's raw-file host, outside FXM's host table: until the app platform passes it as a user host, the stage 2.9b wiring, Spotify can't mint tokens; then the system dialog asks once to allow `raw.githubusercontent.com`.)
2. **The other login methods.** Disconnect, Connect again and try: a one-time code by email or phone (the window must stay open while you switch apps, and close once you are in); "Continue with Google" (the notice says Google doesn't allow it, nothing else happens); "Continue with Facebook" (the same); "Continue with Apple" (should work); the password reset link (it opens Spotify's reset page in the window). Note any step that lands on "This window opens only Spotify's login pages": it names a host the window should allow. With the keyboard up, the notice and the reset link should make way for the page, and come back when it goes.
3. **Coming back to the window.** With the window open, switch to another app, then come back three ways: through the recent apps screen (expect the window, as you left it), through the FXM icon on the home screen, and, with music playing, through the media notification. `MainActivity` is `singleTask`, so the last two are expected to close the window today: Settings then offers Log in to Spotify again. Note what each does: if the icon or the notification closes it, the follow-up (`singleTop`) is confirmed.
4. **A login given up leaves nothing.** Open the window, start "Continue with Apple", sign in to Apple's page but close the window with ✕ before finishing. `scripts/run.sh adb exec-out run-as io.github.pratyayops.fxm find app_webview -name Cookies` lists the WebView profiles' cookie stores: the app's own under `Default`, the login window's and the evaluator's under `Profile <n>`. Copy each `Profile <n>` store to the computer (`scripts/run.sh adb exec-out run-as io.github.pratyayops.fxm cat '<its path>' > /tmp/fxm-cookies`) and read it with `sqlite3 /tmp/fxm-cookies 'select host_key, name from cookies'`: expect no `.apple.com` or `.spotify.com` row in any of them, then delete the copy. Close FXM from the recents and open it again: the login window's `Profile <n>` folder is gone.
5. **A captcha**, if Spotify shows one: it should work in the window (reCAPTCHA loads in frames, which the window doesn't restrict).
6. **The cookie stays apart.** In the app's WebView console: `await Capacitor.Plugins.CapacitorCookies.getCookies({ url: 'https://open.spotify.com' })` answers `{}`, and `await Capacitor.Plugins.FxmSpotifyLogin.status()` says `loggedIn: true`. `await Capacitor.Plugins.FxmSpotifyLogin.requestToken({ params: { reason: 'transport', productType: 'web-player', totp: '000000', totpServer: '000000', totpVer: '1' } })` resolves with Spotify's status and JSON (a 400 for the made-up TOTP), with no cookie in it.
7. **The token is the account's.** After step 1, Home shows Spotify's personal sections and the library has "Liked songs on Spotify". If the account stays logged out after a successful login, Spotify's token endpoint may want more than `sp_dc`: note it, it is a follow-up.
8. **Logout.** Settings → Spotify account → Disconnect: "Disconnected and logged out of Spotify on this phone." `status()` says `loggedIn: false`, and the next Connect shows Spotify's login page empty (no account remembered). (A logout that fails says "Disconnected, but FXM couldn't delete its Spotify login on this phone" and offers Log out of Spotify; only a broken disk and keystore at once cause it.)
9. **Survives a restart and screen-off.** Log in, close the app from the recents, open it: still connected, no login window. With music playing and the screen off for an hour or more, the next sync still works (the Keystore key needs no unlocked screen).
10. **A recreated activity.** With *Developer options → Don't keep activities* on, Connect: log in in the window. When FXM comes back, Settings may reload; expect "Connected as …" once it has checked the login.
11. **No backup.** `adb shell bmgr backupnow io.github.pratyayops.fxm` backs up nothing (the app opts out), and `adb backup` excludes the app.
12. **An old WebView.** On a phone whose Android System WebView is too old for profiles (`WebViewFeature.MULTI_PROFILE` unsupported), Settings explains it and the window never opens.

**Results** (fill in): device and Android version, WebView version (`chrome://version` in the inspector), each step's result, the date.

## Layout

| File | What |
|---|---|
| `SpotifyLoginPlugin.kt` | The Capacitor plugin and its activity callback |
| `SpotifyLoginActivity.kt`, `res/layout/fxm_spotify_login.xml` | The login window |
| `LoginPage.kt` | The login page's rules: where the window may go, finding the cookie, the window's `User-Agent` |
| `SessionStore.kt`, `KeystoreCipher.kt` | The kept login, sealed with a Keystore key |
| `SpotifyTokenCall.kt`, `RateLimiter.kt` | The token call with the kept login |
| `SpotifyLogin.kt` | One store, token call and profile per app process; logout |
| `LoginMessages.kt`, `LoginFailure.kt`, `LoginTables.kt` (generated) | The bridge's messages, errors and constants |

Where each fact this module relies on comes from: [CLEAN-ROOM.md](CLEAN-ROOM.md).
