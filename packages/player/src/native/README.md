# The native engine (`@fxm/player`)

`NativeEngine` is the player facade's `Engine` on the Android app's native player (stage 6.3): Media3 in a `mediaPlayback` foreground service, with the media notification and lock-screen controls, through the `FxmPlayer` Capacitor plugin. The native side, and why playback is native on Android, are in [`apps/mobile/android/fxm-player`](../../../../apps/mobile/android/fxm-player/README.md).

## Using it

On Android the app swaps two pieces, wraps its resolver and connects the engine; nothing else changes:

```ts
import {
  connectMediaSession,
  createBrowserNetworkMonitor,
  DirectAudioEngine,
  NativeEngine,
  Player,
  StreamLifecycle,
} from '@fxm/player'

// The Android app's native player; undefined elsewhere, or when its service is unavailable.
const engine = await NativeEngine.create()
const lifecycle = new StreamLifecycle({
  ...options,
  // Android's own network callbacks, which keep arriving with the screen off.
  network: engine?.network ?? createBrowserNetworkMonitor(),
})
const player = new Player({
  engine: engine ?? new DirectAudioEngine(),
  // Taking over what Media3 already plays needs no request (see "Track boundaries").
  resolver: engine?.wrapResolver(lifecycle) ?? lifecycle,
  // The user's catalog mode: connect restores Media3's queue in the player's mode.
  queue: { mode: settings.catalogMode },
})
lifecycle.attach(player)
// The deeper native queue, the system's next and previous, and picking up after a page restart.
const native = await engine?.connect({ player, resolver: lifecycle })
// The app's own restore comes after connect, and only when connect did not resume Media3's queue.
if (!native?.resumed) restoreSavedQueue(player)
// Not on Android: Media3's session already drives the notification and the lock screen.
if (engine === undefined) connectMediaSession(player)
```

