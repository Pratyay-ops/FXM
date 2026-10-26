# Imports (`features/import`)

The Import page (`/import`) brings playlists, liked songs, saved albums and artists and listening history into the library, from Spotify's data download, a CSV or M3U file, or a Spotify or YouTube link. Each import's page (`/import/:id`) shows its progress, its match report and the songs to review. The Library page links here.

The work is done by `@fxm/sources/import` (see [its README](../../../../../packages/sources/src/import/README.md)); this folder is the app around it.

| File | What it does |
|---|---|
| `import-page.tsx` | The page: what to import (three tabs, the main button first, the Spotify steps folded away, files can be dropped), the preview, and every import with its progress |
| `import-preview.tsx` | What an input holds, what to import (playlists by name, all or none at once, with the number of songs chosen; the listening history; the saved albums and artists), and the start |
| `import-list.tsx` | The imports, newest first, each with its progress, status, main action (Review, Resume or the match report), Retry, and a menu with Open playlist, Cancel (confirmed) and Remove |
| `import-detail-page.tsx` | One import: progress, the match report (totals, CSV and JSON files), the songs to review (with Undo) and all songs (with Change) |
| `review-item.tsx` | One song to review: what the input says, the best guess and the alternatives, "Use this song" and "Skip"; a decided song as one line with Undo |
| `matching-notice.tsx` | Why imports can't find songs here (no FXM Connect, or not available yet), said once, with links to the site's FXM Connect steps and apps |
| `runner.ts` | Starts, runs, pauses, resumes, cancels and reviews imports (below) |
| `locks.ts` | One tab per import, with Web Locks |
| `hooks.ts` | Where imports stand in this tab and others, and whether songs can be found here |
| `focus.ts` | Where keyboard focus goes after an action took its button away, or when a focused button goes away by itself (Pause once the import finishes) |
| `sink.ts` | Where a running import's decisions go in the library |
| `files.ts` | Reading the picked files, and why reading failed, in words |
| `format.ts` | Words for kinds, statuses, counts and what an input left out |
| `services.tsx` | What imports need from the rest of the app (below) |
| `testing.tsx` | Fake services, a fake Web Locks manager and an app render for tests |

## How an import runs

