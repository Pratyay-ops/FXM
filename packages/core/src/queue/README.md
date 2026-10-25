# The play queue (`@fxm/core`)

A pure, serializable model of what plays now, what played before and what plays next. The player facade in [`@fxm/player`](../../../player/README.md) holds one `QueueState` and replaces it on every action; the queue panel (stage 2.5) and storage read the same object.

- **Plain data.** A `QueueState` survives `JSON.stringify`, and `restoreQueue` reads it back without trusting it.
- **Pure functions.** Every operation takes a state and returns a new one, or the same object when nothing changes (so `next === state` means "no change").
- **No DOM, no clock, no global randomness by default.** Shuffling takes an injectable `RandomSource`; `createSeededRandom(seed)` makes it reproducible.

## The state

| Field | Meaning |
|---|---|
| `items` | `QueueItem`s in play order (the shuffled order while shuffle is on). Each has a `uid` (unique within the queue, so a track can be queued twice), the `track` and, once the playback policy matched one, the chosen `candidate` |
| `index` | The current item, or `-1` when the queue is empty |
| `history` | uids of the items that have been current, oldest first, each once, never the current one |
| `context` | What the queue was started from: `album`, `playlist`, `artist`, `radio` or `search`, with an `id` and a `title` ("Playing from …") |
| `mode` | The catalog mode that decides which tracks may join |
| `repeat` | `off`, `all` or `one` |
| `shuffle`, `unshuffled` | Whether the order is shuffled, and the original order to restore |
| `nextUid` | The uid the next added item gets |

The invariants are listed on `QueueState` and checked after every step of the property-style tests (`queue.property.test.ts`).

## Operations

| Operation | Function | Behaviour |
|---|---|---|
| `setQueue(tracks, startIndex, context)` | `setQueue(state, …, random?)` | Replaces the queue. Hidden tracks are left out; a hidden start track moves the start to the next kept one. Clears the history; repeat, shuffle and mode carry over. With shuffle on, the start track comes first and the rest are shuffled |
| `playNext(tracks)` | `playNext` | Inserts right after the current item (the latest "play next" plays first) |
| `addToQueue(tracks)` | `addToQueue` | Appends to the end |
| `remove(index)` | `removeFromQueue` | Removing the current item makes the following one current (or the preceding one at the end) |
| `move(from, to)` | `moveInQueue` | The current item stays current wherever it ends up |
| `clearUpcoming()` | `clearUpcoming` | Removes everything after the current item |
| `next()` | `skipToNext` | Moves on; after the last item it wraps when repeat is `all` or `one`, and does nothing when it is `off` (`hasNextItem` tells) |
| `previous(positionMs)` | `skipToPrevious` | More than 3 s in (`PREVIOUS_RESTART_MS`), it returns the state unchanged, meaning "restart the current item"; otherwise it goes back one, wrapping to the last item when repeat is on |
| `jump(index)` | `jumpTo` | Makes that item current |
| shuffle | `setShuffle(state, on, random?)` | See below |
| repeat | `setRepeat` | `off`, `all` or `one` |
| mode | `setQueueMode` | See below |
| candidate | `setCandidate(state, uid, candidate?)` | Records the audio the playback policy chose for an item |

Reading: `currentItem`, `upcomingItems`, `nextItem` (what `skipToNext` would play, used for preloading) and `hasNextItem`.

The names in `@fxm/core` say what they act on (`removeFromQueue`, `skipToNext`, …) because the package exports everything from one entry point. The player facade offers the short names: `player.remove(index)`, `player.next()`, `player.play(index)` and so on.

### History and shuffle

`history` exists so that "previous" keeps working when the order changes:

- **Shuffle on:** the items that already played come first, in the order they played, then the current item, then every other item in random order (Fisher-Yates). So "previous" goes back to what actually played, and everything not yet heard, including skipped items, plays before anything repeats.
- **Shuffle off:** the original order comes back, and the current item keeps playing at its original position. Items added while shuffled keep their place: "play next" items follow the item that was current when they were added, and appended items come last. Moving items while shuffled changes only the shuffled order.
- **Repeat all with shuffle** plays the same shuffled order again; turn shuffle off and on for a new one.

### Catalog mode

The queue follows `modePolicy` from `mode.ts`:

- `hidden` tracks never join, whichever operation adds them.
- `needs-song-match` tracks (an official music video in Music mode) stay; the playback policy maps them to their song and stores it with `setCandidate`. A candidate must itself be playable in the queue's mode.
- `setQueueMode` removes the items the new mode hides, except the current one so a mode switch never cuts off what is playing. That item leaves the queue as soon as another one becomes current. Candidates the new mode does not allow are dropped, so those items are matched again.

## Saving and restoring

Save `JSON.stringify(state)`. Read it back with `restoreQueue(json, mode)`, which fails closed: it drops malformed items, duplicate uids and items the mode hides, repairs the history, the original order and the uid counter, drops an invalid context or a malformed candidate (the item stays and is matched again), and returns `null` when the value is not a queue at all. Pass the restored queue to `player.restore(queue, positionMs)`.

## Randomness

- `RandomSource`: a function returning a number in `[0, 1)`, like `Math.random` (the default).
- `fisherYatesShuffle(items, random)`: an unbiased shuffled copy. The tests check that every order and every position is about equally likely.
- `createSeededRandom(seed)`: a small seeded generator (Mulberry32) for reproducible tests and previews. Not for anything that must be unpredictable.
