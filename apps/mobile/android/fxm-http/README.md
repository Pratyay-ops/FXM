# fxm-http: FXM's native HTTP on Android

The Android app's network access (stage 6.2): one OkHttp client with FXM's network rules, and `FxmHttp`, the Capacitor plugin that gives the web app a `fetch` over it. On Android, `@fxm/platform` uses it as the `NativeHttp` of the Capacitor transport (`createAndroidHttp` in `packages/platform/src/android-http.ts`), so every provider's `ctx.fetch` ends up here. The Media3 player of stage 6.3 must use the same client.

## Why a plugin of its own

Capacitor offers HTTP already, and neither part of it is usable for FXM:

- **Its global fetch patch** (`CapacitorHttp` enabled) drops `Origin`, `Cookie` and `Referer`, turns binary bodies into text or `{}` and buffers responses. It stays off in `capacitor.config.ts`.
- **`CapacitorHttp.request` and every `HttpURLConnection`** share the WebView's cookies: Capacitor installs a process-wide `java.net.CookieHandler` backed by the WebView's cookie jar when it starts (`CapacitorCookies.load()`). A request to YouTube would carry the cookies of any YouTube page the WebView ever loaded, and store new ones there.

OkHttp never consults that handler. It uses only the cookie jar it is built with, and FXM's keeps nothing a server sets.

## What the client enforces

`FxmHttp.client(context)` builds the shared `OkHttpClient` once. `RequestPolicy`, applied by `PolicyInterceptor` before any connection opens, holds every request to these rules, whoever sends it:

