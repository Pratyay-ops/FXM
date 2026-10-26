# Listening signals and affinity (`@fxm/core`)

What the user does with music, and what FXM learns from it: an on-device, time-decayed affinity for every track, artist and tag. The recommendation engine (stage 3.3) and endless radio (3.4) rank with it; nothing leaves the device.

- **Pure.** No DOM, no storage and no clock of its own: every function takes the time it needs, and `AffinityIndex` takes an injectable clock (`now`), so tests run on fake clocks.
- **Incremental.** A signal changes only the few entries it touches (its track, artists and tags), in O(1) each. Nothing is recomputed from the whole history, and signals may arrive in any order, e.g. a listening history imported years later.
- **Fail closed.** A malformed signal (a time that is not a number, an invalid track ID) contributes nothing, and neither does one dated after the clock it is checked against.

The web app keeps the same entries on disk, next to the library, and updates them in the same transaction as every play, like, playlist change and change of a track's metadata: see [apps/web/src/db/README.md](../../../../apps/web/src/db/README.md#listening-signals-and-affinity).

## Signals

`ListeningSignal` is one of:

| `type` | When | Fields |
|---|---|---|
| `play` | A play ended: it reached the end, the user moved on, or it stopped | `playedMs` (listening time, without pauses or skipped parts), `durationMs?`, `completed`, `skipped`, `context?` (`PlayContext`), `stream?` (`PlayStream`) |
| `like` | The user liked the track | |
| `unlike` | The user took a like back | `likedAt`: when that like was made |
| `playlist-add` | The track joined a playlist of the library, Downloads included | `playlistId` |
| `playlist-remove` | The track left a playlist, or the playlist was deleted | `playlistId`, `addedAt`: when it was added |

Every signal has `at` (epoch milliseconds; a play's start) and `track`, a `ListeningSignalTrack`: the track's ID, title, artists and tags, and when known its `kind` and a music video's `songId`. A whole `Track` has all of them.

A play is `completed` when it played to the end and most of it was heard, and `skipped` when the user moved on before the end (next, another queue item) or sought to it. Neither means it stopped for another reason: the user went back, started something else, closed the app, the track failed or the stream ended early.

`playContextOf(queue.context)` gives the stored form of where a play started (`type`, `id`: the entity ID, a radio's seed, a search's query or a library key, and `title`), and `playStreamOf(item, stream)` what played: the audio source, the matched song's ID when the audio is another track, and the codec, container, bitrate, tier and media.

### Times never lie ahead

A signal's times (`at`, and a take-back's `likedAt` or `addedAt`) must never be later than the clock of whatever keeps the affinity. Merging decays everything to the later of two times, so an entry dated a year ahead would make every real contribution count next to nothing for a year, and its rank would put it on top of every list. `affinityContributions(signal, { now })` refuses such signals, and `AffinityIndex` always passes its clock. `isSignalTime` checks that a value can be a time at all (`0` to `MAX_SIGNAL_TIME`, the largest valid `Date`).

## Affinity

Every signal contributes a weight `w` at a time `t` (`affinityContributions`). An entry's affinity at `now` is the sum of its contributions, each halved for every half-life since it was made:

```
affinity(now) = Σ w · 2^(−(now − t) / halfLife)      halfLife = 14 days (AFFINITY_HALF_LIFE_MS)
```

| Signal | Affinity | Skips |
|---|---|---|
| `play` | `play` (1) × the share played | if skipped: `skip` (1) × the share left unplayed |
| `like` | `like` (3) | |
| `unlike` | `−like` at `likedAt` | |
| `playlist-add` | `playlistAdd` (2) | |
| `playlist-remove` | `−playlistAdd` at `addedAt` | |

