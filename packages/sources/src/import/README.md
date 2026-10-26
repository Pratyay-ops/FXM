# Imports (`@fxm/sources/import`)

Brings other apps' music into FXM: Spotify's "Download your data" export, CSV files (Exportify's columns first), M3U and M3U8 playlists, Spotify playlist, album and track links, and YouTube and YouTube Music playlists. Each becomes a playlist of the library; the matching engine of `@fxm/core` (stage 1.7) finds every row's song in the user's catalog mode, paced by the shared request budget (1.2), and an import resumes where it stopped. A data export's listening history becomes listening signals (3.1).

Everything runs on the user's device. Files are read where they are opened; the only requests are the matching searches (YouTube Music), the ISRC lookups (Spotify when it is on, otherwise MusicBrainz's exact path) and, for links, the playlist pages.

```ts
import {
  createImportState,
  initialPlaylistTracks,
  parseExportFiles,
  runImport,
} from '@fxm/sources/import'

const parsed = await parseExportFiles([{ name: file.name, bytes }]) // or parsePlaylistFile, loadLinkImport
for (const collection of parsed.collections) {
  const playlistId = await library.createPlaylist({ name: collection.name, tracks: initialPlaylistTracks(collection) })
  const state = createImportState(parsed.kind, mode, collection) // saved with the progress record
  const end = await runImport(state, environment, sink, { signal }) // 'done', 'stopped' or 'blocked' (with a reason)
}
```

The web app's `features/import` drives this with the library's import-progress table; see its README.

## What each input becomes

| Input | Read with | Rows | Also |
|---|---|---|---|
| Spotify's data export: the ZIP archive as Spotify sends it, or its JSON files | `parseExportFiles` (`readZip`, `parseSpotifyExport`) | One playlist per `Playlist*.json` playlist, and "Liked Songs from Spotify" from `YourLibrary.json`: Spotify tracks with names but no lengths or ISRCs | Saved albums and followed artists (`follows`); the listening history (`plays`) |
| CSV | `parsePlaylistFile` (`parseCsvImport`) | One playlist named after the file, or one per value of a playlist column; Exportify's rows carry the Spotify track, the length and the ISRC | |
| M3U, M3U8 | `parsePlaylistFile` (`parseM3uImport`) | One playlist (`#PLAYLIST`, else the file name); titles and artists from `#EXTINF` ("Artist - Title"), else from the file name and its folders; Spotify and YouTube links name their track | |
| Spotify playlist, album or track link | `parseImportLink`, then `loadLinkImport` (`loadSpotifyImport`) through the Spotify provider (1.5), pages a second apart | The tracks with all their metadata | |
| YouTube or YouTube Music playlist link | `parseImportLink`, then `loadLinkImport` (`loadYouTubeImport`) through the YouTube adapter | Every item, whatever the mode | |

Each playlist holds a track once (`skipped.duplicates` counts the rest) and at most 20,000 rows (`skipped.overLimit` counts the rest). Podcast episodes, audiobooks, the other app's local files and rows without a title are left out and counted in `ParsedImport.skipped`, for the preview. Inputs that cannot be imported at all throw an `ImportInputError` with a code the app turns into a message (`no-title-column`, `not-spotify-export`, `history-unidentified` for the account data's history chosen without the files that identify its plays, `bad-zip`, …).

