# Clean-room log: fxm-player

Where each fact this module relies on comes from, with the date it was checked. The code was written from these facts and from the public APIs and sources of Media3 (Apache-2.0), Capacitor (MIT) and OkHttp (Apache-2.0). No code was copied, and no GPL or AGPL project (NewPipe, Bloomee, Spotube or its plugins) was opened for it.

## Media3 1.11.1 (`androidx.media3`, sources jars from Google's Maven, read 2026-10-26)

| Fact | Source |
|---|---|
| 1.11.1 was published on 2026-09-11; its AARs declare `minCompileSdk=36` and `minSdkVersion` 23 | `Last-Modified` of `media3-exoplayer-1.11.1.pom` on `dl.google.com/android/maven2`; `META-INF/com/android/build/gradle/aar-metadata.properties` and `AndroidManifest.xml` in the AARs |
| `MediaSessionService` runs in the foreground while a session's player plays or wants to (`playWhenReady`, buffering or ready), and for `DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS` (600,000 ms) after it paused, stopped, failed or ended; a refused start ends in `onForegroundServiceStartNotAllowedException` | `MediaSessionService.java`, `MediaNotificationManager.java` (`shouldRunInForeground`, `isAnySessionUserEngaged`) |
| A session must be added (`addSession`) for its notification when no outside controller connects; `onBind` answers only its own actions, so other actions can be handled by the service | `MediaSessionService.java` (`addSession`, `onBind`) |
| By default, removing the app's task keeps the service while a session plays, and stops it otherwise | `MediaSessionService.onTaskRemoved` |
| Without a bitmap loader, a session loads artwork with `DataSourceBitmapLoader` on a `DefaultDataSource.Factory` (so `DefaultHttpDataSource`); one set with `setBitmapLoader` is used instead, wrapped for size limits and caching | `MediaSession.java` (`ensureBitmapLoaderIsSizeLimited`), `DataSourceBitmapLoader.java` |
| `DefaultMediaNotificationProvider.setSmallIcon` sets the notification's small icon | `DefaultMediaNotificationProvider.java` |
| `media3-session` adds an exported `BluetoothValidationActivity` guarded by `android.permission.BLUETOOTH_PRIVILEGED` | `AndroidManifest.xml` in `media3-session-1.11.1.aar` |
| `ResolvingDataSource` calls its resolver for every connection it opens, and the resolver may block | `ResolvingDataSource.java` |
| `OkHttpDataSource` sends a `GET` without `Range` from position 0 with an unknown length, `Range: bytes=<position>-` otherwise, `Accept-Encoding: identity` unless gzip is allowed, and the `DataSpec`'s headers; a non-2xx answer throws `HttpDataSource.InvalidResponseCodeException` with `responseCode` | `OkHttpDataSource.java` (`makeRequest`, `open`) |
| `DefaultLoadErrorHandlingPolicy` retries all but parser, file-not-found, cleartext and unexpected-loader errors, waiting `min((errorCount − 1) × 1000, 5000)` ms | `DefaultLoadErrorHandlingPolicy.java` |
| `ExoPlayer.replaceMediaItems` updates items in place when the new ones have the same local configuration (URI), and otherwise adds the new and removes the old ones; a `fromIndex` at the end appends | `ExoPlayerImpl.java` (`replaceMediaItems`) |
| `ForwardingSimpleBasePlayer` routes every seek through `handleSeek` with its command; `seekToNext` and `seekToPrevious` reach it as `COMMAND_SEEK_TO_NEXT` and `COMMAND_SEEK_TO_PREVIOUS` even without a next or previous item, as long as the command is in the state's available commands | `ForwardingSimpleBasePlayer.java`, `SimpleBasePlayer.java` (`seekTo`, `updateStateForPendingOperation`), `BasePlayer.java` (`seekToNext`, `ignoreSeek`) |
| `DefaultLoadControl.Builder` takes the buffer durations and a target buffer size in bytes | `DefaultLoadControl.java` |
| `SimpleBasePlayer.stop()` acts only while `COMMAND_STOP` is available and calls `handleStop()`, which `ForwardingSimpleBasePlayer` forwards to the wrapped player's `stop()`; a legacy controller's stop (`MediaSessionLegacyStub.onStop`) calls the session player's `stop()` | `javap -c` of `SimpleBasePlayer`, `ForwardingSimpleBasePlayer` (media3-common 1.11.1) and `MediaSessionLegacyStub` (media3-session 1.11.1), read 2026-10-26 |
| A controller's play goes through `Util.handlePlayButtonAction`: `prepare()` when the player is idle, `seekToDefaultPosition()` when it ended, then `play()` | `javap -c` of `Util` and `MediaSessionImpl.handleMediaControllerPlayRequestInternal` (1.11.1), read 2026-10-26 |
| `media3-datasource-okhttp` 1.11.1 depends on OkHttp 4.12.0. Every OkHttp method its `OkHttpDataSource` calls (27, listed with `javap -c`) exists with the same JVM signature in the Android build of OkHttp 5.4.0, which the app resolves | `media3-datasource-okhttp-1.11.1.pom`; `javap` of `OkHttpDataSource` and of `okhttp-android-5.4.0` |

## Media3 1.11.1 and Capacitor: files on the device (stage 6.4, `javap` of the runtime jars, read 2026-10-26)

