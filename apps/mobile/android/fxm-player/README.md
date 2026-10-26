# fxm-player: FXM's native player on Android

The Android app's audio (stage 6.3): Media3's ExoPlayer in a `MediaSessionService` that runs as a `mediaPlayback` foreground service, with the media notification and lock-screen controls of its media session, and `FxmPlayer`, the Capacitor plugin that connects it to the web app's player. On the JavaScript side, `NativeEngine` in `@fxm/player` ([its README](../../../../packages/player/src/native/README.md)) is the player facade's engine over this plugin.

## Why native playback

In the WebView, audio would stop or stutter when Android freezes or throttles a backgrounded app, and nothing would keep going if the WebView's renderer died. So the app plays through Media3 in a foreground service:

- **The process stays alive.** Media3 starts the foreground service when playback starts and keeps it while playing, and for 10 minutes after a pause, a failure or the end. An app with a foreground service is not cached, so Android 14's cached-app freezer leaves it alone, and with it the WebView whose JavaScript resolves the streams. That this holds on a real device, with the screen off for 30 minutes, is the inference this stage leaves for the owner to confirm (see [the checks](#checks-on-a-device)). The WebView's renderer keeps the app's priority (`RENDERER_PRIORITY_IMPORTANT`, WebView's default).
- **Track boundaries need no JavaScript.** The web app resolves the next items ahead (up to 5 or 40 minutes of audio, at the request budget's prefetch priority) and queues them here, so Media3 moves on by itself, gapless, even while JavaScript is slow, frozen or gone. URLs last about 6 hours, so the queue stays valid.
- **The app survives its renderer.** When the WebView's renderer dies (killed by the system for memory, or with `adb`), the plugin tells Android it handled it (`onRenderProcessGone` returns `true`; otherwise Android kills the whole process), stops talking to the dead page, and the service plays on. `WebViewRecovery` then recreates the activity, whose new WebView loads the web app, which attaches again and carries on where Media3 is.

## How it fits together

```
web app (WebView)                       this module (same process)
  Player facade ── NativeEngine ──────► FxmPlayerPlugin ──► PlaybackService
        ▲             ▲  events           (Capacitor)          ├─ Coordinator (the logic)
        │             └──────────────────────────────────────  ├─ ExoPlayer ── ResolvingDataSource ── OkHttp (fxm-http)
  StreamLifecycle ◄── resolve the queue, re-resolve on 403/expiry ├─ MediaSession ── notification, lock screen, Bluetooth
                                                               └─ NetworkWatcher (Android's network callbacks)
```

| File | What |
|---|---|
| `Coordinator.kt` | The logic, testable on the JVM: the playlist of [slots](#slots-and-sources), what the web app decides, what happens natively when it does not answer |
| `PlaybackService.kt` | The `MediaSessionService`: ExoPlayer, the media session and notification, the ticker that reports the state |
| `ExoPort.kt` | The coordinator's `PlayerPort` over ExoPlayer, and the playlist items |
| `DataSources.kt` | `EntryResolver` (the `ResolvingDataSource` resolver: current URL and per-URL headers) and `LoadErrorPolicy` |
| `SourceTable.kt`, `EntryUris.kt`, `StreamIdentity.kt` | Slot keys to URLs and headers; which sources serve the same bytes (an equal URL or the web app's file key) |
| `SessionPlayer.kt` | What the system controls see: next and previous go to the coordinator, stop pauses; the playlist, repeat, shuffle and speed are the web app's |
| `FxmPlayerPlugin.kt`, `PlayerMessages.kt` | The Capacitor plugin and its messages |
| `WebViewRecovery.kt`, `RendererRecovery.kt`, `RestartPolicy.kt` | Bringing the web app back after its renderer died: the Android glue, the decisions (testable on the JVM) and the back-off |
| `NetworkWatcher.kt`, `NetworkChanges.kt` | Which network callbacks change the network |
| `Failures.kt` | Media3's errors as the web app's `EngineError` types, with the HTTP status |
| `Effects.kt`, `EqualizerProcessor.kt` | The audio effects (stage 8.1): the equalizer's filters and headroom and the loudness gain, as plain Kotlin computing what the web app's `@fxm/core` computes, and the Media3 `AudioProcessor` that runs the equalizer in the audio sink |

## Who decides what

The web app owns the queue and resolves every stream; native code never resolves anything. While the web app is attached:

- It **loads** the current item, paused until it plays, and keeps the **upcoming** items queued here.
- Media3 **moves on by itself** at a track boundary and reports the `transition`; the web app's player follows and adopts the entry instead of loading it again.
- A **failure** goes to the web app with its type and HTTP status (`error`); its stream lifecycle decides what to resolve (a fresh URL on 403, the fallback rung, another format) and loads it at the same position.
- The system's **next and previous** (notification, lock screen, headset, Bluetooth) go to the web app (`command`), which acknowledges them and acts: it knows shuffle, repeat and "previous restarts after 3 s". While paused, the web app then loads the entry queued for the new item, paused, so the notification shows it and its play button plays it. Play, pause and seeking are Media3's own and reach the web app as state; a play while the web app's player is paused makes it play. A stop (a car, a Bluetooth device, a headset's stop key) pauses: ExoPlayer's own stop would drop the buffer and go idle without a failure.
- An upcoming URL that is **about to expire**, or bound to an **earlier network**, is asked for afresh (`request`); the web app resolves it again and queues it under the same id.

When the web app does not answer, Media3 carries on alone: after 30 s it skips a failed entry (after 4 failures in a row it stops), after 8 s it acts on a next or previous itself (previous restarts the track), and when its queue runs out while the web app has more, it asks `WebViewRecovery` to bring the web app back. Without the web app attached it does all of that at once.

## Slots and sources

Each queued entry is a **slot** with a key; the playlist item's URI is `fxm-entry://slot/<key>`. Media3 opens it through `ResolvingDataSource`, whose resolver (`EntryResolver`) looks the key up in `SourceTable` on every connection and returns the entry's current URL with its per-URL headers (`StreamOption.requestHeaders`). So:

- A **fresh URL for the same file** (an equal URL, or the same `fileKey`: `StreamIdentity`) only updates the table. The next connection, after a seek or a reconnect, uses it at the same byte offset. The web app sets the key from what it knows about the stream (for googlevideo URLs, `itag`, `lmt`, `clen` and `dur`), so this module reads nothing out of any service's URLs, and a change there needs no new APK.
- **Another file** for an entry (another format, the fallback rung) gets a new slot, so Media3 prepares it again instead of reading the new file at the old offsets.
- A URI that is not a slot, e.g. one a media controller sends, is refused: Media3 fetches nothing but FXM's entries.

**Files on the device** (stage 6.4). A `file` source is an offline copy in the app's downloads folder (a `file:` URI) or a song of the device's own (a MediaStore `content://media/<volume>/audio/media/<id>` URI). fxm-downloads' [`DeviceFiles`](../fxm-downloads/src/main/kotlin/io/github/pratyayops/fxm/downloads/DeviceFiles.kt) checks it when the message arrives: the canonical path must be inside the downloads folder, so neither `..` nor a symbolic link reaches the app's other files, and a content URI must name a MediaStore audio item; anything else is refused with `BAD_REQUEST`. The app's WebView serves the page the same files and no others ([fxm-downloads](../fxm-downloads/README.md#what-the-page-may-read)). Media3 reads it through `DefaultDataSource` (built on the OkHttp factory, so HTTPS still goes through fxm-http's client): `FileDataSource` for a file, `ContentDataSource` for MediaStore. A file never expires and is bound to no network, and one that is gone or may not be read (the download deleted, music access taken back) fails at once instead of being retried, so the web app streams the song instead. The web app sends the WebView URL of the file it plays (Capacitor's `/_capacitor_file_/…` or `/_capacitor_content_/…`), and the native engine turns it back into the file's URI (`deviceFileUri` in `@fxm/player`).

**Plain GETs.** Every request is an ordinary `GET` through `OkHttpDataSource` on fxm-http's shared client: from the start without a `Range` header (googlevideo answers 200 for VISIONOS URLs), and `Range: bytes=<n>-` after a seek (206). No chunked requests, no `range=` parameters, no POSTs, no SABR. An entry's headers cannot set `Range`, `If-Range`, `Accept-Encoding`, cookies or framing headers. The client applies FXM's host, `Origin`, `Referer`, cookie and `User-Agent` rules ([fxm-http's README](../fxm-http/README.md)) to the audio and to the artwork the notification shows, so nothing goes through `HttpURLConnection` and the WebView's cookies.

