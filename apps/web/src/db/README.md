# The library database

FXM keeps the library on the device, in IndexedDB, through [Dexie](https://dexie.org) 4: a database named `fxm`. Nothing here leaves the device except in a backup file the user saves.

| File | What it holds |
|---|---|
| `types.ts` | One record type per table, the IDs of the built-in playlists, the match-cache and import vocabulary |
| `database.ts` | The versioned schema, the migrations and `openDatabase()` |
| `repo.ts` | The repository: **the only code that reads or writes the tables** |
| `hooks.ts` | React hooks that run the repository's reads as live queries |
| `ordering.ts` | Pure functions over saved orders: moves and reconciling. Shuffle order uses `fisherYatesShuffle` from `@fxm/core` with an injectable random source |
| `match-cache.ts` | Pure rules of the match cache: keys, confirmation, expiry, pins |
| `affinity.ts` | The listening affinity on disk (stage 3.1): merging signals into it, rebuilding it from the library, reading the top entries |
| `validate.ts` | Guards that clean records from outside the app (backups, later imports) |
| `backup.ts` | JSON backup export and import |

Pages read through `hooks.ts` and write through `getLibrary()` (the app's repository). Tests make their own repository on a database of their own with `testRepo()` from `src/test/library-fixtures.ts`, or reset the app's with `resetLibrary()`, which the test setup does after every test.

## Tables

| Table | Key | Holds |
|---|---|---|
| `tracks` | the track's `EntityId` | The core `Track` JSON every list shows, and when it was saved |
| `likes` | `entityKey(trackId)` | Which tracks are liked, and when (`likedAt`) |
| `playlists` | `local:playlist:<uuid>`, or a built-in ID | Name, description, artwork, dates, the **ordered track IDs**, when each was added, and the undo order |
| `orders` | `playlists` | The order of the list of playlists, and its undo order |
| `follows` | `entityKey(id)` | Followed artists, saved albums and followed playlists, with what lists show of them |
| `history` | auto-increment | One row per play: track, start, time played, the track's length, completed, skipped, context, stream, and the import it came from |
| `settings` | setting name | Reserved: the app's settings stay in `localStorage` for now |
| `matchCache` | `<entityKey(sourceTrackId)>\|<mode>` | The matching engine's decision for a source track in a catalog mode (below) |
| `importProgress` | a random ID | How far an import got, so it can resume (stage 3.6). Its `state` is the import's progress, an `ImportState` of `@fxm/sources/import`: the rows, a decision per row and what was looked up |
| `affinity` | `<kind>\|<key>` | The listening affinity of every track, artist and tag (below), indexed by `[kind+rank]` |

`ytm` and `yt` IDs of one video share an `entityKey`, so a like, a follow or a playlist entry counts once whichever prefix a provider used.

**Built-in playlists.** Every library has *Liked songs* (`local:playlist:liked`) and *Downloads* (`local:playlist:downloads`). The database recreates them whenever it opens without them. Neither can be renamed or deleted, and both support every ordering feature.

- Liked songs: the `likes` table says which tracks are liked and when; the playlist record holds their custom order. New likes go to the top. Reads reconcile the two, so the order heals itself if they ever disagree.
- Downloads: only the download manager (stage 4.1) changes it, through `addDownload()` (to the top) and `removeDownload()`. `addTracks()` and `removeTracks()` refuse it.

## Saved orders

Every playlist, Liked songs and Downloads included, and the list of playlists itself, keeps a custom order: **an array of IDs inside one record**. A move, a shuffle, a saved sort or an undo reads the record, computes the new array with `ordering.ts` and writes the record back, in one transaction.

Why an array rather than one row per entry with a fractional rank:

- **Every change is one write of one record.** Moving one song and shuffling 5,000 cost the same: one `put`. With ranks, a shuffle or a saved sort rewrites every row, and a multi-select move rewrites one row per song.
- **It stays small.** 1,000 IDs are about 30–40 KB, which IndexedDB writes in a few milliseconds. Reading a playlist is one `get` plus one `bulkGet` of its tracks.
- **No rank maintenance.** Fractional ranks run out of precision after many moves between the same neighbours and need rebalancing passes; arrays never do.
- **Backups carry the order as it is**, and merging two orders is a plain union.
- The cost is that two tabs editing the same order at the same moment would keep the later write. Each change happens inside a transaction that reads the current order first, and the other tab updates within a frame through its live query, so in practice nothing is lost.

`repo.test.ts` checks that moving half of a 2,000-song playlist is a single write. In the browser, with a production build, a 1,500-song playlist renders in about 0.3 s, a move from the menu shows in about 0.1 s, Shuffle order in about 0.4 s, and picking a song up for a keyboard drag takes about 0.6 s (Chromium, measured while other jobs loaded the machine).

**Undo.** Shuffle order and "Save as custom order" keep the previous order in the record (`undo`), until any other change of that order clears it. Renaming a playlist doesn't.

## Reactivity: live queries

Reads go through `useLiveQuery` from dexie-react-hooks (`hooks.ts`), not TanStack Query. The library is local data written from many places: the player bar's like button, the sidebar, the Library page, the download manager later, and other tabs. A live query re-runs exactly the reads that a write touched, in every open tab (Dexie broadcasts changes between tabs), with no cache keys to invalidate by hand. TanStack Query stays for data from the network. A read that fails (IndexedDB blocked in a private window, a full disk) comes back as an error state, so the shell keeps working.

## Versions and migrations

| Version | Changes |
|---|---|
| 1 | The library as stage 2.6 first specified it: track cache, likes, playlists with their order, the order of the playlists list, follows, history, reserved settings, and a match cache with one decision per source track |
| 2 | What the research memo of 2026-10-25 (section 11.3) added: the match cache keyed by source track **and catalog mode**, with signals, evidence and user pins; and `importProgress`. The upgrade rewrites version 1 decisions: a decision whose audio is a song becomes a Music decision, one whose audio is a video a Music + Video decision, and a user override becomes a pin |
| 3 | The listening affinity of stage 3.1: the `affinity` table. The upgrade computes it from the history, the likes and the playlists |

No release shipped version 1 on its own; keeping it declared means the upgrade path is tested from the first release on.

To change the schema:

1. Add `db.version(n + 1).stores({...})` in `database.ts` with only the tables that change. An index is added or removed by listing the table's new index string; a table is deleted with `null`.
2. When existing records need rewriting, add `.upgrade(tx => …)`. Dexie can't change a table's primary key: keep the key path and rewrite the records (as version 2 does), or move the data to a new table.
3. Never edit a version that has shipped: browsers that already have it would never run the change.
4. Bump `SCHEMA_VERSION`, add the new record shapes to `validate.ts` and the backup, and add a case to `database.test.ts` that opens a database written by the previous version.

## Match cache

The matching engine (stage 1.7) and the playback policy (stage 2.3) use it through the repository:

- `recordMatch(decision)` stores the engine's decision for a **source** track (for example a Spotify track) in one catalog mode: the band (`auto`, `suggest` or `none`), the best candidate, the alternatives, the signals and the evidence.
- `getConfirmedMatch()` returns audio that may play without asking: a pin, or an `auto` decision. **A `suggest` guess is never confirmed**; `getMatch()` returns it for the version switcher.
- `pinMatch()` stores the user's choice ("Not the right version?"). **A pin always wins**: later engine decisions for that track and mode are dropped, and nothing deletes a pin automatically. `unpinMatch()` is the only way to remove one.
- Engine decisions expire after about 30 days (`MATCH_TTL_MS`): reads ignore them and `pruneMatchCache()` deletes them. `forgetMatch()` drops one early, for Smart Replace, but never a pin.

## Listening signals and affinity

Stage 3.1 scores every track, artist and tag by what the user does with them: the time-decayed affinity of [`@fxm/core`'s signals](../../../../packages/core/src/signals/README.md) (half-life 14 days), which the recommendations (stages 3.3 and 3.4) rank with.

**Where the signals live.** Nothing is stored twice:

| Signal | Stored as |
|---|---|
| A play | A `history` row: start, time played, the track's length, completed, skipped, context, stream |
| A like | A `likes` row, with `likedAt` |
| A playlist add | The track in the playlist, with its `addedAt` (Downloads counts like any playlist; Liked songs' entries are the likes) |

**The `affinity` table** holds one record per track (`entityKey`), artist (name, so one artist across sources is one record) and tag. Each is a core `AffinityEntry`: the affinity and the skips as of its own time `at`, the plays and the last play, plus `rank`, which orders a kind's records by their affinity at any time.

- **Kept up to date with every change.** The repository merges each change's signal in the same transaction as the change: `recordPlay`, `like`, `unlike`, `toggleLike`, `createPlaylist`, `addTracks`, `removeTracks`, `duplicatePlaylist`, `deletePlaylist`, `addDownload` and `removeDownload`. Taking something back cancels it exactly: an unlike takes back what its like added, a removal (or a deleted playlist) what its add did. Each write touches one record per track, artist and tag, however many signals it carries.
- **Rebuilt when that is simpler.** `rebuildAffinity()` recomputes it from the history, the likes and the playlists: `clearHistory()` does (so recommendations forget the plays, and likes and playlists keep theirs), so does every backup import, and so does the version 3 upgrade. The table is derived, so backups leave it out.
- **Metadata.** Each change counts with the track's artists and tags as cached at that moment. When they change later (say tags arrive from another source), the old changes keep their old metadata until the next rebuild; `rebuildAffinity()` brings them in line.
- **Reads.** `topAffinity(kind, limit)` reads the best entries straight off the `[kind+rank]` index, with their affinity and skips now; `getAffinity(kind, keys)` reads given entries.
- **Changing the weights or the half-life** needs a new schema version whose upgrade rebuilds the table, like version 3's.

**The event API for plays.** `recordPlays(plays)` records any number of plays in one transaction: the history rows, the tracks' metadata and their signals. The player records each play as it ends (`features/signals/play-recorder.ts`); imports (stage 3.6) feed another service's listening history through it:

- give each play its track (cached, so Recently played can show it), `playedAt` (when it started), `playedMs`, `completed` and `skipped`, and the `importId`. A track's `durationMs` is the default length; without one the share played is measured against 3.5 minutes;
- record in batches (a few hundred per call keeps each transaction short);
- a play of the same track at the same start as one already recorded is the same play, so a resumed or repeated import records nothing twice;
- likes and playlists come in through `addTracks` and `createPlaylist`, which record their signals themselves.

## Backups

`backup.ts` exports every table but the derived `affinity` into one versioned JSON file (`format: "fxm-library-backup"`, `version: 1`, the schema version, and optionally the app's settings), read in one transaction so the file is a consistent snapshot. Import validates first: files that aren't backups or come from a newer FXM are refused, and every record goes through `validate.ts`, which drops bad ones and recomputes derived keys. Then it writes in one transaction, so a failure leaves the library untouched, and rebuilds the affinity from the result in the same transaction.

- **Replace** makes the library exactly the backup's, custom orders, undo orders and play IDs included. `backup.test.ts` checks the round trip: export, wipe, import gives the same tables.
- **Merge** keeps everything here. New playlists, likes, follows and plays are added; a playlist that is in both keeps its newer edit's name and order, followed by the tracks only the other has; the list of playlists keeps its order, with the backup's extra playlists at the end; in the match cache a pin wins, then the newer decision.
