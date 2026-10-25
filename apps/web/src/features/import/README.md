# Imports (`features/import`)

The Import page (`/import`) brings playlists, liked songs, saved albums and artists and listening history into the library, from Spotify's data download, a CSV or M3U file, or a Spotify or YouTube link. Each import's page (`/import/:id`) shows its progress, its match report and the songs to review. The Library page links here.

The work is done by `@fxm/sources/import` (see [its README](../../../../../packages/sources/src/import/README.md)); this folder is the app around it.

| File | What it does |
|---|---|
| `import-page.tsx` | The page: what to import (three tabs), the preview, and every import with its progress |
| `import-preview.tsx` | What an input holds, what to import (playlists by name, the listening history, the saved albums and artists), and the start |
| `import-list.tsx` | The imports, newest change first, with progress, status and actions (resume, pause, cancel, remove) |
| `import-detail-page.tsx` | One import: progress, the match report (totals, CSV and JSON files), the songs to review and all songs |
| `review-item.tsx` | One song to review: what the input says, the best guess and the alternatives, "Use this song" and "Skip" |
| `runner.ts` | Starts, runs, pauses, resumes, cancels and reviews imports (below) |
| `sink.ts` | Where a running import's decisions go in the library |
| `files.ts` | Reading the picked files, and why reading failed, in words |
| `format.ts` | Words for kinds, statuses, counts and what an input left out |
| `services.tsx` | What imports need from the rest of the app (below) |
| `testing.tsx` | Fake services and an app render for tests |

## How an import runs

1. **Pick and preview.** The files are read in the page (a ZIP archive is unpacked there, only the files an import uses); a link is loaded through the Spotify provider or the YouTube adapter. The preview lists what will be imported and what is left out.
2. **Start** (`startImports`): the saved albums and artists are followed, the listening history is recorded as plays in batches of 500 (`recordPlays`, under its own progress record, kind `spotify-history`), and each chosen playlist is created with its rows' own catalog tracks, so it shows in the library at once. Each playlist gets a progress record (`importProgress`, status `pending`) whose `state` holds the import's progress (`ImportState` of `@fxm/sources/import`).
3. **Match in the background.** The runner works through the pending imports one at a time per tab, with `runImport`: it matches every row in the catalog mode chosen at the start, paced by the request budget, and saves the progress after every row. The page reads everything from the library through live queries; only what the job does this second (the row, a wait for the budget) comes from the runner's small store, `useImportRunner`.
4. **Stop and resume.** Pause and Cancel abort the job; a blocked one (YouTube Music out of reach) pauses with a note. An import its tab left `running` (a reload, a closed tab) shows as interrupted. Resume puts it back in the queue, and it goes on from its first waiting row. A listening-history import cut off half-way is finished by importing the download again: no play is recorded twice.
5. **Review.** Rows in the Suggest band and rows without a good match wait for the user. "Use this song" pins the chosen candidate for a row's own catalog track (`pinMatch`), or puts the song into the playlist at the row's place for a row without one; "Skip" leaves it out. While Auto matching is off, matches the engine would play by themselves are offered as "likely matches", confirmed in one tap. Review decisions and the running job share one progress object, and decisions for one import are applied one after another, so none is lost.

## Services: the touch-points

`useImportServices()` gives the pages an `ImportServices`: provider contexts with the budget's `bulk` priority, the budget's next bulk slot, bot-check reports, the capabilities, the YouTube adapter, the Spotify provider, the MusicBrainz client and the Auto setting. Nothing is created until an import needs it, so opening the page contacts nothing. Tests pass fakes with `ImportServicesProvider` (`testing.tsx`).

The app's own services (`loadAppImportServices`) are, for now, created in `services.tsx`, because no merged stage wires the platform and providers app-wide yet. When that wiring lands, these lines change:

| Touch-point | Now | Then |
|---|---|---|
| Platform (stage 1.2) | `createPlatform()` here, without the Lite sandbox (1.10) | The app's one shared platform |
| YouTube Music and YouTube (1.3) | `YOUTUBE_IMPORT_UNAVAILABLE`: YouTube links can't load, and matching pauses with a note | `createYouTubeImport({ music, video, topResult, releaseFacts })` over 1.3's providers |
| Spotify (1.5) | `createSpotifyProvider()`, always on. In a browser its key still needs 1.10's user-host document, so Spotify lookups fall back to MusicBrainz until then | The app's shared provider, with the Settings switch (2.4) and `secretFetch` (1.10) |
| MusicBrainz (1.6) | `createMusicBrainzClient()` | The app's shared client |
| Auto setting (1.12) | Off | The matching config's setting |

## Library use

Through the repository only: `startImport`, `updateImport`, `getImport`, `listImports` and `deleteImport` for progress; `createPlaylist`, `addTracks` and `moveItems` for the playlist; `saveTracks` for fresher metadata; `recordMatch`, `getMatch` and `pinMatch` for the match cache; `recordPlays` for the history; `follow` and `isFollowing` for saved albums and artists.

A decision goes into the match cache with the band the Auto setting allows, so `getConfirmedMatch` never returns a match the setting holds back, while the candidate keeps the engine's verdict for when the setting changes.