1. **Pick and preview.** The files are read in the page (a ZIP archive is unpacked there, only the files an import uses; a playlist file over 32 MB is refused before it is read); a link is loaded through the Spotify provider or the YouTube adapter at the request budget's `interactive` priority, since the user waits for it, and Cancel stops it. The preview lists what will be imported and what is left out, and says so before Start when songs can't be found in this browser yet.
2. **Start** (`startImports`): each chosen playlist is created with its rows' own catalog tracks, so it shows in the library at once, and gets a progress record (`importProgress`, status `pending`) whose `state` holds the import's progress (`ImportState` of `@fxm/sources/import`). Then the saved albums and artists are followed and the listening history is recorded as plays in batches of 500 (`recordPlays`, under its own progress record, kind `spotify-history`). Once the playlists exist, a failure to follow or to record the history is reported, not thrown, so Start never creates a playlist twice; when a playlist can't be created, the ones before it are importing and the preview starts only the rest. Focus moves to the first new import.
3. **Match in the background.** The runner works through the pending imports one at a time per tab, with `runImport`: it matches every row in the catalog mode chosen at the start, paced by the request budget, and saves the progress at most every 20 seconds and when it stops. The page reads everything from the library through live queries; only what the job does this second (the row, a wait for the budget, a history being recorded) comes from the runner's small store, `useImportRunner`.
4. **One tab per import.** A tab holds an import's Web Lock (`fxm-import:<id>`) while it runs it or records its history, and while it writes a review decision. Another tab sees the lock: it shows the import as running elsewhere, offers no Resume, Retry or review there, and never runs it too. Browsers without Web Locks guard each tab only.
5. **Stop and resume.** Pause and Cancel (after a confirmation, which offers to delete the playlist when it has no songs) stop the job once its current request ends. An import pauses by itself when songs can't be found here (the card says "Paused: needs FXM Connect" and the notice above the list explains), when the network is out (it goes on by itself once the browser is back online), or when the library can't save (the browser may be out of space; Resume goes on). Why is saved in the progress (`state.blocked`), so each card says it in a few neutral words; only a real failure shows in the danger color. An import its tab left `running` (a reload, a closed tab) shows as interrupted, and Resume puts it back in the queue: it goes on from its first waiting row. "Retry failed" puts the songs that failed, and those whose search was cut short, back in the queue. A listening history is never resumed: cut off half-way, it is finished by importing the download again, since no play is recorded twice.
6. **Review.** Rows in the Suggest band and rows without a good match wait for the user. "Use this song" pins the chosen candidate for a row's own catalog track (`pinMatch`), or puts the song into the playlist at the row's place for a row without one (or whose own track the mode hides); "Skip" leaves it out. A decision changes the progress only once the library has done its part. A decided song stays in place as one line with Undo; "Change" in All songs reopens one decided earlier (the pin is removed and the engine's decision cached again, or the placed song is taken out of the playlist). While Auto matching is off, matches the engine would play by themselves are offered as "likely matches", confirmed in one tap, with Undo. Each decision is announced, and focus moves to the next song. Review decisions and the running job share one progress object, and decisions for one import are applied one after another, also against a run that starts meanwhile, so none is lost.

## Services: the touch-points

`useImportServices()` gives the pages an `ImportServices`: provider contexts at the budget's `bulk` priority (or `interactive` for a link), the budget's next bulk slot, bot-check reports, the capabilities and their changes, whether songs can be found here (`matching()`), whether the device is online, the YouTube adapter, the Spotify provider, the MusicBrainz client and the Auto setting. The import pages create them when they open (`useMatchingAvailability`); that sends no request: nothing reaches the network until an import runs or a link loads. Tests pass fakes with `ImportServicesProvider` (`testing.tsx`).

The app's own services (`loadAppImportServices`) are, for now, created in `services.tsx`, because no merged stage wires the platform and providers app-wide yet. When that wiring lands, these lines change:

| Touch-point | Now | Then |
|---|---|---|
| Platform (stage 1.2) | `createPlatform()` here, without the Lite sandbox (1.10) | The app's one shared platform |
| YouTube Music and YouTube (1.3) | `YOUTUBE_IMPORT_UNAVAILABLE`: YouTube links can't load, matching pauses, and the pages say finding songs isn't available yet | `createYouTubeImport({ music, video, topResult, releaseFacts })` over 1.3's providers |
| Spotify (1.5) | `createSpotifyProvider()`, always on. In a browser its key still needs 1.10's user-host document, so Spotify lookups fall back to MusicBrainz until then | The app's shared provider, with the Settings switch (2.4) and `secretFetch` (1.10) |
| MusicBrainz (1.6) | `createMusicBrainzClient()` | The app's shared client |
| Auto setting (1.12) | Off | The matching config's setting |
| Match cache band (2.6) | `recordDecision` in `sink.ts` stores the band with the Auto setting applied, because 2.6's `getConfirmedMatch` reads `record.band` as it is | Once 2.6's `isConfirmedMatch` applies the setting when it reads (`effectiveMatchBand(record.candidate?.verdict, autoOn)`), store `decision.verdictBand`, as core's `MatchVerdict` asks |
| Progress storage (2.6) | The whole progress in the record's `state`, saved at most every 20 seconds; the import list's `listImports()` reads every import's progress | The results per row or in chunks, or at least `state` kept out of the list's query |

## Library use

Through the repository only: `startImport`, `updateImport`, `getImport`, `listImports` and `deleteImport` for progress; `createPlaylist`, `getPlaylistView`, `addTracks`, `removeTracks`, `moveItems` and `deletePlaylist` for the playlist; `saveTracks` for fresher metadata; `recordMatch`, `getMatch`, `pinMatch` and `unpinMatch` for the match cache; `recordPlays` for the history; `follow` and `isFollowing` for saved albums and artists. The link field uses the library's `TextField` with its `error` prop, which ties the message to the field.