| Rule | What it means |
|---|---|
| Hosts | HTTPS only, and only hosts on FXM's host table (generated from `packages/platform/src/hosts.ts` into `PlatformTables.kt`) or hosts the user approved. Anything else fails with `HOST_NOT_ALLOWED` or `HOST_NOT_APPROVED` before it is sent |
| Redirects | Followed by the interceptor itself, so each hop is checked the same way (OkHttp's own following is off). As in `fetch`: at most 20, `POST` turns into `GET` on 301, 302 and 303, `Authorization` is dropped when the origin changes. `redirect: 'manual'` returns the 3xx response, `'error'` fails |
| `Origin` | An empty `origin` header means none, as the platform's native contract says. Any other must be one the host may receive: YouTube's own origins for YouTube's API and media hosts, `https://open.spotify.com` for Spotify, none for anything else. So the WebView's origin (`https://localhost`) can never reach a service. `Referer` follows the same rule |
| Cookies | `FxmCookieJar` is the only cookie source. `DropServerCookies` removes `Set-Cookie` from every response before OkHttp parses it, so no server cookie is kept, sent back or shown to JavaScript (`credentials: 'omit'`, as on the web). A `Cookie` header from JavaScript is dropped. Native code can add a cookie with `FxmHttp.cookieJar.add`: stage 6.5 sends the Spotify login cookie on the token call alone this way |
| `User-Agent` | A request without one gets the WebView's own (`WebSettings.getDefaultUserAgent`), or `plugins.FxmHttp.userAgent` from `capacitor.config.ts`. Spotify always gets a browser agent, because it answers others with `403 Client/request not allowed` |
| Framing | Headers OkHttp manages (`Host`, `Connection`, `Content-Length`, `Transfer-Encoding`, `Accept-Encoding`, …) are dropped, so bodies always arrive decoded |
| User hosts | `GET` and `HEAD` only, and of the caller's headers only `Range`, `If-Range`, `Accept`, `Accept-Language` and `User-Agent`: no token or cookie meant for a service can reach them |

## User-approved hosts

A host outside the table, such as an Invidious instance typed in Settings, works only after the user approved it in a **system dialog**: the WebView's JavaScript can neither show nor answer it, so nothing running in the web app can widen the list by itself. Approvals live in the app's private preferences (`PreferencesApprovedHosts`), which the backup rules keep off backups and device transfers.

`createAndroidHttp` asks on first use: a request that fails with `HOST_NOT_APPROVED` shows the dialog once per host and is retried if the user allows it. Settings can also call `approveHosts`, `approvedHosts` and `revokeHosts`. Without a screen to ask on, the request fails (`NO_ACTIVITY`).

## The bridge protocol

The TypeScript side (`packages/platform/src/android-http.ts`) and `FxmHttpPlugin` speak it; `BridgeMessages` encodes it here.

| Method | Takes | Resolves with |
|---|---|---|
| `request` | `id` (chosen by JavaScript), `url`, `method`, `headers` (plain object), optional `body` with `bodyEncoding` `utf8` or `base64`, `redirect` | Once the headers are in: `status`, `statusText`, final `url`, `redirected`, `headers` as name-value pairs (no `Set-Cookie`), `body` (whether there is one to read) |
| `read` | `id`, `maxBytes` (default 256 KiB, at most 1 MiB) | `data` (base64) and `done`. It waits for at least one byte, then returns what has arrived |
| `abort` | `id` | Nothing. Cancels the call or drops the response; unknown ids are ignored |
| `approveHosts` / `revokeHosts` | `hosts` | `approved` / the remaining `hosts` |
| `approvedHosts` | — | `hosts` |

Errors carry a `code` from `FXM_HTTP_ERROR_CODES` (generated into `BridgeErrorCode`). Messages name the host, never the URL, because URLs can hold tokens.

**Streaming.** `Exchanges` keeps the requests in flight by id. A pump thread copies each body into a bounded Okio `Pipe` (1 MiB) as it arrives; a `read` takes what is there. A slow reader slows the download instead of filling memory, and a fast one gets large chunks. Responses nobody reads for a minute are dropped, and at most 64 are open at once (`BUSY`). Capacitor runs plugin methods on a single thread, so nothing blocks it: OkHttp's dispatcher and a worker pool do the waiting.

**Logging.** `capacitor.config.ts` sets `loggingBehavior: 'none'`: with Capacitor's default, debug builds log every plugin result to the console and from there to logcat, response bodies and Spotify tokens included.

## Media3 (stage 6.3)

The native player ([`fxm-player`](../fxm-player/README.md)) builds its data sources, for the audio and for the notification's artwork, on the shared client, never on `DefaultHttpDataSource`, which uses `HttpURLConnection` and so the WebView's cookies:

```kotlin
val dataSource = OkHttpDataSource.Factory(FxmHttp.client(context))
```

Media3's requests then get the same host rules, redirect checks, cookie jar and browser agent. They carry no `RedirectMode` tag, so redirects are followed. A test in `apps/mobile/android-project.test.ts` fails if native code uses `HttpURLConnection`, `DefaultHttpDataSource` or `CapacitorHttp`.

## Tests

```sh
make android-test   # the JVM tests, offline, no device (run make android-setup once first)
```

They run against `FakeInternet`: a local HTTPS MockWebServer that answers for every host name, with a certificate from a test authority only the test clients trust. URLs keep their real hosts and the default port, so the production policy applies unchanged. `WebViewCookieIsolationTest` is the plan's test: with a process-wide cookie handler holding a `youtube.com` login cookie, as Capacitor's would, no native request carries it, while `HttpURLConnection` does.

The TypeScript side has its own tests (`packages/platform/src/android-http.test.ts`) against `createFakeFxmHttp` from `@fxm/platform/testing`, and `apps/mobile/scripts/native-tables.test.ts` fails while `PlatformTables.kt` differs from `@fxm/platform`. After changing the host table or the bridge constants, regenerate it:

```sh
scripts/run.sh pnpm vitest run apps/mobile/scripts -u
```

## Versions

OkHttp 5.4.0 (MockWebServer and okhttp-tls of the same release in the tests) and Kotlin 2.3.21, both more than two weeks old. OkHttp 5.5 needs compileSdk 37, which the Android Gradle plugin 8.13 of Capacitor 8's project does not support. OkHttp's Android build loads its public suffix list through AndroidX Startup, which its manifest registers.

## Layout

| File | What |
|---|---|
| `FxmHttp.kt` | The shared client, the cookie jar, the browser agent, `DropServerCookies` |
| `RequestPolicy.kt`, `PolicyInterceptor.kt` | FXM's rules for every request and redirect |
| `Hosts.kt`, `PlatformTables.kt` | The host table (generated) and its matching |
| `ApprovedHosts.kt`, `HostApprovals.kt`, `DialogHostApprover.kt` | User-approved hosts and the system dialog |
| `FxmCookieJar.kt` | FXM's own cookie jar |
| `Exchanges.kt` | Requests in flight, streaming bodies, aborts |
| `BridgeMessages.kt`, `FxmHttpPlugin.kt` | The Capacitor plugin and its messages |

Where each fact this module relies on comes from: [CLEAN-ROOM.md](CLEAN-ROOM.md).