- **Await `connect` before the app restores or starts a queue of its own.** When the page was recreated while Media3 kept playing, `connect` restores the queue and the position from Media3 and carries on, and resolves with `resumed: true`; the app skips its own restore then. With `resumed: false` the player is as it was before `connect`. Create the player in the user's catalog mode: `connect` restores in the player's mode, which drops the items it hides (`restoreQueue`). If the player already has a queue when it connects, the engine takes Media3's entry over only when it plays the player's current item (the same uid and track), and releases Media3 otherwise. `connect` never waits for the player to take the entry over.
- **One engine per page.** Creating an engine attaches it to the app's single native player: it gets every event and drives Media3, and `destroy()` releases Media3 (its queue and snapshot) for the whole app. While one engine is alive, creating another on the plugin throws, and connecting an engine to a second player is refused with an error in the console. `NativeEngine.ifAvailable()` creates one synchronously but cannot tell whether attaching worked; `NativeEngine.create()` waits for it and resolves to `undefined` when the native player is unavailable, so the app can fall back to the direct audio engine.
- **Offline copies and the device's music play from the device** (stage 6.4). In the Android app a downloaded track's offline stream (2.3's `OfflineStore`, over the app's own storage) and a song of the device's (local files) carry the WebView URL Capacitor's local server serves the file at, which an `<audio>` element can load too. The engine recognizes those URLs of the page's own origin (`device-files.ts`: `/_capacitor_file_/…`, `/_capacitor_content_/…`; the `origin` option) and sends Media3 a `file` source with the file's own `file:` or `content:` URI, which it reads from the device; the native side plays only files in the app's downloads folder and MediaStore's songs ([fxm-player](../../../../apps/mobile/android/fxm-player/README.md#slots-and-sources)). A `blob:` URL is still `no`. `webViewFileUrl` and `deviceFileUri` are exported for the stores that make such streams.

## How it plays

The facade stays in charge, as with the direct audio engine: it loads each item, retries failures through the stream lifecycle and decides what comes next. The engine maps its calls to the plugin (`load`, `play`, `pause`, `seek`, `setVolume`) and Media3's state back to the engine events (`play`, `pause`, `waiting`, `canplay`, `timeupdate`, `durationchange`, `ended`, `error`; never `stalled`). Media3's failures carry their HTTP status (`EngineError` with `cause: { status }`), so `httpStatusOf` reads it and the lifecycle can tell a 403 from an expired URL. Media3 can send request headers, so streams with `requestHeaders` play; `canPlay` says `no` to streams that are not progressive, neither absolute HTTPS URLs nor files on the device, or carry headers the plugin would refuse.

**Where the engine departs from the `Engine` contract**, because Media3 runs ahead of the page:

- `load` of an item Media3 already holds adopts that entry instead of loading it: no pause, no new request, the position Media3 reached. It seeks only when the facade asks for another position than the one it had when Media3 took the entry (a seek the user made meanwhile).
- `pause` inside the engine's own `ended` event is the facade letting go of the item that ended: the item Media3 moved on to keeps playing. Every other pause reaches Media3.
- The first `seek(0)` after Media3 looped an item itself (repeat one) is dropped, and seeks are ignored while Media3 has moved past the loaded item.
- A Media3 that goes idle without a failure (a stop) reports `pause`.

**Track boundaries.** With `connect`, Media3 holds the next items, resolved, and moves on by itself, gapless. The engine then tells the facade the item ended; the facade moves its queue on and loads the next item, and the engine adopts the entry Media3 already plays. The facade's resolution of that item is answered by `wrapResolver` from the stream Media3 plays, kept with the entry, so the take-over makes no request and cannot fail: without the wrapper, a page whose URL cache missed would resolve again, and a failed resolution could switch Media3 away from a track that plays fine. If Media3 got several items ahead while the page was busy, the facade follows through each in turn. If the facade goes elsewhere (the queue changed at the boundary), Media3 stops until the facade's load replaces it; if the facade's queue ended there, Media3 goes back to the facade's item, paused. On repeat one Media3 loops the item itself, and the facade's restart does not seek it back.

**Media3 follows the facade.** While the facade does not want playback (paused, ended, stopped), Media3 does not play, and it holds the facade's current item where it can:

- Next or previous while paused (in the app, or from the lock screen or a headset) moves Media3 to the entry queued for the new item, keeping its buffer, so the notification shows it and its play button plays it. An item Media3 has no entry for is loaded when the facade plays it; until then Media3's old entry no longer counts as the facade's.
- A system play (the notification, the lock screen, a headset) while the facade is paused makes the facade play, which adopts the entry Media3 holds for its item or loads it. Only a change of `playWhenReady` that no command of the engine's explains counts as one.
- A pause the user makes while the facade takes an item over reaches Media3 at once, and a pause that crosses a boundary in flight leaves both paused on the next item.

**The native queue** (`connect`). The engine resolves the facade's next items through the stream lifecycle, one at a time with `reason: 'preload'` (the request budget's prefetch priority), `explicit: false` and the queue's catalog mode, like the facade's own preloads, and queues them in Media3: up to `depth` items (5) or `aheadMs` of audio (40 minutes). It wraps around for repeat all, and a single item on repeat all loops like repeat one. Items that fail to resolve (rate limited, a Suggest-band guess that needs review) end the queue there; the facade meets them in turn and is tried again after the next track. The plan built from the facade's queue decides what Media3 holds: the facade's own preload only fills in an item the engine could not resolve, and its `preload(null)` changes nothing (without `connect`, `preload` queues the facade's next item and `null` drops it). Entries are matched to queue items by uid and track, so a restored queue that reuses uids never plays another item's entry. An item keeps its native entry, and its buffer, while a fresh source for it is resolved:

- Media3 asks for one (`request`) when an upcoming URL expires before it would finish, or is bound to an earlier network. For an expiring one the lifecycle gets the old stream as an `expired` failure, so it does not hand the same URL back.
- On a network change the engine's `network` monitor notifies the lifecycle, which drops its cached URLs, and the IP-bound entries are resolved again.
- Queue edits (moves, removals, shuffle, repeat) reach Media3 within the same tick. A tail Media3 refused is sent again with the next change.

**Same file, fresh URL.** Each source carries a `fileKey` naming the bytes it serves; Media3 reads on through a fresh URL with the same key at the same byte offset, and prepares an entry anew otherwise. For googlevideo URLs the engine builds the key from `itag`, `lmt`, `clen` and `dur` (`streamFileKey` in `entries.ts`, facts in [fxm-player's CLEAN-ROOM.md](../../../../apps/mobile/android/fxm-player/CLEAN-ROOM.md)); the native side knows nothing about any service's URLs. Until the YouTube source names the file on the `StreamOption` itself, that rule lives here.

**System controls.** The notification's, lock screen's, headset's and Bluetooth's next and previous arrive as `command`s; the engine acknowledges them and calls `player.next()` or `player.previous()`, which know shuffle, repeat and "previous restarts after 3 s". Without `connect`, Media3 acts on them itself after 8 s. Play, pause and seeking act in Media3 and reach the facade as engine events; a stop pauses.

**When the facade stops** (`status: 'error'`, e.g. a bot check the user must clear), Media3 pauses; when its queue is emptied, Media3 releases the notification.

**Errors.** The plugin rejects with `BAD_REQUEST`, `UNAVAILABLE` or `INTERNAL` (`fxmPlayerErrorCode` reads it). A `load` refused as `BAD_REQUEST` is an `unsupported` stream; an unavailable or failing native player is a `network` failure whose message names it, with the plugin's error as `cause`, and so is a refused `play`. Other refused commands are logged.

**After a page restart.** When the WebView's renderer dies, the app keeps running and Media3 keeps playing; the activity is recreated and the page loads again. The engine stores the facade's queue in Media3 (`saveSnapshot`, at most the 400 items around the current one) whenever it changes, and each entry carries its stream (`data`). A new engine's `connect` reads the session back: it restores the queue at Media3's current item and position, adopts that entry when the facade plays it (answered from the entry's stream, so without a request), keeps Media3's queued entries while it resolves them again, and continues with the queue's next item (shuffle and repeat all included) if Media3 had run out. If the restored queue lost Media3's item (the catalog mode hides it now), the facade's own current item takes over. If the mode hides every stored item (videos restored into Music mode, or the one video kept playing after a switch to Music), the facade could neither show nor stop what Media3 plays: the facade stays as it was, Media3 is released (the notification goes away), and `connect` resolves with `resumed: false`, so the app restores its own queue. Without a snapshot it starts empty, and Media3 plays on under its own controls until the app plays something. This relies on `restoreQueue` keeping every valid stored uid, which `@fxm/core` guarantees.

**No timers.** The engine schedules everything with microtasks and native events, so a page whose timers the browser throttles in the background still answers Media3 at once.

## The plugin

`findFxmPlayerPlugin()` finds `Capacitor.Plugins.FxmPlayer` on a native platform when it has every method, as `findFxmHttpPlugin` does in `@fxm/platform`. The messages are in `plugin.ts`, whose types carry the `FxmPlayer` prefix (`FxmPlayerEntry`, `FxmPlayerSession`, …) like `FxmHttp*` in `@fxm/platform`; the native side documents the same table. Events start only after `attach`, which the engine calls once its listeners are in, and every command waits for it, so they arrive in order. The entry builders (`entries.ts`) are the engine's own and not exported.

## Testing

`createFakeFxmPlayer()` from `@fxm/player/testing` behaves like the native player as far as the engine can tell: it keeps the native playlist, records every call by title (`load:a@0+[b,c]`), and lets the test act as Media3 (`ready`, `progress`, `advance`, `end`, `repeatRound`, `fail`, `stop`, `systemPlay`, `command`, `changeNetwork`, `request`, and a preset `session` for a page that comes back). Like the real coordinator, it sends a failure before the idle state. The tests run the real facade on the engine with a `FakeResolver`, wired as the app does it (through `wrapResolver`):

- `entries.test.ts`: what the notification shows, sources and their file keys, an entry's stream and reading it back, streams the plugin would refuse, the exports;
- `device-files.test.ts`: the WebView URLs of files on the device and back, for the page's origin only, and their `file` sources and streams read back from a session;
- `native-engine.test.ts`: the calls and their order, state and failures (with their HTTP status) into engine events, refused commands by code, what Media3 can play (offline copies included), one engine per plugin, `create`, connecting once, destroying;
- `handover.test.ts`: crossing track boundaries without a pause or a load, several at once, taking over without a request, a queue that changed or ended at the boundary or a later one, pauses and seeks while catching up, a failure of the adopted entry, repeat one, the system's next and previous (also while paused), system plays, a stop, stopping and emptying the queue;
- `native-queue.test.ts`: the native queue's depth and audio limits, its requests' mode, failed resolutions, queue edits and repeat, the facade's preload, refused tails and snapshots sent again, fresh URLs for expiring entries and after a network change, and picking up after a page restart (playing, paused, ran out, repeat all, a failing resolver, a slow one, a lost item, every item hidden by the catalog mode, the app restoring first, no snapshot, reused uids), with the snapshot's trimming.