| Fact | Source |
|---|---|
| `DefaultDataSource.Factory(Context)` makes its HTTP data sources with `DefaultHttpDataSource.Factory`; `DefaultDataSource.Factory(Context, DataSource.Factory)` uses the factory it is given for every URI it doesn't read itself | `javap -c` of `DefaultDataSource$Factory` (media3-datasource 1.11.1) |
| `DefaultDataSource.open` reads a local file URI (`Util.isLocalFileUri`: no scheme or `file`) with `FileDataSource` (`AssetDataSource` under `/android_asset/`), and the schemes `asset`, `content`, `rtmp`, `udp`, `data`, `rawresource` and `android.resource` with their own data sources; anything else goes to the base factory | `javap -c` of `DefaultDataSource` |
| `FileDataSource` reports a missing file as `ERROR_CODE_IO_FILE_NOT_FOUND` (2005) and a refused one as `ERROR_CODE_IO_NO_PERMISSION` (2006); `ContentDataSource` reports a `FileNotFoundException` as 2005. `DataSourceException.reason` carries the code | `javap -c` of `FileDataSource`, `ContentDataSource`, `DataSourceException`; `javap -constants` of `PlaybackException` (media3-common 1.11.1) |
| Capacitor's local server serves a device file at `<origin>/_capacitor_file_<path>` and a content URI at `<origin>/_capacitor_content_<authority>/<path>`, the URLs `convertFileSrc` makes; `deviceFileUri` in `packages/player/src/native/device-files.ts` turns them back into the `file:` and `content:` URIs the player reads | `WebViewLocalServer.java`, `AndroidProtocolHandler.java`, `src/main/assets/native-bridge.js` (Capacitor 8.5.3) |
| `File.getCanonicalPath` resolves `.`, `..` and symbolic links. fxm-downloads' `DeviceFiles` compares the canonical paths of the downloads folder and of the file, so neither a `..` in a URI nor a link (in the folder or on the app's data path) can make a file look inside the folder when it isn't, or outside when it is | JDK documentation of `File.getCanonicalPath`; `DeviceFilesTest` |

## Capacitor 8.5.3 (`@capacitor/android`, read 2026-10-26)

| Fact | Source |
|---|---|
| `BridgeWebViewClient.onRenderProcessGone` returns `true` only when a registered `WebViewListener` does, and Capacitor registers none of its own | `BridgeWebViewClient.java`, `WebViewListener.java` |
| `Bridge.addWebViewListener` registers such a listener | `Bridge.java` |
| With the `KeepRunning` preference at its default (`true`), Capacitor does not pause the WebView's timers when the activity pauses | `Bridge.java` (`shouldKeepRunning`, `onPause`), `cordova/MockCordovaWebViewImpl.java` (`handlePause`, `setPaused`) |
| `BridgeActivity.onDestroy` and `onDetachedFromWindow` let the plugins clean up and destroy the WebView; `saveInstanceState` saves only plugin calls, not the WebView | `BridgeActivity.java`, `Bridge.java` |
| `Plugin.notifyListeners` resolves every listener call registered for the event; plugin lifecycle hooks (`handleOnStart`, `handleOnStop`, `handleOnDestroy`) follow the activity's | `Plugin.java`, `Bridge.java` |
| Natively registered plugins get an injected `addListener` that returns `{ remove }` at once; `registerPlugin` from `@capacitor/core` returns a promise of the handle | `src/main/assets/native-bridge.js` (`cap.addListener`), `JSExport.java`; `@capacitor/core` `dist/index.js` |

## Android (documentation, read 2026-10-26)

| Fact | Source |
|---|---|
| `onRenderProcessGone` must return `true` if the app handled the renderer's exit; "otherwise, application will crash if render process crashed, or be killed if render process was killed by the system". The WebView cannot be used afterwards. `loadUrl("chrome://crash")` crashes the renderer for testing | [`WebViewClient.onRenderProcessGone`](https://developer.android.com/reference/android/webkit/WebViewClient#onRenderProcessGone(android.webkit.WebView,%20android.webkit.RenderProcessGoneDetail)) |
| A WebView's default renderer priority is `RENDERER_PRIORITY_IMPORTANT` "regardless of visibility" | [`WebView.setRendererPriorityPolicy`](https://developer.android.com/reference/android/webkit/WebView#setRendererPriorityPolicy(int,%20boolean)) |
| From Android 14, processes in the cached state are frozen 10 seconds after entering it; a non-cached status, "a bound foreground service or foreground status", keeps a process active | [Cached apps freezer](https://source.android.com/docs/core/perf/cached-apps-freezer) |
| A `mediaPlayback` foreground service needs the `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permission and no runtime prerequisite | [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types) |
| Starting a foreground service from the background is refused except in listed cases, among them the user acting on the app's notification | [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) |
| Notifications of media sessions are exempt from the Android 13 notification permission | [Notification runtime permission](https://developer.android.com/develop/ui/views/notifications/notification-permission) |

## Services (from the research and stage 1.4)

| Fact | Source |
|---|---|
| YouTube stream URLs work only from the IP address that resolved them and expire about 6 hours after issue (`expire`) | [ARCHITECTURE.md §3](../../../../docs/ARCHITECTURE.md#3-external-constraints-measured-october-2026), measured 2026-10-25 |
| VISIONOS URLs answer a `GET` without `Range` with 200 and a ranged `GET` at the end of the file with 206 | ARCHITECTURE.md §3 (client landscape), measured 2026-10-25 |
| googlevideo stream URLs carry `itag` (the format), `lmt` (the file's last-modified time), `dur` and, except itag 18, `clen` (the file's length); fresh resolutions of the same format differ in the signed and per-request fields. The web app builds an entry's `fileKey` from them (`streamFileKey` in `packages/player/src/native/entries.ts`); this module reads nothing out of the URLs | Stage 1.4's captured `player` answers (`packages/sources/src/youtube/stream/fixtures`, 2026-10-26, whose log records that itag 18 has no `clen`) |
