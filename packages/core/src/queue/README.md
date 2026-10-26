# The play queue (`@fxm/core`)

A pure, serializable model of what plays now, what played before and what plays next. The player facade in [`@fxm/player`](../../../player/README.md) holds one `QueueState` and replaces it on every action; the queue panel (stage 2.5) and storage read the same object.

- **Plain data.** A `QueueState` survives `JSON.stringify`, and `restoreQueue` reads it back without trusting it.
- **Pure functions.** Every operation takes a state and returns a new one, or the same object when nothing changes (so `next === state` means "no change").
- **No DOM, no clock, no global randomness by default.** Shuffling takes an injectable `RandomSource`; `createSeededRandom(seed)` makes it reproducible.

## The state

| Field | Meaning |
|---|---|
| `items` | `QueueItem`s in play order (the shuffled order while shuffle is on). Each has a `uid`, the `track` and, once the playback policy resolved one or the user picked one, the `candidate` to play |
| `index` | The current item, or `-1` when the queue is empty |
| `playedUids` | uids of the items that have been current, oldest first, each once, never the current one. Only for "previous" and shuffling: the library keeps the listening history |
| `context` | What the queue was started from ("Playing from …"), see below |
| `mode` | The catalog mode that decides which tracks may join |
| `repeat` | `off`, `all` or `one` |
| `shuffle`, `unshuffled` | Whether the order is shuffled, and the original order to restore |
| `nextUid` | The uid the next added item gets |

A `uid` is unique within its queue, so a track can be queued twice. uids are comparable only within one queue and the queues this module derives from it: `createQueue` and `restoreQueue` number from 0 again.

The invariants are listed on `QueueState` and checked after every step of the property-style tests (`queue.property.test.ts`).

### Contexts

`QueueContext` has one shape per type, so the link back is typed:

| `type` | Link | Example |
|---|---|---|
| `album`, `playlist`, `artist` | `id`: the entity's `EntityId` | `{ type: 'album', id: album.id, title: album.name }` |
| `radio` | `seed`: the track or artist ID the station started from | `{ type: 'radio', seed: track.id, title: 'Radio' }` |
| `search` | `query` | `{ type: 'search', query, title: query }` |
| `library` | `id`: the library's own key for a list without a catalog ID (Liked songs, Downloads, a playlist made in FXM, local files) | `{ type: 'library', id: 'liked', title: 'Liked songs' }` |

## Operations

The names say what they act on because `@fxm/core` exports everything from one entry point. The player facade offers the short names: `player.remove(index)`, `player.next()`, `player.play(index)` and so on.

| Operation | Function | Behaviour |
|---|---|---|
| `setQueue(tracks, { startIndex, context, shuffle })` | `setQueue(state, tracks, options?)` | Replaces the queue. Hidden tracks are left out; a hidden start track moves the start to the next kept one. Clears the played items; repeat and mode carry over, and so does shuffle unless `shuffle` sets it. Shuffled, the start track comes first and the rest are shuffled; without a `startIndex` the start is random |
| `playNext(tracks)` | `playNext` | Inserts right after the current item (the latest "play next" plays first) |
| `addToQueue(tracks)` | `addToQueue` | Appends to the end |
| `remove(index)` | `removeFromQueue` | Removing the current item makes the following one current (or the preceding one at the end) |
| `move(from, to)` | `moveInQueue` | The current item stays current wherever it ends up |
| `clearUpcoming()` | `clearUpcoming` | Removes everything after the current item |
| `next()` | `skipToNext` | Moves on; after the last item it wraps when repeat is `all` or `one`, and does nothing when it is `off` (`hasNextQueueItem` tells) |
| `previous(positionMs)` | `skipToPrevious` | More than 3 s in (`PREVIOUS_RESTART_MS`), it returns the state unchanged, meaning "restart the current item"; otherwise it goes back one, wrapping to the last item when repeat is on |
| `jump(index)` | `jumpInQueue` | Makes that item current. While shuffled it first moves the item to just after the current one, see below |
| shuffle | `setQueueShuffle(state, on, random?)` | See below |
| repeat | `setQueueRepeat` | `off`, `all` or `one` |
| mode | `setQueueMode` | See below |
| candidate | `setQueueCandidate(state, uid, candidate?)` | Records the audio for an item: what the playback policy resolved, or the version the user picked |

Reading: `currentQueueItem`, `upcomingQueueItems` (the items after the current one; it does not wrap around for repeat `all`), `nextQueueItem` (what `skipToNext` would play, used for preloading) and `hasNextQueueItem`.

### Played items and shuffle

`playedUids` exists so that "previous" keeps working when the order changes:

- **Shuffle on:** the items that already played come first, in the order they played, then the current item, then every other item in random order (Fisher-Yates). So "previous" goes back to what actually played, and everything not yet heard, including skipped items, plays before anything repeats.
- **Jumping while shuffled** moves the chosen item to just after the current one before making it current. The items before the current one are still the ones that played, so "previous" goes back to the item that was playing, and the items jumped over still play later. Without shuffle a jump keeps the order, as in an album: "previous" goes to the item before.
- **Shuffle off:** the original order comes back, and the current item keeps playing at its original position. Items added while shuffled keep their place: "play next" items follow the item that was current when they were added, and appended items come last. Moving items while shuffled changes only the shuffled order.
- **A new shuffled queue** starts at the chosen track, or at a random one without a `startIndex` (a shuffle button on an album page).
- **Repeat all with shuffle** plays the same shuffled order again; turn shuffle off and on for a new one.

### Catalog mode

The queue follows `modePolicy` from `mode.ts`:

- `hidden` tracks never join, whichever operation adds them.
- Items that play another track in Music mode stay: an official music video that links its song (`plays-linked-song`) and one without a link (`needs-song-match`). The playback policy plays the linked song (`songForVideo`) or the song the matching engine finds, and stores it with `setQueueCandidate`. A candidate must itself be playable in the queue's mode.
- `setQueueMode` removes the items the new mode hides, except the current one so a mode switch never cuts off what is playing. That item leaves the queue as soon as another one becomes current. Candidates the new mode does not allow are dropped, so those items are matched again.

## Saving and restoring

Save `JSON.stringify(state)`. Read it back with `restoreQueue(json, mode)`, which fails closed and copies only the fields FXM knows:

- It drops malformed items, duplicate uids and items the mode hides.
- A malformed optional field of a track (say a non-boolean `explicit`) is dropped on its own, and so is a malformed candidate: the item stays and is matched again.
- It repairs the played items, the original order and the uid counter, and drops an invalid context.
- It returns `null` when the value is not a queue at all.

`player.restore(json, positionMs)` runs `restoreQueue` itself, in the player's mode.

The cleaners it uses are exported for other stores of the same shapes, such as the library's backups: `cleanTrack`, `cleanCandidate`, `cleanSignals` and `cleanContext` each return a clean copy with only the known fields, or `undefined`.

## Randomness

- `RandomSource`: a function returning a number in `[0, 1)`, like `Math.random` (the default).
- `fisherYatesShuffle(items, random)`: an unbiased shuffled copy. The tests check that every order and every position is about equally likely.
- `createSeededRandom(seed)`: a small seeded generator (Mulberry32) for reproducible tests and previews. Not for anything that must be unpredictable.
