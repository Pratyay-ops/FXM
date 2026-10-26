# Clean-room log: fxm-http

Where each fact this module relies on comes from, with the date it was checked. The code was written from these facts and from the public APIs of Capacitor (MIT) and OkHttp and Okio (Apache-2.0). No code was copied, and no GPL or AGPL project (NewPipe, Bloomee, Spotube or its plugins) was opened for it.

## Capacitor 8.5.3 (`@capacitor/android`, read 2026-10-26)

| Fact | Source |
|---|---|
| When the bridge starts, `CapacitorCookies.load()` calls `CookieHandler.setDefault` with a `CapacitorCookieManager`, whose `get` and `put` read and write the WebView's `android.webkit.CookieManager`. It does so whether or not the `CapacitorCookies` JavaScript patch is enabled | `capacitor/src/main/java/com/getcapacitor/plugin/CapacitorCookies.java`, `CapacitorCookieManager.java` |
| `CapacitorHttp` sends requests through `HttpURLConnection` (`CapacitorHttpUrlConnection`), so they use that cookie handler | `plugin/CapacitorHttp.java`, `plugin/util/HttpRequestHandler.java` |
| Plugin methods run on one `HandlerThread` named `CapacitorPlugins`; results may be delivered from any thread | `Bridge.java` (`callPluginMethod`), `MessageHandler.java` |
| Natively registered plugins appear to JavaScript as `Capacitor.Plugins.<name>`, each method calling `Capacitor.nativePromise`; plugins outside npm packages are registered with `registerPlugin` before `BridgeActivity.onCreate` runs | `JSExport.java` (`getPluginJS`), `BridgeActivity.java` |
| With `loggingBehavior` `debug` (the default), debug builds log every plugin call and result to the WebView console (`logToNative`, `logFromNative`), and `BridgeWebChromeClient.onConsoleMessage` forwards console messages to logcat | `src/main/assets/native-bridge.js`, `CapConfig.java`, `BridgeWebChromeClient.java` |
| A plugin reads its options from `capacitor.config.ts` under `plugins.<name>` | `Plugin.getConfig()`, `PluginConfig.java` |
| `Bridge.registerAllPlugins()` registers `CapacitorCookies`, `WebView`, `CapacitorHttp` and `SystemBars` in every app, then the app's own plugins (those `BridgeActivity.registerPlugin` adds), each with `plugins.put(name, …)` into one map. So an app plugin with a built-in plugin's name replaces it, and calls from JavaScript reach only the map's plugin. A plugin's name is its `@CapacitorPlugin(name)`, or its class's simple name when that is empty, as for `CapacitorHttp` | `Bridge.java` (`registerAllPlugins`, `registerPlugin`, `pluginId`, `callPluginMethod`), `BridgeActivity.java`, `PluginHandle.java` |
| `CapacitorHttp`'s methods (`request`, `get`, `post`, `put`, `patch`, `delete`) never read `plugins.CapacitorHttp.enabled`; only the JavaScript patch (through the `CapacitorHttpAndroidInterface.isEnabled()` interface its `load()` adds) and the local proxy at `/_capacitor_http_interceptor_` do. `PluginHandle` loads each plugin as it is registered, so a replaced `CapacitorHttp` has added that interface already, and it still answers `false` | `plugin/CapacitorHttp.java`, `assets/native-bridge.js`, `WebViewLocalServer.java` (`shouldInterceptRequest`), `PluginHandle.java` (`load`) |
| `Plugin.getContext()` is the bridge's context: the activity | `Plugin.java`, `Bridge.java` (`getContext`) |
| `PluginCall.reject(message, code, exception, data)` sends `data` with the error, and `native-bridge.js` copies every field of the error onto the `CapacitorException` the promise rejects with, so JavaScript reads `error.code` and `error.data` | `PluginCall.java`, `assets/native-bridge.js` (`returnResult`) |
| The bridge's generated JavaScript creates `Capacitor.Plugins.<name>` once per page, as one object with a function per plugin method | `JSExport.java` (`getPluginJS`) |

## OkHttp and Okio (read 2026-10-26)

