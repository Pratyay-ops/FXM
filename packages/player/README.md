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
| `StreamResolver` | The resolver contract | 2.2 |
| `StreamLifecycle` | The real resolver: the playback policy and stream lifecycle ([its README](src/lifecycle/README.md)) | 2.3 |
| `connectSegmentSkipper` | Skips parts of tracks as playback reaches them, such as the non-music parts of videos (see [Skipping segments](#skipping-segments)) | 8.7 |
| `NativeEngine` | The engine for the Android app: Media3 in a foreground service, with a deeper native queue ([its README](src/native/README.md)) | 6.3 |
| `formatTime`, `mimeTypeOf` | Formatting helpers | 2.2 |

## Using it

```ts
import { connectMediaSession, DirectAudioEngine, Player } from '@fxm/player'

const player = new Player({
  engine: new DirectAudioEngine(),
  resolver: lifecycle, // the StreamLifecycle (stage 2.3), attached below
  queue: { mode: settings.catalogMode },
})
lifecycle.attach(player)
const disconnect = connectMediaSession(player)

// In the click handler of an album's play button:
await player.setQueue(album.tracks ?? [], {
  context: { type: 'album', id: album.id, title: album.name },
})
// Its shuffle button: shuffled, from a random track.
await player.setQueue(album.tracks ?? [], { shuffle: true })

const stop = player.subscribe((state) => render(state))
player.on('trackfailed', ({ item }) => toast(`Couldn't play ${item.track.title}`))
```

Every method is safe to call at any time and never throws. The async methods (`setQueue`, `play`, `toggle`, `next`, `previous`) resolve once the action is carried out and never reject. Failures show up in the state and the events.

**Call the transport methods straight from the user's gesture** (a click, a key, a Media Session action), before awaiting anything else. They call `engine.unlock()` before they await the resolver: WebKit (iOS and macOS Safari, iOS PWAs) and Android WebView let `play()` start only a media element that was once played in a gesture.

### Methods

| Method | What it does |
|---|---|
| `setQueue(tracks, { startIndex?, context?, shuffle?, autoplay?, startAtMs? })` | Replaces the queue and plays the start track (unless `autoplay: false`), from `startAtMs`. `shuffle` turns shuffle on or off; shuffled without a `startIndex`, it starts at a random track |
| `playNext(tracks)`, `addToQueue(tracks)` | Insert after the current item, or append |
| `remove(index)`, `move(from, to)`, `clearUpcoming()` | Edit the queue. Removing the playing item plays the following one |
| `setShuffle(on)`, `setRepeat(mode)`, `setCatalogMode(mode)` | Queue settings. The current track keeps playing |
| `setCandidate(uid, candidate?)` | Records the audio for an item, e.g. the version the user picked in "Not the right version?". For the current item the player resolves it (reason `replace`) and carries on at the same position, playing or paused as before. It records the version on that one item and pins nothing: to keep the choice for the track, tell the resolver (`StreamLifecycle.pinMatch`) |
| `play(index?)` | Resumes, or jumps to `index` and plays it from the start. After an error it tries the current track again. After the end of the queue it plays what was added since, or the last track again |
| `pause()`, `toggle()`, `stop()` | `stop` pauses and rewinds |
| `next()`, `previous()` | Skip, honouring repeat and shuffle. Playback continues if it was playing. If it was paused, the player only selects the track and resolves nothing until play. `previous` restarts the track when more than 3 s in |
| `seek(ms)`, `seekBy(deltaMs)` | Clamped to the track |
| `setVolume(0..1)`, `setMuted(bool)` | Output |
| `restore(saved, positionMs)` | Puts back a saved queue, paused at that position. `saved` is untrusted (say JSON from storage): it goes through `restoreQueue` in the player's mode. Returns whether it was a queue |
| `getState()`, `subscribe(listener)`, `on(event, listener)` | Reading |
| `destroy()` | Stops everything and destroys the engine |

### State

`getState()` returns an immutable snapshot, which is replaced on every change. That suits `useSyncExternalStore` or a Zustand store.

| Field | Meaning |
|---|---|
| `queue` | The `QueueState`. `currentQueueItem(state.queue)` is the track playing or selected |
| `status` | `idle` (empty queue), `loading`, `playing`, `paused`, `ended` (the queue finished), `error` (playback stopped because tracks failed) |
| `buffering` | Playback waits for data |
| `positionMs`, `durationMs` | Position and duration. The duration comes from the engine, or from the track's metadata until then |
| `volume`, `muted` | Output |
| `stream` | The `StreamOption` playing, for a quality badge |
| `error` | While `status` is `error`: the `reason`, the last `error` and the `item` (see below) |

A play/pause button shows "pause" while the status is `loading` or `playing`. A spinner shows while it is `loading` or `buffering`.

### Events

| Event | Payload | When |
|---|---|---|
| `trackchange` | `{ item, previous, cause }` | The current item changed. `cause`: `queue` (a new queue, or tracks added to an empty one), `restore`, `next`, `previous`, `jump` (`play(index)`), `ended` (the previous track finished), `failed` (it was skipped after failing) or `removed` |
| `seek` | `{ positionMs, cause }` | The position jumped. `cause`: `user` (a seek or stop), `restart` ("previous" more than 3 s in, or play after the end) or `repeat` (the track ended and plays again) |
| `trackfailed` | `{ item, error }` | The player gave up on a track (see below) |
| `circuitopen` | `{ failures }` | Too many tracks failed in a row, so playback stopped |
| `queueend` | none | The last track ended and nothing follows |
| `autoplayblocked` | none | The browser wants a user gesture: show a play button |
| `preload` | `{ next, upcoming }` | The current track is 30 s from its end: prepare `next`, prefetch more of `upcoming`, top up a radio (see Preloading) |

The causes let listening signals tell a completed track (`ended`, or a seek with `repeat`) from a skip (`next`, `jump`) or a failure.

## Failures, retries and the circuit breaker

These count as a failed attempt to play an item:

- an engine `error`;
- a resolver rejection;
- a stream the engine says it cannot play (`canPlay` says `no`), or a `capped` one;
- 15 s in which playback waits for data (`waiting`, or `stalled` from an engine with nothing left to play) without the position moving on: a stall. A position that keeps moving proves audio plays, whatever the engine said.

What happens next depends on the failure's class. `classifyFailure(error)` decides by default; pass your own as the `classifyFailure` option, e.g. to change one case and fall back to the default:

| Class | Failures (by default) | What the player does |
|---|---|---|
| `retry` | `Network`, `Expired`, `Parse`, `RateLimited`, every `EngineError`, anything that is not an `FxmError` | Retries, then skips |
| `skip` | `NotFound`, `Unavailable`, `GeoBlocked`: the item cannot play anywhere | Announces `trackfailed` and moves on at once |
| `stop` | `Unsupported`, `AuthRequired`, `BotCheck`: nothing plays until the user acts (installs FXM Connect, logs in, proves they are human) | Announces `trackfailed` and stops with `error.reason: 'action-required'` |

**Retry.** The player asks the resolver again with `reason: 'retry'`, the `attempt` number and the `failure`: the error, the failed stream and the position. Then it resumes at that position. The retries wait 0 s, 1 s and then 3 s; a `RateLimited` error waits at least its `retryAfterMs`. After 3 failed retries the track counts as failed: the player announces `trackfailed` and moves to the next track.

**Stopping.** The player stops with status `error` and one of these reasons:

- `track-failed`: there is nowhere to go. The failed track was the last one (repeat off), or the next one already failed in this run of failures, so a repeating queue never goes round again.
- `circuit-open`: 4 tracks in a row failed every retry (`maxConsecutiveFailures`): a dead connection, most likely. Or 10 tracks in a row were given up on, skipped ones included (`maxConsecutiveSkips`), so a queue in which nothing plays is not resolved to its end. It announces `circuitopen`.
- `action-required`: a `stop` failure, see above. `error.error` says which.

**Paused.** Nothing is retried or skipped while paused. A failure while paused (or a pause during a retry's wait) keeps the track, its position and the failure. The next play resolves it again with `reason: 'retry'` and that failure, so a URL cache cannot hand back the failed URL. The same goes for playing a track again after the player stopped on it.

Counts reset like this:

- A track that plays for 5 s, or to its end, resets the retry count and the run of failed tracks, and forgets its failure.
- Any explicit user action (play, next, previous, a new or restored queue) starts the retry count and the run over.

`autoplay-blocked` is not a failure. The player pauses, keeps the stream loaded and announces `autoplayblocked`.

**Expiring URLs.** Before a loaded stream plays again, on resume, on a repeat or on a restart, the player checks its `expiresAt`. Within 10 minutes of it, the player resolves the item again with `reason: 'refresh'` (and an `expired` failure) at the same position.

All of these are options (`maxRetries`, `retryDelaysMs`, `maxConsecutiveFailures`, `maxConsecutiveSkips`, `stallTimeoutMs`, `refreshBeforeExpiryMs`, `classifyFailure`), with defaults in `PLAYER_DEFAULTS`.

## Preloading

When the current track has 30 s left (`preloadLeadMs`), the player prepares the next item:

1. With the `preload` option on (the default), it resolves the item with `reason: 'preload'` and hands the stream to `engine.preload`.
2. Either way it announces the `preload` event with `next` and `upcoming`, once per pair of current and next item. Listen to it to prefetch further ahead (2.3) or to top up a radio (3.4). `upcoming` is the items after the current one in play order and does not wrap around for repeat `all`, so it can be empty while `next` is the first item again.

When that item comes up, the player reuses the resolution, even if it is still in flight, unless the stream is about to expire. The direct audio engine then switches to its preloaded element. A queue edit that changes the next item, or a new candidate for it, cancels the preparation. There is no preloading with repeat `one`, or when nothing else follows.

## The resolver contract

```ts
interface StreamResolver {
  resolve(item: QueueItem, request: ResolveRequest): Promise<ResolvedStream>
}
```

- **`request.reason`:**
  - `play`
  - `preload`
  - `retry` (with `failure`): after a failure, also when the user plays a failed item again
  - `refresh` (with an `expired` failure): the loaded stream expires soon
  - `replace`: the user picked another version, now in `item.candidate`
- **`request.attempt`:** how many attempts at this item have failed: 0 at first, then 1 to 3.
- **`request.failure.started`:** whether the failed stream had started playing, present whenever `failure.stream` is. `false` for a failure before the first `play` event, which in the Lite tier is a failed probe of a capped URL.
- **`request.explicit`:** whether the user asked for this item: a tap (a new queue's start item), a jump, "previous", play on it, or a version pick (`replace`). Reaching it by itself, after the track before ended or failed or after "next", is not explicit, and neither is a `preload`. A Suggest-band match plays only for an explicit request. It holds for the item's retries and refreshes until another item is current.
- **`request.mode`:** the queue's catalog mode.
- **`request.signal`:** aborts when the player moves on.
- **`request.canPlay(stream)`:** how sure the engine is that it can play a stream: `probably`, `maybe` or `no` (also `no` for a `capped` stream). Prefer `probably` (Opus 251 only when the engine says `probably`, otherwise AAC 140), try `maybe`, never return `no`.
- **Which audio:** when `item.candidate` is set, it is the audio to resolve: the match recorded earlier or the user's pick, which always wins. Only a `retry` may replace it (Smart Replace) and must then return the replacement as `candidate`. Without one, the resolver finds the audio: the track's own source, a song matched to a Spotify track, and for a music video in Music mode its song: the one it links (`songForVideo`, verdict `plays-linked-song`) or the one the matching engine finds (`needs-song-match`).
- **Return:** `{ stream, candidate? }`. The player records the candidate on the queue item, so a retry, a repeat or a restored queue resolves the same audio.
- **Failure:** reject with an `FxmError` whose code says what went wrong; the table above says what each code leads to.

The resolver owns everything about where streams come from:

- offline copies, on-device resolution, matching and Smart Replace;
- the URL cache and shared in-flight requests;
- the format choice, with `request.canPlay`.

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

## Skipping segments

`connectSegmentSkipper(player, { segmentsFor })` seeks past parts of a track while it plays. The web app feeds it SponsorBlock's non-music parts of videos (stage 8.7, `@fxm/sources/sponsorblock`), but it takes segments from anywhere: `segmentsFor(item, signal)` answers, for each queue item, the `SkipSegment`s (`startMs`, `endMs`, and optionally `mediaDurationMs`, the duration of the media they were marked on), and decides which items have any at all.

```ts
const skipper = connectSegmentSkipper(player, {
  segmentsFor: async (item, signal) => (skippingOn() ? lookUp(item, signal) : []),
})
skipper.on('skip', ({ item, fromMs, toMs }) => showUndo())
skipper.on('undoexpire', () => hideUndo())
// After the setting changes: skipper.refresh(). For an "Undo" button: skipper.undo().
```

**When it asks.** When an item becomes current, when its audio changes (a new candidate other than its own audio), when the player announces `preload` for the next item (so its segments are ready the moment it starts), and on `refresh()`, which also forgets what it asked for the next item. A request that is no longer needed is aborted, and a rejection counts as "nothing to skip" (`onError` hears of it).

**How it skips.** While a track plays or loads to play, never while paused:

- When playback is inside a segment, it seeks to the segment's end at once. A segment at the start of a track is skipped while the track is still loading, when its segments are known by then, so the engine starts after it.
- When a segment starts within `lookaheadMs` (1 s), a timer skips it right at its start, rather than at the first position report inside it (about every 250 ms from an audio element). It counts the time since the last report only while playback moves: time paused, loading or waiting for data doesn't count, so a resumed track never skips early.
- A segment that runs to the end of the track ends it: the skipper seeks to 100 ms before the end, and the player moves on as at any end, so repeat one plays it again. It waits for the track to play first: a media element started at its very end would restart from the top.

**What it leaves alone:**

- a segment the user moved playback into, at least `seekIntoMs` (1 s) past its start, until the user moves elsewhere or the track starts over. A seek to its very start, such as to the start of the track, still skips it;
- a segment whose skip the user undid (`undo()` goes back to where the skip jumped from), until the track starts over (repeat, or "previous" restarting it);
- the segment a restored queue stopped in: that position is where the user left it.

Its own seeks never count as the user's. `undo()` returns `false` once the track changed or started over, or the user moved playback since the skip; the `undoexpire` event announces that moment for the last skip (and for an undone one), e.g. to take an "Undo" button away. A newer skip replaces the last one without it.

**Which segments apply** (`activeSkipSegments`, also exported): times that aren't finite numbers are dropped, and so are segments whose `mediaDurationMs` differs from the track's duration by more than `durationToleranceMs` (2 s), because they were marked on another cut. The rest are clamped to the track; what is shorter than `minSegmentMs` (1 s) is dropped; segments less than `mergeGapMs` (1 s) apart become one; a last segment ending within `endSnapMs` (1 s) of the end runs to the end. When less than `minPlayedMs` (10 s) of the track would be left, nothing is skipped in it: a track that ends as soon as it starts looks broken, and with repeat one it would loop. The duration is the player's: the engine's, or the track's metadata until then.

It assumes normal playback speed when it times a skip; stage 8.1 (speed) should pass the rate.

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
- **`FakeResolver`:** answers from a handler and records requests, with `requestsFor(title)` and a compact `log` (`a:retry#1`).
- **`testTrack`, `testTracks`, `testStream`:** fixtures. Their URLs use the reserved `.test` domain.
- **The stream lifecycle's fakes** (2.3): `FakeStreamSource`, `FakeMatcher`, `FakeNetworkMonitor` and their fixtures, see [the lifecycle README](src/lifecycle/README.md).
- **`createFakeFxmPlayer`** (6.3): the Android app's `FxmPlayer` plugin, for the native engine, see [its README](src/native/README.md#testing).

The tests run offline in happy-dom (`vitest.config.ts`) with fake timers, and no real audio plays. They cover:

- queue integration;
- auto-advance, repeat and shuffle through the facade;
- the retry, skip, stop, circuit-breaker, autoplay, stall and expiry flows, and failures while paused;
- preloading, choosing another version and overlapping requests;
- the direct audio engine's element handling, including unlocking;
- the Media Session calls;
- the segment skipper: skips at load, on reports and by timer (also after a pause or a wait for data), the user's seeks, undo and when it expires, restarts and repeats, restored queues, the end of the track, asking again and ahead, failures and disconnecting (`segment-skipper.test.ts`).

Coverage of the facade is about 99 % of lines, and of the queue 100 %.

See [ARCHITECTURE.md §10](../../docs/ARCHITECTURE.md#10-youtube) for the playback and URL lifecycle rules this package follows.
