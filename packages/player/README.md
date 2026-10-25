# @fxm/player

Plays FXM's queue. The app talks to one object, the `Player` facade. The facade drives:

- the queue from `@fxm/core` (see [the queue README](../core/src/queue/README.md));
- an `Engine` that plays one stream at a time;
- a `StreamResolver` that turns a queue item into a stream.

The facade has no DOM code of its own, so the same facade can drive the direct audio engine on web and desktop and a native engine on Android.

| Piece | What it is | Stage |
|---|---|---|
| `Player` | The facade: queue actions, transport, retries, skipping, the circuit breaker, preloading, state and events | 2.2 |
| `Engine` | The engine contract: `load`, `play`, `pause`, `seek`, `setVolume`, `setMuted`, `destroy`, optional `preload`, `canPlay` and `unlock`, and typed events | 2.2 |
| `DirectAudioEngine` | The engine for web and desktop, on two `HTMLAudioElement`s | 2.2 |
| `connectMediaSession` | Lock screen, notification and media keys | 2.2 |
| `StreamResolver` | The resolver contract. The real resolver is the playback policy and stream lifecycle | 2.3 |
| Native engine | A bridge to the Android Media3 player | 6.3 |
| `formatTime`, `mimeTypeOf` | Formatting helpers | 2.2 |

## Using it