- **The share played** is `playedMs / durationMs`, at most 1 (`playedShare`). Without a duration, as in an imported history, it is measured against 3.5 minutes (`ASSUMED_TRACK_MS`). A completed play counts as all of it unless its known length shows it played less than half (`COMPLETED_PLAY_SHARE`): seeking to the end is no listen. So a skip after 10 s of a 200 s song adds 0.05 to the affinity and 0.95 to the skips, and a skip during the outro counts almost as a full play.
- **Skips are kept apart**, in their own decayed channel, so the ranking (stage 3.3: `affinity + similarity + popularity + novelty − skip penalty − recently-played penalty`) can weigh them as a penalty of their own.
- **Taking back is exact.** An unlike contributes `−like` at the time of the like, and a removal `−playlistAdd` at the time of the add, so they cancel what was added exactly, however long ago it was. For the artists and tags this holds as long as the take-back credits the same ones as what it takes back: see [metadata that changes](#metadata-that-changes).
- **Plays** are also counted without decay (`plays`), with the last play's start (`lastPlayedAt`), for the recently-played penalty and for Rediscover.

### Credits: artists and tags

`affinityCredits(track)` says which artists and tags every signal of a track credits, and with what share of its weight:

- **Artists.** The first credited artist gets the whole weight and each further one half (`featuredArtist`), at most 8. Placeholders such as "Various Artists" and "Unknown Artist" get nothing. Each entry remembers the artist's IDs in every source it came with (`ids`).
- **Tags** come from `Track.tags`: genres, styles and moods, when the source has them; never version tags such as "Live" or "Remix". Each gets the whole weight, at most 10.
- **Plain videos and podcast episodes credit nobody.** In Music + Video mode a plain YouTube video names its uploader's channel as the artist, and a vlog channel is no artist to recommend from, so `video` and `episode` tracks count for themselves only. Songs, music videos and tracks of unknown kind (imported histories) credit their artists.

### Keys

| Kind | Key | So that |
|---|---|---|
| `track` | `trackAffinityKey(id)`: the `entityKey` | a video's `ytm` and `yt` IDs share an entry |
| `artist` | `artistAffinityKey(name)`: `artistKey`, without placeholders and absurdly long names | one artist across sources, and in imports that have no IDs, is one entry |
| `tag` | `tagAffinityKey(tag)`: normalized, runs of spaces, `-`, `_` and `/` made one space | "Hip-Hop", "hip hop" and "HIP_HOP" are one |

**`artistKey` is the artist key for all of FXM**: the name as `normalizeText` compares it, without bracketed parts and YouTube's channel decorations (" - Topic", "VEVO", "Official"), with `&` read as "and" and without punctuation. "Radiohead", "Radiohead - Topic" and "RadioheadVEVO" are one artist, and so are "Simon & Garfunkel" and "Simon and Garfunkel". These are the matching engine's `cleanArtistName` rules followed by the recommendation sources' comparison, so the recommendations (3.2, 3.3) can join their candidates to the affinity by it.

Every key function gives its own keys back unchanged, and `affinityKey(kind, value)` picks the right one, so readers take a track ID, a name or a tag as readily as a key. `affinityEntryId(kind, key)` is the ID a store keeps an entry under (`artist|radiohead`).

### Entries

An `AffinityEntry` holds `kind` (`track`, `artist` or `tag`), `key`, `label` (the title, name or tag as last spelled), `ids`, `plays`, `lastPlayedAt`, and `score` and `skips` **as of its own time `at`**. `affinityAt(entry, now)` decays both to `now` (never growing them for a time before `at`), and `affinityScoreAt` gives an `AffinityScore`; `compareAffinityScores` orders scores best first, ties by kind and key.

A track entry's `ids` are the track's own ID, plus the audio a play actually played when it was another track (a Spotify track playing its YouTube match) and the song a music video links. One song can therefore have two track entries, one per source it was played from; **stage 3.3 folds entries that share an ID** before it ranks tracks.

`mergeAffinity(a, b)` combines two entries of the same key: each is decayed to the later of their two times and added up. Merging is associative and, but for the label at equal times, commutative, so contributions can be merged in any order or grouping with the same result. Sums are exact, so changes that take skips or plays away can be merged with each other first. A store therefore keeps one entry per key and merges every new contribution into it. `isEmptyAffinity` tells when an entry holds nothing at all (a like of a never-played track, taken back), so the store can drop it.

**An entry means something only under the half-life and weights that built it.** `AFFINITY_MODEL_VERSION` names the model (half-life, weights, keys and credits) and goes up with every change to them; a store records the version it built its entries with and rebuilds when it differs. The free functions take a half-life and refuse one that is not a positive number.

### Metadata that changes

A track's metadata changes: search, an album page and the watch page of YouTube Music credit different artists for one video, and tags arrive later from another source. A store that scores each signal with the metadata of the moment would then take a like back from artists and tags it never gave to, and leave the ones it did.

So a store scores every signal of a track with the track's **current** metadata, and when that metadata changes, `reattributeAffinity(trackEntry, oldCredits, newCredits)` moves what the track holds to the new credits. It works because a track entry holds the sum of everything its signals contributed, and every signal gives each of its artists and tags the same share of it: moving `share × trackEntry` from each old credit to each new one leaves the artist and tag entries exactly as if every signal had credited the new metadata from the start. Only `lastPlayedAt`, which never moves back, and `ids` remember the old credits. Take-backs then cancel exactly, and a rebuild from the library gives the same numbers.

### Ranking without decaying

Every entry decays at the same rate, so time alone never changes their order. `affinityRank(entry)` = `log2(score) + at / halfLife` orders entries by their affinity at any time from their own on (`-Infinity` without a positive score). A store can index it and read the top entries straight from the index, without decaying anything first.

## Reading: `AffinityReader`

The recommendations read the affinity through one interface, whatever keeps it:

```ts
interface AffinityReader {
  top(kind, { limit?, now? }): Promise<AffinityScore[]>          // best first, positive only
  scores(kind, values, { now? }): Promise<(AffinityScore | undefined)[]>  // IDs, names, tags or keys
}
```

The web library's repository has one (`repo.affinity`), and so does an `AffinityIndex` (`index.reader()`), so stage 3.3 can test its engine on an index.

## In memory: `AffinityIndex`

```ts
const affinity = new AffinityIndex({ now: () => clock }) // also halfLifeMs, weights
affinity.add(signals)                     // one or many, in any order; none dated after the clock
affinity.top('artist', { limit: 10 })     // [{ entry, score, skips }], best first, ties by key
affinity.score('artist', 'Radiohead')     // one entry's affinity now, by name, ID, tag or key
affinity.merge(storedEntries)             // a snapshot, or the changes of reattributeAffinity
affinity.reader()                         // the index as an AffinityReader
```

An entry merged in that is dated after the clock counts as dated now, which is how it reads anyway.

## Tests

`affinity.property.test.ts` replays random six-month histories of plays, skips, likes, unlikes, adds and removals in order, shuffled, and split into batches merged afterwards, and checks every entry against the formula above, computed from scratch. It also checks that the rank orders entries like their affinity at later times, that taking back every like and add leaves exactly the plays, and that a history during which the tracks' metadata keeps changing ends exactly where scoring every signal with the final metadata puts it. Everything runs on fixed times.