| Fact | Source |
|---|---|
| OkHttp's cookies come only from the `CookieJar` a client is built with (`NO_COOKIES` by default); it consults `java.net.CookieHandler` only through the separate `JavaNetCookieJar` | OkHttp 5.4.0 API docs and `okhttp3.CookieJar` |
| `OkHttpClient.newBuilder()` builds a client that shares the first one's connection pool, dispatcher and interceptors, so a client with a cookie jar of its own can sit beside the shared one | OkHttp 5.4.0 API docs (`OkHttpClient.newBuilder`); checked in `FxmHttpTest` |
| `BridgeInterceptor` adds the jar's cookies, `Accept-Encoding: gzip` (decoding the body itself) and a default `User-Agent`, and parses `Set-Cookie` into the jar unless it is `NO_COOKIES`. Application interceptors run before it and may call `proceed` more than once; network interceptors run after it, once per network request | OkHttp's "Interceptors" documentation; `okhttp3.Interceptor` |
| `okio.Pipe` is a bounded buffer between a writing and a reading thread: writes block while it is full, a read returns what is buffered (at least one byte) or -1 once the sink is closed, and `cancel()` fails both sides | Okio 3.17 API docs, `okio.Pipe` |
| The Android build of OkHttp 5.5.0 declares `minCompileSdk=37` in its AAR metadata; 5.4.0 declares 36 | `META-INF/com/android/build/gradle/aar-metadata.properties` in `okhttp-android-5.5.0.aar` and `-5.4.0.aar` from Maven Central |
| OkHttp 5's Android build registers `okhttp3.internal.platform.PlatformInitializer` with AndroidX Startup, which gives it the application context it needs for its public suffix list | `AndroidManifest.xml` in `okhttp-android-5.4.0.aar` |
| The OkHttp and Okio repositories moved from `github.com/square` to `github.com/lysine-dev` (GitHub redirects the old addresses); releases still use the `com.squareup` Maven group. 5.4.0 is the last release whose POM names `square/okhttp` | `curl -I https://github.com/square/okhttp`; the 5.4.0 and 5.5.0 POMs on Maven Central |

## Services (measured 2026-10-25, from the research)

| Fact | Source |
|---|---|
| InnerTube answers requests that carry no `Origin`, or a YouTube origin, and refuses webview origins (`https://localhost`, `tauri://localhost`, …) with 403 | [ARCHITECTURE.md §3](../../../../docs/ARCHITECTURE.md#3-external-constraints-measured-october-2026) |
| Spotify's pathfinder answers non-browser `User-Agent`s (curl, okhttp, Dalvik, python-requests, app agents) with `403 Client/request not allowed` | [The user-side research memo](../../../../docs/research/2026-10-25-userside-memo.md), section 2.3 |
| googlevideo ignores `User-Agent`, `Referer` and `Origin` on media requests | ARCHITECTURE.md §3 |

## Chrome's User-Agent (read 2026-10-26)

| Fact | Source |
|---|---|
| Chrome for Android's reduced `User-Agent` is `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<majorVersion>.0.0.0 <deviceCompat> Safari/537.36`: the Android version and device model are the fixed `10` and `K`, and `<deviceCompat>` is `Mobile` on phones and empty on tablets | Chromium, ["User-Agent Reduction"](https://www.chromium.org/updates/ua-reduction/) |
| Android WebView's agent is not reduced ("no current plans"), so it keeps the real Android version and device model that Chrome's leaves out | The same page |

## Web standards (read 2026-10-26)

| Fact | Source |
|---|---|
| Redirects: at most 20; a `POST` answered with 301 or 302, or any method but `GET` and `HEAD` answered with 303, is repeated as a body-less `GET` without its body headers; `Authorization` is removed when a redirect changes the origin | WHATWG Fetch Standard, "HTTP-redirect fetch" |
| Statuses 101, 103, 204, 205 and 304 have no body; `CONNECT`, `TRACE` and `TRACK` are forbidden methods; a `GET` or `HEAD` request cannot have a body; a text body without a type gets `text/plain;charset=UTF-8` | WHATWG Fetch Standard, "null body status", "forbidden method", "extract a body" |