**Retries.** A 401, 403, 404 or 410, a request FXM's rules refuse and an unknown entry fail at once (`LoadErrorPolicy`): retrying the same URL cannot help, the web app resolves a new one. Other errors keep Media3's retries.

**Buffering.** Up to 10 minutes or 32 MiB ahead, at least 2 minutes: whole songs, so a track keeps playing through a network change and the radio sleeps between bursts. Video tracks are disabled: itag 18 is a video file whose picture nothing shows.

**Network changes.** Android's default-network callbacks keep arriving with the screen off. A different default network, losing it, or new addresses on it bump the network id: the web app's stream lifecycle drops its cached URLs (`NativeEngine.network` is its `NetworkMonitor`), and the IP-bound upcoming entries are resolved again.

## The bridge protocol

`packages/player/src/native/plugin.ts` and `FxmPlayerPlugin` speak it; `PlayerMessages` encodes it here. Messages name entries by id, never by URL.

| Method | Takes | Does |
|---|---|---|
| `attach` | — | Attaches the page: events start. Resolves with the session: the entries, the state, a failure nothing replaced, the snapshot and the network |
| `load` | `entry`, `startAtMs`, `upcoming`, `hasMore`, `repeat` | Plays `entry` from `startAtMs`, paused until `play`, with `upcoming` queued after it. An entry already queued after the current one, with the same id and bytes, is skipped to, keeping its buffer |
| `setUpcoming` | `upcoming`, `hasMore`, `repeat` | Replaces the entries after the current one; the unchanged leading entries (same ids and bytes, in order) keep their slot and buffer, everything after the first change gets new slots |
| `play`, `pause`, `seek` (`positionMs`), `setVolume` (`volume`, 0 to 1) | | As named |
| `setEffects` | `equalizer` (`enabled`, ten `gainsDb`), `loudness` (`enabled`, `targetLufs`, `mode` `track` or `album`), `speed` (0.5 to 2) | The audio effects (stage 8.1): see [Audio effects](#audio-effects) |
| `setSleepTimer` | `endsAt` (epoch ms or `null`), `fadeMs`, `endOfTrack` | Pauses at `endsAt` after fading out over `fadeMs`, or at the end of the current entry; neither cancels the timer |
| `ack` | — | Takes over a system control's next or previous |
| `saveSnapshot` | `data` (a string up to 4 Mi characters, or `null`) | Keeps the web app's queue for when it attaches again |
| `release` | — | Stops and forgets the queue |
| `crashRendererForTesting` | — | Debug builds only: crashes the WebView's renderer (`chrome://crash`) for [check 2](#checks-on-a-device) |

An entry is `{ id, uid, source: { kind?, url, headers?, expiresAt?, ipBound?, network?, fileKey?, loudness? }, metadata: { title, artists, album?, artworkUrl?, durationMs? }, data? }`: an id the web app chooses (`[A-Za-z0-9._:-]{1,100}`), the queue item's uid, an HTTPS URL, and what the notification shows. `kind` is `http` (the default) or `file` (stage 6.4: a `file:` or `content:` URI, see [Slots and sources](#slots-and-sources), with nothing else but its `loudness`); other kinds are refused. `fileKey` (at most 200 characters) names the bytes the URL serves. `loudness` (`trackLufs`, optional `albumLufs`, each from −70 to 6 LUFS) says how loud the audio is; a malformed one is left out, not refused. `data` (at most 16 Ki characters) is the web app's own, opaque here and returned in the session: the web app keeps the entry's stream there, so a recreated page takes the entry over without resolving it again. At most 50 upcoming entries. Malformed messages are rejected with `BAD_REQUEST`; `UNAVAILABLE` means the service could not be bound, `INTERNAL` that the player failed.

| Event | Payload |
|---|---|
| `state` | `id`, `positionMs`, `durationMs` (-1 unknown), `playing`, `playWhenReady`, `state` (`idle`, `buffering`, `ready`, `ended`). On every change, and every second while playing (every 5 s while the app is not on screen) |
| `transition` | `from`, `to`, `reason`: `auto` (the previous entry ended), `repeat` (repeat one), `skip` (Media3 skipped a failed entry or followed a system control on its own) |
| `error` | `id`, `type` (`network`, `decode`, `unsupported`, `expired`), `status` (the HTTP status, or `null`), `message` |
| `request` | `id`, `reason` (`expiring`, `network`) |
| `command` | `command` (`next`, `previous`) |
| `network` | `id` (counts the changes), `cellular` |
| `sleep` | `reason` (`timer`, `end-of-track`): the sleep timer ended, pausing playback if it played (the web app says so only then) |

## Audio effects

Stage 8.1; the web app's player sends them with `setEffects` (`NativeEngine.setEffects` and `setPlaybackRate`).

- **The equalizer** runs in Media3's audio sink: `EqualizerProcessor`, a custom `AudioProcessor` that `PlaybackService`'s renderers factory puts before the speed change (`DefaultAudioSink.Builder.setAudioProcessors`, otherwise the default sink). It processes the decoded PCM, 16-bit or float, of every stream (unlike a web page, the native player reads YouTube's bytes too): the headroom gain, then ten peaking filters per channel (`EqualizerDsp`), with the same bands, Q, coefficients and headroom as the web (`Effects.kt`; the JVM tests compare them with `@fxm/core`'s numbers). Off or flat, it copies the buffers. A new setting applies from the next buffer.
- **Loudness normalization** turns each entry down to the target through the player's volume (the web app's volume × the entry's gain × the sleep timer's fade), from the entry's `source.loudness`. The coordinator sets it when an entry is loaded and at every boundary Media3 crosses by itself (`onMediaItemTransition` comes when the audible position crosses it), so a track never plays at the one before's level. It never turns a quiet track up: none of the streams the native player takes (YouTube, Internet Archive, Jamendo) say their peak, and the entries carry none. Turning up through the processor would also land a little late at a gapless boundary, because the sink processes ahead of what is heard. An offline copy (a `file` source, 6.4) is turned down by its stream's loudness, like the stream.
- **Speed:** `ExoPlayer.setPlaybackSpeed`, pitch unchanged (Media3's Sonic).
- **The sleep timer** keeps time here, with the screen off: at its time minus the fade it fades the volume out in steps (every 250 ms), pauses at its time, puts the volume back and sends `sleep`. "End of track" sets `pauseAtEndOfMediaItems`; when Media3 pauses at the end of the entry (`PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM`) the coordinator clears it and sends `sleep`. It works without the web app attached too.
- **No crossfade** yet: one ExoPlayer plays one entry at a time. The web app's player then crosses tracks gapless.

## The service and the session

- **Foreground service type** `mediaPlayback`, with the `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `WAKE_LOCK` permissions. Media3 holds a partial wake lock and a Wi-Fi lock while playing (`C.WAKE_MODE_NETWORK`), handles audio focus and pauses when headphones are unplugged.
- **Not exported.** Only FXM binds to the service: the plugin with its own action, to reach the coordinator. The notification, the lock screen, Bluetooth and headsets reach the session through the platform's media session, as Android routes them. Media notifications need no `POST_NOTIFICATIONS` permission.
- **The notification** is Media3's default, with FXM's mark as its small icon (`res/drawable/fxm_notification_icon.xml`, drawn by `apps/mobile/scripts/icons.ts`); tapping it opens the app. Its artwork comes through fxm-http's client too, so only from hosts on FXM's table: YouTube Music's album art on `*.googleusercontent.com` is not on it yet, and those tracks show none until it is.
- **Swiping the app away** keeps playback going while it plays (Media3's default). The page is gone then, so Media3 plays what it has queued and stops; reopening the app attaches again.
- **Offline copies and the device's music** play from the device: the `file` sources above (stage 6.4).

## Tests

```sh
make android-test   # the JVM tests of fxm-http and fxm-player, offline, no device
```

The coordinator is plain Kotlin behind a `PlayerPort`, so its tests (`CoordinatorTest`) drive it with a fake player, a fake clock and a fake scheduler: loading and queueing, skipping to a queued entry, fresh URLs for the same file (by file key) and for another, track boundaries and repeat one, failures the web app acts on or does not, the native fallbacks and the stop after 4 failures, the system's next and previous, network changes, expiring URLs, sessions (with the entries' data) and snapshots. `EffectsTest` covers the filters, the curve and the headroom against `@fxm/core`'s numbers, the equalizer on 16-bit and float buffers (a sine measured through it), clipping and the loudness gain; `EffectsCoordinatorTest` the effects reaching Media3, each entry's level across boundaries, and the sleep timer (fade, pause, end of track, cancel, without the web app). `RecoveryTest` covers when the page comes back after a renderer death (at once on screen, and when the app is opened while a restart waits). `PlayerMessagesTest`, `SourcesTest` and `PoliciesTest` cover the messages, slot URIs, the header rules, `StreamIdentity`, the restart back-off, `NetworkChanges` and the failure types, and `FileSourcesTest` file sources in the messages (which files those may be is `DeviceFilesTest` in fxm-downloads: `..`, links, other folders and content providers). The Media3 and Android glue (`PlaybackService`, `ExoPort`, `SessionPlayer`, `NetworkWatcher`, `WebViewRecovery`, the plugin) is compiled by `make apk` and checked on a device. `apps/mobile/android-project.test.ts` checks the service declaration, the shared client, the renderer handling and that both sides use the same names and limits.

## Versions

Media3 1.11.1 (released 2026-09-11; it needs compileSdk 36). Its OkHttp data source is built against OkHttp 4.12; the app resolves fxm-http's 5.4.0, which keeps every method the data source calls (checked against the 5.4.0 classes, see [CLEAN-ROOM.md](CLEAN-ROOM.md)).

## Checks on a device

The JVM tests cover the logic, `make apk` the build. What only a device shows, for the owner (the stage's "done when" is the first three). The web app plays through the native engine (stage 6.4 wired it, in `apps/web/src/features/now-playing/playback.ts`, as [`@fxm/player`'s native README](../../../../packages/player/src/native/README.md#using-it) asks).

1. **30 minutes with the screen off.** Play an album or a playlist, lock the phone and leave it. Playback continues across at least 6 track boundaries without gaps or stops. Meanwhile `scripts/run.sh adb shell dumpsys activity processes` lists the app's process in a foreground-service state, not as cached, which is what keeps Android 14's freezer away.
2. **Killing the WebView's renderer.** While playing, open `chrome://inspect` on a computer with the phone connected, inspect the app's WebView and run `Capacitor.Plugins.FxmPlayer.crashRendererForTesting()` in its console (debug builds only; it loads `chrome://crash`, as Android documents for testing renderer deaths). On an emulator or a rooted phone, `scripts/run.sh adb shell kill <pid>` of the app's `sandboxed_process` does the same. Playback continues, the app does not crash, and the page reloads within seconds showing the track that plays. After repeated deaths in the background it waits (30 s, 2 min, then 10 min), but opening the app reloads it at once.
3. **After the native queue runs out.** Repeat 2 with a playlist longer than the queued items (5 tracks or 40 minutes): playback continues past them, because the reloaded page resolves more. With the app swiped away instead, playback stops after the queued tracks, by design.
4. **The notification and lock screen.** Title, artist, artwork, play/pause, next, previous and seeking work, also from a Bluetooth headset; next follows shuffle and repeat. While paused, next from the lock screen shows the next track, and play then plays that track (not the old one), as the app shows. A headset's or car's stop pauses, and play resumes.
5. **A network change.** Switch between Wi-Fi and mobile data while playing: the current track plays on (it is buffered), and the next one starts with a fresh URL.
6. **An expired or refused URL.** Pause for over 6 hours, then play: playback resumes with a fresh URL at the same position.
7. **A paused app in the background.** Pause from the notification, wait 15 minutes, press play on a Bluetooth headset. Whether Android lets Media3 return to the foreground from the background is device-dependent; Media3 reports a refusal through `onForegroundServiceStartNotAllowedException`.
8. **A queue the catalog mode hides.** In Music + Video mode, play a few videos, switch to Music while one plays, then repeat 2. The reloaded page has nothing Music mode may play: playback stops and the notification goes away, so no audio plays that the app does not show.
9. **Without the player service.** `scripts/run.sh adb shell pm disable io.github.pratyayops.fxm/io.github.pratyayops.fxm.player.PlaybackService`, then start FXM: the plugin can't bind the service, and the web app plays in the WebView instead (`chrome://inspect` shows "FXM: the native player is unavailable; playing in the WebView"). The saved queue comes back, songs play and move on, and Media3's notification never appears. `scripts/run.sh adb shell pm enable io.github.pratyayops.fxm/io.github.pratyayops.fxm.player.PlaybackService` turns the service back on. A phone that refuses `pm disable` for another app's component needs an emulator for this check.