**Links** load page after page while the provider gives a new cursor, also past a page the mode filtered empty (Spotify's pages drop podcast episodes even in Music + Video mode), up to 1,000 pages. The caller's provider context picks the request budget's priority and carries the signal that cancels the load: the app uses `interactive`, since the user waits for it, so a link loads during a running import or a bot-check pause too.

A file path's `.` and `..` are resolved, never read as folder names, and a leading track number is dropped only when it clearly is one (`01 `, `1-02 `, `7. `, `12 - `): "99 Problems.mp3" keeps its title.

**The data export's personal data.** Only the playlist, library and history files are parsed, and in them only the fields FXM uses. The export's other files (user data, search queries, payments, inferences) are never opened, and the history's user name, IP addresses, devices and countries are never copied. `CLEAN-ROOM.md` lists the formats and where they were checked.

**The listening history.** The extended streaming history (`Streaming_History_Audio_*.json`, or the older `endsong_*.json`) names each play's track and says whether it completed (`reason_end: trackdone`) or was skipped (`skipped`, `reason_end: fwdbtn`). The account data's year of plays (`StreamingHistory_music_*.json`) names only the artist and the title, so its plays are identified through the export's own playlists and liked songs (the rest count as `unknownPlays`). When both are there, only the extended history is read, since it holds the same plays to the second. Both note when a play *ended*, in UTC; a play starts `ms_played` earlier. Plays shorter than five seconds are left out unless they were skipped. The library's `recordPlays` records a play of the same track at the same start once, so importing the same export again only fills in what is missing.

## The import job

`createImportState(kind, mode, collection)` makes an import's progress: its rows (without their whole tracks) and a `null` result for each. `runImport(state, environment, sink, { signal, onStatus })` works through the rows from the first one still waiting, updating `state` in place. It saves the progress through the sink at most every 20 seconds (`SAVE_INTERVAL_MS`) and when it ends: each save rewrites the whole progress, so saving after every row would cost the square of the row count. A run cut off between two saves (a closed tab) repeats those few rows, which only writes again what the library already holds. It resolves with:

- `done`: every row has a result;
- `stopped`: the signal aborted it (a pause, a cancel, a closed page); nothing done is lost;
- `blocked`, with a `reason` that is also saved as `state.blocked` (and cleared when a run starts again), so a page can say why without a message to parse:
  - `unsupported`: YouTube Music cannot be reached (no FXM Connect or Lite tier, or the YouTube providers are not wired in yet);
  - `offline`: the device says it is offline (`ImportEnvironment.isOnline`), or YouTube kept failing with network errors (after five more tries, 2 to 30 seconds apart, which ride out a short drop).

  The row it was on, and every row after it, waits: an outage never records a song as not found.

It rejects only when the library fails (storage full or blocked), with the library's error.

**What a row keeps.** A row that plays (`ready`, `matched`) keeps only its best candidate, since nothing reviews it and the match cache holds the alternatives; rows to review keep up to three alternatives with their albums and artwork; every candidate keeps at most eight lines of evidence (`storedResult`). The tracks a search listed are kept only while their row is matched.

**Per row** (`planRow`):

| Row | What happens |
|---|---|
| Its own track already plays in the mode: a YouTube Music song, or any YouTube item in Music + Video mode | `ready`, no request |
| It only links its track (an M3U line with a link, no title) | The track is loaded first (YouTube adapter or Spotify), saved and placed in the playlist |
| An official video without a song link, in Music mode | The engine's video → song rule (`matchVideoToSong`) over one songs search |
| A plain YouTube video in Music mode, which the mode hides (`hiddenInMode`) | `runMatch`, like a row without a catalog track: the song goes into the playlist right after the video, since a match cached for the hidden video could never play |
| Any other row: a Spotify track, a CSV or M3U row without a catalog track | `runMatch` with the row as its source |

Before a Spotify row without an ISRC or a length is matched, it is looked up (`lookup.ts`): on **Spotify** when it is on and reachable (`getTrackDetails`, and `getTrack` when the length is missing: an ISRC the engine trusts as the catalog's own, the label, the release date and the album type), else through **MusicBrainz's exact path** (`findExactIsrcs`, up to 100 rows per batch: a hit is an ISRC-verified input, `musicbrainz-exact`, with the recording's length). Spotify's data export needs no Spotify provider this way. A row that neither can fill has no length, and the engine runs in **no-duration mode**, which never goes beyond Suggest. After a Spotify failure (other than a missing track), Spotify is left alone for five minutes, or as long as it asked. When MusicBrainz is busy, the row is matched without a lookup and marked `incomplete`, so it is never cached and "Retry" looks it up again; a network failure stops the run as offline.

A catalog row whose decision the library's match cache already holds is not searched again (`ImportSink.cachedMatch`); a decision of an older matching engine is made again, and a user's pin always counts.

**Bands and the Auto setting.** The engine decides with the user's Auto setting (`ImportEnvironment.autoMatch`, off until stage 1.12's report passes): `auto` → `matched`, `suggest` → `review`, `none` → `not-found`. The best candidate keeps the engine's verdict, the band it would reach with the setting on, so the review list can offer "likely" matches (`isLikelyMatch`) to confirm in one tap.

**What reaches the library** (`ImportSink`):

- The playlist starts with every row's own catalog track (`initialPlaylistTracks`), in order, so it shows at once.
- A catalog row's decision goes into the match cache (`recordMatch`) with the band the setting allows (`ImportMatchDecision.band`), so the cache never lets a match play that the setting holds back; an incomplete decision (a page could not be fetched) is shown but never cached. The decision also carries the verdict's band (`verdictBand`), which the cache should store once it applies the setting when it reads (see the touch-points below).
- A row without a catalog track gets its song into the playlist only when the match plays without asking (`placeTrack`), before the next row's track, which keeps the input's order without undoing the user's own moves.
- Fresher metadata (Spotify's artwork) is saved with `saveTrack`.

**Pacing.** Before every YouTube request the job waits for the request budget's next bulk slot (`waitForBulkSlot`, which is `budget.whenAvailable('bulk')`), outside any request timeout, as the platform's job-runner contract asks: through bot-check pauses, the 5-second spacing and a used-up hour. A request the budget turns away meanwhile (`RateLimited`) or a bot check is reported to the platform (`report`) and tried again once the budget allows; a network failure is tried five more times before the run stops as offline; a search that finds nothing (`NotFound`) is an empty page; any other failure skips that page, and the result is marked `incomplete` (and counts as `failed` when nothing was found at all, so "Retry" covers it). `Unsupported` stops the run as `blocked`. Spotify calls are a second apart; MusicBrainz calls wait in MusicBrainz's own queue at `bulk` priority, behind anything the user is waiting for.

## Review and report

- `planReview(state, index, { action: 'confirm', ref } | { action: 'skip' }, now)` says what the user's decision makes of the row (its new `result`) and what the library must do (`effect`): `pin` the candidate as the audio of the row's catalog track (`pinMatch`), or `place` the song into the playlist (`before` the next row's track), or nothing for a skip. It leaves the state alone: commit the result once the library did its part, so a failed library change loses nothing. `applyReview` does both at once.
- `planReopen(state, index)` takes a decision back (Undo, or "Change"): the row waits for review again, and the effect removes the pin and stores the engine's own decision again (`unpin`), or takes the placed song out of the playlist (`unplace`, unless another row has it too). A decided row is reopened before it is decided again.
- `importCounts(state)` gives the progress record's counts; `rowStatus` and `needsReview` say where a row stands; `importBlockOf(record.state)` reads why an import paused by itself, without checking the rest of the progress.
- `importReport(state, label)` is the match report: per row the status, the verdict, the confidence, the match, the ISRC (verified or not), where the ISRC or length came from, whether it ran without a length, and why it did not reach Auto; with the totals (`isrcVerified`, `noDuration`, `musicBrainz`, `likely`, …). `reportToCsv` (RFC 4180, with formula-looking cells defused) and `reportToJson` turn it into files.
- `retryFailedRows(state)` puts the rows that failed, and those whose search was cut short and that nobody decided about (`isRetryable`), back in the queue for the next run.
- `sanitizeImportState(value)` reads saved progress back, refusing anything this version cannot resume. It checks every field (the evidence, the blockers, the extras' https artwork and album IDs, the review, each candidate's kind, length, signals and verdict), since progress also comes back from library backups and reaches the review list and library tracks.

## Integration touch-points

**YouTube (stage 1.3).** Reading YouTube playlists and tracks and fetching the engine's searches go through `ImportYouTube` (`youtube.ts`), the one touch-point with the YouTube providers of stage 1.3, which had not merged when imports were written. Until then the app passes `YOUTUBE_IMPORT_UNAVAILABLE`, whose calls fail with `Unsupported`: imports keep their rows and pause. Once 1.3 has merged, `createYouTubeImport({ music, video, topResult, releaseFacts })` builds the real one from its providers: song searches from YouTube Music in Music mode, the videos filter and plain YouTube search in Music + Video mode, the top-result card and the candidates' descriptions from 1.3's own calls. A page kind it has no source for answers `null`, which the engine records as skipped.

**The match cache's band (stage 2.6).** Core's `MatchVerdict` asks a cache to store the verdict's band and apply the Auto setting when it reads. 2.6's `getConfirmedMatch` reads `record.band` as it is, so imports store the band with the setting applied (`ImportMatchDecision.band`); otherwise, with Auto off, a verdict of `auto` would play without asking. Once 2.6's `isConfirmedMatch` reads `effectiveMatchBand(record.candidate?.verdict, autoOn)`, the app's sink stores `verdictBand` instead (one line in the web app's `sink.ts`); until then, imported matches stay held back after stage 1.12 turns Auto on, until the user confirms them or they expire after 30 days.

**Progress storage (stage 2.6).** The progress lives in one JSON value of the library's import-progress record, rewritten by each save. Saving at most every 20 seconds and keeping little of the rows that play keeps that bounded, but a 20,000-row import still rewrites a few megabytes per save, and the library's `listImports()` reads every import's whole progress for the import list. A later step should store the results per row or in chunks, or at least keep `state` out of the list's query.

## Tests

`scripts/run.sh pnpm vitest run packages/sources/src/import` runs them offline, on hand-made files in the formats above and a fake YouTube Music catalog (`./testing`). The job tests run the real matching engine. Among them, `run.test.ts` imports a 100-track playlist (70 rows matched by ISRC, 10 by text, 5 ISRC misses, 5 rows without a length, 5 the catalog lacks and 5 it has only as a live recording) and checks its match report: 80 matched, 10 to review, 10 not found, and no wrong auto-play. Other tests stop and resume an import from its saved progress, cover bot checks, network outages (the run stops, then picks the row up again), empty searches, the save interval, the Spotify and MusicBrainz lookups, the match cache, hidden videos, a blocked YouTube and a failing library; `state.test.ts` checks reopening decisions and refuses damaged progress field by field.

`FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/import/live.test.ts` checks the data export's MusicBrainz leg against musicbrainz.org: a constructed export row for Radiohead's "Creep" gets its ISRC (GBAYE9200070) and length through the exact path, in two requests. It passed on 2026-10-26 from a residential connection. YouTube Music matching joins it once the YouTube providers are wired in.
