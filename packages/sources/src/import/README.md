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
  const end = await runImport(state, environment, sink, { signal }) // 'done', 'stopped' or 'blocked'
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

Each playlist holds a track once (`skipped.duplicates` counts the rest) and at most 20,000 rows. Podcast episodes, audiobooks, the other app's local files and rows without a title are left out and counted in `ParsedImport.skipped`, for the preview. Inputs that cannot be imported at all throw an `ImportInputError` with a code the app turns into a message (`no-title-column`, `not-spotify-export`, `bad-zip`, …).

**The data export's personal data.** Only the playlist, library and history files are parsed, and in them only the fields FXM uses. The export's other files (user data, search queries, payments, inferences) are never opened, and the history's user name, IP addresses, devices and countries are never copied. `CLEAN-ROOM.md` lists the formats and where they were checked.

**The listening history.** The extended streaming history (`Streaming_History_Audio_*.json`, or the older `endsong_*.json`) names each play's track and says whether it completed (`reason_end: trackdone`) or was skipped (`skipped`, `reason_end: fwdbtn`). The account data's year of plays (`StreamingHistory_music_*.json`) names only the artist and the title, so its plays are identified through the export's own playlists and liked songs (the rest count as `unknownPlays`). When both are there, only the extended history is read, since it holds the same plays to the second. Both note when a play *ended*, in UTC; a play starts `ms_played` earlier. Plays shorter than five seconds are left out unless they were skipped. The library's `recordPlays` records a play of the same track at the same start once, so importing the same export again only fills in what is missing.

## The import job

`createImportState(kind, mode, collection)` makes an import's progress: its rows (without their whole tracks) and a `null` result for each. `runImport(state, environment, sink, { signal, onStatus })` works through the rows from the first one still waiting, updating `state` in place, and saves it through the sink after every row that took a request (and every 25 others). It resolves with:

- `done`: every row has a result;
- `stopped`: the signal aborted it (a pause, a cancel, a closed page); nothing done is lost;
- `blocked`: YouTube Music cannot be reached (no FXM Connect or Lite tier, or the YouTube providers are not wired in yet); the rows wait.

It rejects only when the library fails (storage full or blocked), with the library's error.

**Per row** (`planRow`):

| Row | What happens |
|---|---|
| Its own track already plays in the mode: a YouTube Music song, or any YouTube item in Music + Video mode | `ready`, no request |
| It only links its track (an M3U line with a link, no title) | The track is loaded first (YouTube adapter or Spotify), saved and placed in the playlist |
| An official video without a song link, in Music mode | The engine's video → song rule (`matchVideoToSong`) over one songs search |
| Any other row: a Spotify track, a CSV or M3U row without a catalog track, a video in Music mode | `runMatch` with the row as its source |

