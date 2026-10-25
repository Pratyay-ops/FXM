# The native engine (`@fxm/player`)

`NativeEngine` is the player facade's `Engine` on the Android app's native player (stage 6.3): Media3 in a `mediaPlayback` foreground service, with the media notification and lock-screen controls, through the `FxmPlayer` Capacitor plugin. The native side, and why playback is native on Android, are in [`apps/mobile/android/fxm-player`](../../../../apps/mobile/android/fxm-player/README.md).

## Using it

On Android the app swaps two pieces and connects the engine; nothing else changes:

```ts
import {
  connectMediaSession,
  createBrowserNetworkMonitor,
  DirectAudioEngine,
  NativeEngine,
  Player,
  StreamLifecycle,
} from '@fxm/player'

const engine = NativeEngine.ifAvailable() // the Android app; undefined elsewhere
const lifecycle = new StreamLifecycle({
  ...options,
  // Android's own network callbacks, which keep arriving with the screen off.
  network: engine?.network ?? createBrowserNetworkMonitor(),
})
const player = new Player({ engine: engine ?? new DirectAudioEngine(), resolver: lifecycle })
lifecycle.attach(player)
// The deeper native queue, the system's next and previous, and picking up after a page restart.
await engine?.connect({ player, resolver: lifecycle })
// Not on Android: Media3's session already drives the notification and the lock screen.
if (engine === undefined) connectMediaSession(player)
```

Connect before the app restores or starts a queue of its own: when the page was recreated while Media3 kept playing, `connect` restores the queue and the position from Media3 and carries on.

## How it plays

The facade stays in charge, as with the direct audio engine: it loads each item, retries failures through the stream lifecycle and decides what comes next. The engine maps its calls to the plugin (`load`, `play`, `pause`, `seek`, `setVolume`) and Media3's state back to the engine events (`play`, `pause`, `waiting`, `canplay`, `timeupdate`, `durationchange`, `ended`, `error`). Media3's failures carry their HTTP status (`EngineError` with `cause: { status }`), so `httpStatusOf` reads it and the lifecycle can tell a 403 from an expired URL. Media3 can send request headers, so streams with `requestHeaders` play; it refuses streams that are not progressive or not HTTPS (`canPlay` says `no`).

**Track boundaries.** With `connect`, Media3 holds the next items, resolved, and moves on by itself, gapless. The engine then tells the facade the item ended; the facade moves its queue on and loads the next item, and the engine **adopts** the entry Media3 already plays instead of loading it: no pause, no new request, the position Media3 reached. If Media3 got several items ahead while the page was busy, the facade follows through each in turn. If the facade goes elsewhere (the queue changed at the boundary, it ended, it stopped), Media3 follows it. A pause the facade sends while catching up is its letting go of the item that ended, so Media3 keeps playing until the facade decides; a pause the user made meanwhile is applied when the facade adopts the entry. On repeat one Media3 loops the item itself, and the facade's restart does not seek it back.

**The native queue** (`connect`). The engine resolves the facade's next items through the stream lifecycle, one at a time with `reason: 'preload'` (the request budget's prefetch priority), and queues them in Media3: up to `depth` items (5) or `aheadMs` of audio (40 minutes). It wraps around for repeat all, and a single item on repeat all loops like repeat one. Items that fail to resolve (rate limited, a Suggest-band guess that needs review) end the queue there; the facade meets them in turn and is tried again after the next track. An item keeps its native entry, and its buffer, while a fresh source for it is resolved:

- Media3 asks for one (`request`) when an upcoming URL expires before it would finish, or is bound to an earlier network. For an expiring one the lifecycle gets the old stream as an `expired` failure, so it does not hand the same URL back.
- On a network change the engine's `network` monitor notifies the lifecycle, which drops its cached URLs, and the IP-bound entries are resolved again.
- Queue edits (moves, removals, shuffle, repeat) reach Media3 within the same tick. The facade's own preload fills in an item the engine could not resolve.

**System controls.** The notification's, lock screen's, headset's and Bluetooth's next and previous arrive as `command`s; the engine acknowledges them and calls `player.next()` or `player.previous()`, which know shuffle, repeat and "previous restarts after 3 s". Without `connect`, Media3 acts on them itself after 8 s. Play, pause and seeking act in Media3 and reach the facade as engine events.

**When the facade stops** (`status: 'error'`, e.g. a bot check the user must clear), Media3 pauses; when its queue is emptied, Media3 releases the notification.

**After a page restart.** When the WebView's renderer dies, the app keeps running and Media3 keeps playing; the activity is recreated and the page loads again. The engine stores the facade's queue in Media3 (`saveSnapshot`, at most the 400 items around the current one) whenever it changes. A new engine's `connect` reads the session back: it restores the queue at Media3's current item and position, adopts that entry when the facade plays it (no reload), keeps Media3's queued entries while it resolves them again, and continues with the next item if Media3 had run out. Without a snapshot it starts empty.

**No timers.** The engine schedules everything with microtasks and native events, so a page whose timers the browser throttles in the background still answers Media3 at once.

## The plugin

`findFxmPlayerPlugin()` finds `Capacitor.Plugins.FxmPlayer` on a native platform when it has every method, as `findFxmHttpPlugin` does in `@fxm/platform`. The messages are in `plugin.ts`; the native side documents the same table. Events start only after `attach`, which the engine calls once its listeners are in, and every command waits for it, so they arrive in order.

## Testing

`createFakeFxmPlayer()` from `@fxm/player/testing` behaves like the native player as far as the engine can tell: it keeps the native playlist, records every call by title (`load:a@0+[b,c]`), and lets the test act as Media3 (`ready`, `progress`, `advance`, `end`, `repeatRound`, `fail`, `systemPlay`, `command`, `changeNetwork`, `request`, and a preset `session` for a page that comes back). The tests run the real facade on the engine with a `FakeResolver`:

- `native-engine.test.ts`: the calls and their order, state and failures (with their HTTP status) into engine events, a refused stream, what Media3 can play, destroying;
- `handover.test.ts`: crossing track boundaries without a pause or a load, several at once, a queue that changed or ended at the boundary, a pause while catching up, a failure of the adopted entry, repeat one, the system's next and previous, stopping and emptying the queue;
- `native-queue.test.ts`: the native queue's depth and audio limits, failed resolutions, queue edits and repeat, the facade's preload, fresh URLs for expiring entries and after a network change, and picking up after a page restart (playing, paused, ran out, no snapshot), with the snapshot's trimming.