```ts
import { connectMediaSession, DirectAudioEngine, Player } from '@fxm/player'

const player = new Player({
  engine: new DirectAudioEngine(),
  resolver, // a StreamResolver (stage 2.3)
  queue: { mode: settings.catalogMode },
})
const disconnect = connectMediaSession(player)

await player.setQueue(album.tracks ?? [], 0, { type: 'album', id: album.id, title: album.name })
const stop = player.subscribe((state) => render(state))
player.on('trackfailed', ({ item }) => toast(`Couldn't play ${item.track.title}`))
```

Every method is safe to call at any time and never throws. The async methods (`setQueue`, `play`, `toggle`, `next`, `previous`) resolve once the action is carried out and never reject. Failures show up in the state and the events.

**Call the transport methods straight from the user's gesture** (a click, a key, a Media Session action), before awaiting anything else. They call `engine.unlock()` before they await the resolver: WebKit (iOS and macOS Safari, iOS PWAs) and Android WebView let `play()` start only a media element that was once played in a gesture.

### Methods

| Method | What it does |
|---|---|
| `setQueue(tracks, startIndex?, context?, { autoplay? })` | Replaces the queue and plays the start track (unless `autoplay: false`) |
| `playNext(tracks)`, `addToQueue(tracks)` | Insert after the current item, or append |
| `remove(index)`, `move(from, to)`, `clearUpcoming()` | Edit the queue. Removing the playing item plays the following one |
| `setShuffle(on)`, `setRepeat(mode)`, `setMode(mode)` | Queue settings. The current track keeps playing |
| `play(index?)` | Resumes, or jumps to `index` and plays it from the start. After an error it tries the current track again. After the end of the queue it plays what was added since, or the last track again |
| `pause()`, `toggle()`, `stop()` | `stop` pauses and rewinds |
| `next()`, `previous()` | Skip, honouring repeat and shuffle. Playback continues if it was playing. If it was paused, the player only selects the track and resolves nothing until play. `previous` restarts the track when more than 3 s in |
| `seek(ms)`, `seekBy(deltaMs)` | Clamped to the track |
| `setVolume(0..1)`, `setMuted(bool)` | Output |
| `restore(queue, positionMs)` | Puts back a saved queue (see `restoreQueue` in `@fxm/core`), paused at that position |
| `getState()`, `subscribe(listener)`, `on(event, listener)` | Reading |
| `destroy()` | Stops everything and destroys the engine |

### State

`getState()` returns an immutable snapshot, which is replaced on every change. That suits `useSyncExternalStore` or a Zustand store.

| Field | Meaning |
|---|---|
| `queue` | The `QueueState`. `currentItem(state.queue)` is the track playing or selected |
| `status` | `idle` (empty queue), `loading`, `playing`, `paused`, `ended` (the queue finished), `error` (playback stopped because tracks failed) |
| `buffering` | Playback waits for data |
| `positionMs`, `durationMs` | Position and duration. The duration comes from the engine, or from the track's metadata until then |
| `volume`, `muted` | Output |
| `stream` | The `StreamOption` playing, for a quality badge |
| `error` | While `status` is `error`: `reason` (`track-failed` or `circuit-open`), the last `error` and the `item` |

A play/pause button shows "pause" while the status is `loading` or `playing`. A spinner shows while it is `loading` or `buffering`.

### Events

| Event | Payload | When |
|---|---|---|
| `trackchange` | `{ item, previous }` | The current item changed |
| `seek` | `{ positionMs }` | A seek, a restart by "previous", or a repeat of the track |
| `trackfailed` | `{ item, error }` | A track failed every retry |
| `circuitopen` | `{ failures }` | Too many tracks failed in a row, so playback stopped |
| `queueend` | none | The last track ended and nothing follows |
| `autoplayblocked` | none | The browser wants a user gesture: show a play button |

## Failures, retries and the circuit breaker

Every failed attempt to play an item counts. That includes:

- an engine `error`;
- a resolver rejection;
- a stream the engine says it cannot play;
- 15 s without audio while playing (a stall).

What happens next:

1. **Retry.** The player asks the resolver again with `reason: 'retry'`, the `attempt` number and the `failure`: the error, the failed stream and the position. Then it resumes at that position. The retries wait 0 s, 1 s and then 3 s.
2. **Skip.** After 3 failed retries the track counts as failed. The player announces `trackfailed` and moves to the next track. If nothing follows, it stops with `error.reason: 'track-failed'`.
3. **Circuit breaker.** After 4 failed tracks in a row the player stops with `error.reason: 'circuit-open'` and announces `circuitopen`. A dead connection, most likely.

Counts reset like this:

- A track that plays for 5 s, or to its end, resets the retry count and the run of failed tracks.
- Any explicit user action (play, next, previous, a new queue) starts both counts over.

`autoplay-blocked` is not a failure. The player pauses, keeps the stream loaded and announces `autoplayblocked`.

**Expiring URLs.** On resume, a loaded stream within 10 minutes of its `expiresAt` is resolved again with `reason: 'refresh'` before playing, at the same position.

All of these are options (`maxRetries`, `retryDelaysMs`, `maxConsecutiveFailures`, `stallTimeoutMs`, `refreshBeforeExpiryMs`), with defaults in `PLAYER_DEFAULTS`.

## Preloading

When the current track has 30 s left (`preloadLeadMs`), the player prepares the next item:

1. It resolves the item with `reason: 'preload'`.
2. It hands the stream to `engine.preload`.
3. It calls the `onPreload(next, upcoming)` hook, so the playback policy can prefetch further ahead.

When that item comes up, the player reuses the resolution, even if it is still in flight, unless the stream is about to expire. The direct audio engine then switches to its preloaded element. A queue edit that changes the next item cancels the preparation. There is no preloading with repeat `one`, when nothing follows, or with `preload: false`.

## The resolver contract

```ts
interface StreamResolver {
  resolve(item: QueueItem, request: ResolveRequest): Promise<ResolvedStream>
}
```

- **`request.reason`:**
  - `play`
  - `preload`
  - `retry` (with `failure`)
  - `refresh` (with an `expired` failure)
- **`request.attempt`:** how many attempts at this item have failed.
- **`request.signal`:** aborts when the player moves on.
- **Return:** `{ stream, candidate? }`. The player records the candidate on the queue item, for example the song a Spotify track or a music video was matched to.
- **Failure:** reject, with an `FxmError` where possible.

The resolver owns everything about where streams come from:

- offline copies, on-device resolution, matching and Smart Replace;
- the URL cache and shared in-flight requests;
- the format choice (`engine.canPlay(stream)` says `probably`, `maybe` or `no`).

## The direct audio engine

`DirectAudioEngine` plays progressive streams with `HTMLAudioElement`:

- **No `crossOrigin`.** googlevideo sends no CORS headers to other sites, so `crossorigin="anonymous"` would break playback. The engine removes the attribute if an element comes with it.
- **No byte fetching.** The engine sets `src` and never reads stream bytes with `fetch` or MediaSource, which the page cannot do for googlevideo. A plain `<audio src>` also follows googlevideo's cross-host redirects, which a CORS read cannot.
- **Two elements, `preload="auto"`.** The second element buffers the stream given to `preload()`. Loading that same stream swaps the elements, so the next track starts without a new download.
- **User gestures.** `unlock()` plays and at once pauses each element that has no source yet, inside the user's gesture, so the browser lets it start later without one. An element the browser refuses stays locked: the engine never preloads into it or swaps to it, and starts new sources on an element that is unlocked. An element also counts as unlocked once its `play()` succeeds. Not yet verified on an iOS device.
- **Autoplay.** A `play()` refused with `NotAllowedError` becomes an `autoplay-blocked` error. `AbortError` (interrupted) and `NotSupportedError` (also reported as an `error` event) are not reported twice.
- **MediaError codes.** `MEDIA_ERR_ABORTED` and `MEDIA_ERR_NETWORK` map to `network`, `MEDIA_ERR_DECODE` to `decode`, and `MEDIA_ERR_SRC_NOT_SUPPORTED` (which is also what a 403 looks like) to `unsupported`. After the stream's `expiresAt`, a network or unsupported failure is reported as `expired`.
- **What it refuses.** Streams that are not progressive (HLS, DASH, SABR), that need request headers (`requestHeaders`; an `<audio>` element cannot send any), that are `capped`, or that have already expired are refused with an error without being loaded.
- **`canPlay(stream)`** answers `probably`, `maybe` or `no`: `canPlayType` for the stream's MIME type (`mimeTypeOf`), `maybe` for a codec and container pair without one, and `no` for a stream it refuses. A muxed video (itag 18) is asked about by its audio track: `<audio>` plays a video file's audio and ignores the picture.
- **No stale events.** Events are checked against the element's state when they arrive, and events of the preloading element are ignored, so nothing from a replaced source reaches the player. Until a load's start position applies, the engine reports no position rather than the 0 it is leaving, and it reports `stalled` only while the element has too little data to play on (browsers also fire it while buffered audio plays).

## Media Session

`connectMediaSession(player, options?)` does the following and returns a `disconnect` function:

- **Metadata:** the title, the artists, the album and every artwork size, each with `sizes` where the source gave one.
- **Playback state:** mirrored from the player's status.
- **Actions:** `play`, `pause`, `previoustrack`, `nexttrack`, `seekto`, `seekbackward` and `seekforward` (10 s unless the system says otherwise), and `stop`.
- **Position:** `setPositionState` is sent at once on a track change, a seek, a status change or a duration change, and otherwise at most once a second while playing.

It does nothing where the browser has no Media Session API. It also skips actions and position updates the browser rejects, and shows the metadata without artwork when the browser rejects an image URL.

## Testing

`@fxm/player/testing` has the fakes the tests use. Later stages can use them too:

- **`FakeEngine`:** records calls, and lets a test drive `progress`, `end`, `fail` and `emit`. `playError` and `startOnPlay` simulate a blocked or silent start, `canPlayStream` what `canPlay` answers. `loadedUrls` and `loadStarts` list what was loaded and where.
- **`FakeResolver`:** answers from a handler and records requests, with `requestsFor(title)`.
- **`testTrack`, `testTracks`, `testStream`:** fixtures. Their URLs use the reserved `.test` domain.

The tests run offline in happy-dom (`vitest.config.ts`) with fake timers, and no real audio plays. They cover:

- queue integration;
- auto-advance, repeat and shuffle through the facade;
- the retry, skip, circuit-breaker, autoplay, stall and expiry flows;
- preloading and overlapping requests;
- the direct audio engine's element handling;
- the Media Session calls.

Coverage of the facade is about 99 % of lines.

See [ARCHITECTURE.md §10](../../docs/ARCHITECTURE.md#10-youtube) for the playback and URL lifecycle rules this package follows.