Before a Spotify row without an ISRC or a length is matched, it is looked up (`lookup.ts`): on **Spotify** when it is on and reachable (`getTrackDetails`, and `getTrack` when the length is missing: an ISRC the engine trusts as the catalog's own, the label, the release date and the album type), else through **MusicBrainz's exact path** (`findExactIsrcs`, up to 100 rows per batch: a hit is an ISRC-verified input, `musicbrainz-exact`, with the recording's length). Spotify's data export needs no Spotify provider this way. A row that neither can fill has no length, and the engine runs in **no-duration mode**, which never goes beyond Suggest. After a Spotify failure (other than a missing track), Spotify is left alone for five minutes, or as long as it asked.

A catalog row whose decision the library's match cache already holds is not searched again (`ImportSink.cachedMatch`); a decision of an older matching engine is made again, and a user's pin always counts.

**Bands and the Auto setting.** The engine decides with the user's Auto setting (`ImportEnvironment.autoMatch`, off until stage 1.12's report passes): `auto` → `matched`, `suggest` → `review`, `none` → `not-found`. The best candidate keeps the engine's verdict, the band it would reach with the setting on, so the review list can offer "likely" matches (`isLikelyMatch`) to confirm in one tap.

**What reaches the library** (`ImportSink`):

- The playlist starts with every row's own catalog track (`initialPlaylistTracks`), in order, so it shows at once.
- A catalog row's decision goes into the match cache (`recordMatch`) with the band the setting allows, so the cache never lets a match play that the setting holds back; an incomplete decision (a page could not be fetched) is shown but never cached.
- A row without a catalog track gets its song into the playlist only when the match plays without asking (`placeTrack`), before the next row's track, which keeps the input's order without undoing the user's own moves.
- Fresher metadata (Spotify's artwork) is saved with `saveTrack`.

**Pacing.** Before every YouTube request the job waits for the request budget's next bulk slot (`waitForBulkSlot`, which is `budget.whenAvailable('bulk')`), outside any request timeout, as the platform's job-runner contract asks: through bot-check pauses, the 5-second spacing and a used-up hour. A request the budget turns away meanwhile (`RateLimited`) or a bot check is reported to the platform (`report`) and tried again once the budget allows; a network failure is tried twice more; any other failure skips that page, and the result is marked `incomplete`. `Unsupported` stops the run as `blocked`. Spotify calls are a second apart; MusicBrainz calls wait in MusicBrainz's own queue at `bulk` priority, behind anything the user is waiting for.

## Review and report

- `applyReview(state, index, { action: 'confirm', ref } | { action: 'skip' }, now)` records the user's decision and says what the library must do: `pin` the candidate as the audio of the row's catalog track (`pinMatch`), or `place` the song into the playlist (`before` the next row's track), or nothing for a skip.
- `importCounts(state)` gives the progress record's counts; `rowStatus` and `needsReview` say where a row stands.
- `importReport(state, label)` is the match report: per row the status, the verdict, the confidence, the match, the ISRC (verified or not), where the ISRC or length came from, whether it ran without a length, and why it did not reach Auto; with the totals (`isrcVerified`, `noDuration`, `musicBrainz`, `likely`, …). `reportToCsv` (RFC 4180, with formula-looking cells defused) and `reportToJson` turn it into files.
- `sanitizeImportState(value)` reads saved progress back, refusing anything this version cannot resume.

## The YouTube touch-point

Reading YouTube playlists and tracks and fetching the engine's searches go through `ImportYouTube` (`youtube.ts`), the one touch-point with the YouTube providers of stage 1.3, which had not merged when imports were written. Until then the app passes `YOUTUBE_IMPORT_UNAVAILABLE`, whose calls fail with `Unsupported`: imports keep their rows and pause. Once 1.3 has merged, `createYouTubeImport({ music, video, topResult, releaseFacts })` builds the real one from its providers: song searches from YouTube Music in Music mode, the videos filter and plain YouTube search in Music + Video mode, the top-result card and the candidates' descriptions from 1.3's own calls. A page kind it has no source for answers `null`, which the engine records as skipped.

## Tests

`scripts/run.sh pnpm vitest run packages/sources/src/import` runs them offline, on hand-made files in the formats above and a fake YouTube Music catalog (`./testing`). The job tests run the real matching engine. Among them, `run.test.ts` imports a 100-track playlist (70 rows matched by ISRC, 10 by text, 5 ISRC misses, 5 rows without a length, 5 the catalog lacks and 5 it has only as a live recording) and checks its match report: 80 matched, 10 to review, 10 not found, and no wrong auto-play. Other tests stop and resume an import from its saved progress, cover bot checks, network failures, the Spotify and MusicBrainz lookups, the match cache, a blocked YouTube and a failing library.

`FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/import/live.test.ts` checks the data export's MusicBrainz leg against musicbrainz.org: a constructed export row for Radiohead's "Creep" gets its ISRC (GBAYE9200070) and length through the exact path, in two requests. It passed on 2026-10-26 from a residential connection. YouTube Music matching joins it once the YouTube providers are wired in.
