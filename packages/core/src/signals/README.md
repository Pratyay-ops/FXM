# Listening signals and affinity (`@fxm/core`)

What the user does with music, and what FXM learns from it: an on-device, time-decayed affinity for every track, artist and tag. The recommendation engine (stage 3.3) and endless radio (3.4) rank with it; nothing leaves the device.

- **Pure.** No DOM, no storage and no clock of its own: every function takes the time it needs, and `AffinityIndex` takes an injectable clock (`now`), so tests run on fake clocks.
- **Incremental.** A signal changes only the few entries it touches (its track, artists and tags), in O(1) each. Nothing is recomputed from the whole history, and signals may arrive in any order, e.g. a listening history imported years later.
- **Fail closed.** A malformed signal (a time that is not a number, an invalid track ID) contributes nothing, so bad data never poisons an entry.

The web app keeps the same entries on disk, next to the library, and updates them in the same transaction as every play, like and playlist change: see [apps/web/src/db/README.md](../../../../apps/web/src/db/README.md#listening-signals-and-affinity).

## Signals

`ListeningSignal` is one of:

| `type` | When | Fields |
|---|---|---|
| `play` | A play ended: it reached the end, the user moved on, or it stopped | `playedMs` (listening time, without pauses or skipped parts), `durationMs?`, `completed`, `skipped`, `context?` (`PlayContext`), `stream?` (`PlayStream`) |
| `like` | The user liked the track | |
| `unlike` | The user took a like back | `likedAt`: when that like was made |
| `playlist-add` | The track joined a playlist of the library, Downloads included | `playlistId` |
| `playlist-remove` | The track left a playlist, or the playlist was deleted | `playlistId`, `addedAt`: when it was added |

Every signal has `at` (epoch milliseconds; a play's start) and `track`, a `SignalTrack`: the track's ID, title, artists and tags, which a whole `Track` has.

A play is `completed` when it played to the end, and `skipped` when the user moved on before the end (next, or another queue item). Neither means it stopped for another reason: the user went back, started something else, closed the app, or the track failed.

`playContextOf(queue.context)` gives the stored form of where a play started (`type`, `id`: the entity ID, a radio's seed, a search's query or a library key, and `title`), and `playStreamOf(item, stream)` what played: the audio source, the matched song's ID when the audio is another track, and the codec, container, bitrate, tier and media.

## Affinity

Every signal contributes a weight `w` at a time `t` (`signalContributions`). An entry's affinity at `now` is the sum of its contributions, each halved for every half-life since it was made:

```
affinity(now) = Σ w · 2^(−(now − t) / halfLife)      halfLife = 14 days (AFFINITY_HALF_LIFE_MS)
```

| Signal | Affinity | Skips |
|---|---|---|
| `play` | `play` (1) × the share played; all of it when completed | if skipped: `skip` (1) × the share left unplayed |
| `like` | `like` (3) | |
| `unlike` | `−like` at `likedAt` | |
| `playlist-add` | `playlistAdd` (2) | |
| `playlist-remove` | `−playlistAdd` at `addedAt` | |

- **The share played** is `playedMs / durationMs`, at most 1 (`playedShare`). Without a duration, as in an imported history, it is measured against 3.5 minutes (`ASSUMED_TRACK_MS`). So a skip after 10 s of a 200 s song adds 0.05 to the affinity and 0.95 to the skips, and a skip during the outro counts almost as a full play.
- **Skips are kept apart**, in their own decayed channel, so the ranking (stage 3.3: `affinity + similarity + popularity + novelty − skip penalty − recently-played penalty`) can weigh them as a penalty of their own.
- **Taking back is exact.** An unlike contributes `−like` at the time of the like, and a removal `−playlistAdd` at the time of the add, so they cancel what was added exactly: the entry ends as if the like or add never happened, however long ago it was.
- **Artists.** The track's first credited artist gets the whole weight and each further one half (`featuredArtist`), at most 8. Artists are keyed by name (`artistAffinityKey`: `normalizeText`, so "Beyoncé" and "BEYONCE" are one, also across sources and in imports that have no IDs). Placeholders such as "Various Artists" and "Unknown Artist" get nothing. Each entry remembers the artist's IDs in every source it came with (`ids`).
- **Tags** come from `Track.tags` (genres and styles, when the source has them). Each gets the whole weight, at most 10, keyed by `tagAffinityKey` ("Hip-Hop", "hip hop" and "HIP_HOP" are one).
- **Tracks** are keyed by `entityKey`, so a video's `ytm` and `yt` IDs share an entry.
- **Plays** are also counted without decay (`plays`), with the last play's start (`lastPlayedAt`), for the recently-played penalty and for Rediscover.

The weights are `DEFAULT_AFFINITY_WEIGHTS`; `AffinityIndex` and `signalContributions` take others.

### Entries

An `AffinityEntry` holds `kind` (`track`, `artist` or `tag`), `key`, `label` (the title, name or tag as last spelled), `ids`, `plays`, `lastPlayedAt`, and `score` and `skips` **as of its own time `at`**. `affinityAt(entry, now)` decays both to `now` (never growing them for a time before `at`).

`mergeAffinity(a, b)` combines two entries of the same key: each is decayed to the later of their two times and added up. Merging is associative and, but for the label at equal times, commutative, so contributions can be merged in any order or grouping with the same result. A store therefore keeps one entry per key and merges every new contribution into it. `isEmptyAffinity` tells when an entry holds nothing at all (a like of a never-played track, taken back), so the store can drop it.

### Ranking without decaying

Every entry decays at the same rate, so time alone never changes their order. `affinityRank(entry)` = `log2(score) + at / halfLife` orders entries by their affinity at any time (`-Infinity` without a positive score). A store can index it and read the top entries straight from the index, without decaying anything first.

## In memory: `AffinityIndex`

```ts
const affinity = new AffinityIndex({ now: () => clock }) // also halfLifeMs, weights
affinity.add(signals)                     // one or many, in any order
affinity.top('artist', { limit: 10 })     // [{ entry, score, skips }], best first, ties by key
affinity.score('track', entityKey(id))    // one entry's affinity now
affinity.merge(storedEntries)             // a snapshot read back from storage
```

## Tests

`affinity.property.test.ts` replays random six-month histories of plays, skips, likes, unlikes, adds and removals in order, shuffled, and split into batches merged afterwards, and checks every entry against the formula above, computed from scratch. It also checks that the rank orders entries like their affinity at later times, and that taking back every like and add leaves exactly the plays. Everything runs on fixed times.
