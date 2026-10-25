# Search and browse (stage 2.4)

The search page and the album, artist and playlist pages (`features/{album,artist,playlist}`), plus the app's single place for music sources. Everything here works against the interfaces of `@fxm/core`; the stages that supply the real platform, providers, player and library plug in through small adapters (see [Wiring in the other stages](#wiring-in-the-other-stages)).

## What the user gets

- **Search** (`/search?q=…`): the query is searched once it has paused for 300 ms (`searchTiming`), and completions from the source's `suggest` appear as links above the results after 150 ms. Typing in the search box updates the URL on every keystroke, so both waits live on the page, which stays mounted: the first keystroke never searches a single letter.
- **The mode chip** (Music / Music + Video) with a line that explains the mode.
- **Tabs:** Songs, Albums, Artists, Playlists, plus Videos in Music + Video mode for YouTube sources. Each tab asks the provider for its own type only (one InnerTube call per query and tab, from the shared request budget), a page of 20 at a time with "Show more". The tab and source picked last are kept for the session (`search-view.ts`), because the URL holds only the query.
- **The source switch** ("Search in"): YouTube Music, plus Spotify when it is switched on and reachable, plus any other registered source that can be used (Internet Archive and Jamendo once 1.6 is wired in). A source that stops being offered, e.g. Spotify switched off, falls back to YouTube Music.
- **Kind and source badges on every row:** `Song`, `Official video`, `Video`, `Album`, `Single`, `EP`, `Artist`, `Playlist` …, and `YouTube Music`, `YouTube`, `Spotify` … Text in FXM's own colors only: no service logos or brand colors (docs/LEGAL.md).
- **Album, artist and playlist pages:** play, shuffle, and a menu with play next, add to queue, add to playlist and download; each track row has its own menu (also "Go to album", "Go to artist" and the equalizer). Playlists load a page at a time. Lists respect the catalog mode (`applyModeFilter`).

### Tiers

| | Free only (`youtube: 'none'`) | Lite (`'simple'`) | Full (`'full'`) |
|---|---|---|---|
| YouTube Music results and pages | The onboarding entry point instead of results | ✅ | ✅ |
| Download and equalizer on YouTube items | — | Hidden (the bytes can't be read), with a note that says why | ✅ |
| Spotify in the source switch | — | — | ✅ when switched on |

`itemFeatures(capabilities, source)` in `sources.ts` is the one rule for download and the equalizer: YouTube and Spotify items need `mediaBytes` (only `full` has it); Internet Archive, Jamendo and local files always allow them.

### Page URLs

An entity page names its entity as `<source>:<native ID>`, with the kind in the path: `/album/ytm:MPREb_…`, `/artist/spotify:0Od…`, `/playlist/ytm:PL…`. Build links with `albumPath`, `artistPath` and `playlistPath` from `catalog/links.ts`. A playlist ID without a source, such as the sidebar's `liked`, still shows the shell's placeholder until the library (2.6) gives its playlists pages.

## The sources module

`sources.ts` and `sources-context.tsx` are the app's single place for sources:

- the registered `MetadataProvider`s, by source (`sources.register(provider)`);
- the platform's `NetworkCapabilities`, kept current (`sources.setPlatform(platform)`);
- the user's Spotify switch: on by default, persisted under `fxm.sources.v1` and shown in Settings → Sources. It is a setting, not a capability: Spotify is used only when it is on **and** reachable;
- `sources.context({ mode, signal })`, the `ProviderContext` for one provider call.

Components read it with `useSourcesSnapshot()`; `sourceAvailability(snapshot, source)` says whether a source can be used, and if not why (`needs-youtube`, `spotify-off`, `spotify-unreachable`, `missing`), which picks what the page shows instead. `appSources` is the app's instance; `<SourcesProvider>` swaps in another (tests do).

## Wiring in the other stages

Every touch-point with a stage built in parallel goes through one interface here, with a fake. Wiring a stage in is a few lines, for example in `main.tsx`:

| Stage | Touch-point | Until it is wired in | To wire it in |
|---|---|---|---|
| 1.2 platform | `SourcesPlatform` (the `capabilities.current`, `capabilities.subscribe` and `context()` of `FxmPlatform`) | `createStaticPlatform()`: the Free-only tier, a `fetch` that refuses | `appSources.setPlatform(await createPlatform(…))` |
| 1.3 YouTube Music, 1.5 Spotify (and 1.6) | `MetadataProvider` from `@fxm/core` | No providers | `appSources.register(provider)` for each |
| 2.2 / 2.3 player | `PlaybackActions` (`play`, `playNext`, `addToQueue`), shaped like the player facade | No play or queue buttons | `appActions.set({ ...appActions.get(), playback })` |
| 2.6 library | `LibraryActions` (`playlists`, `addToPlaylist`, `createPlaylist`) | No "Add to playlist" | `appActions.set({ ...appActions.get(), library })` |
| 4.1 downloads | `DownloadActions` | No "Download" | `appActions.set({ …, downloads })` |
| 8.1 audio effects | `EqualizerActions` | No "Equalizer" | `appActions.set({ …, equalizer })` |
| 2.7 onboarding | `ONBOARDING_URL` in `onboarding.tsx` | The landing page's "Get FXM" section | Point it at the in-app onboarding |

An action appears in the UI only when its group is wired in, so the app never shows a button that does nothing. `PlayContext` matches 2.2's `QueueContext` (`{ type, id, title }`).

## The fake catalog

`fake-catalog.ts` is a `MetadataProvider` over a small invented library (no real artists, no network), posing as YouTube Music or Spotify, with cursors, suggestions, the catalog mode, `NotFound`, abortable latency and failures on demand. `fake-actions.ts` records what the player and library were asked to do.

- **Tests:** `renderCatalog(path, { tier, spotifyEnabled, actions })` from `testing.tsx` renders the whole app with both fakes plugged in, and returns them. Call `resetCatalogState()` after each test.
- **Development:** in `make dev`, open the app with `?fake=full`, `?fake=lite` or `?fake=free` (for example `/app/search?q=harbor&fake=full`); the tab keeps it until `?fake=off`. Fake actions confirm themselves in a toast.
- **Screenshots:** `pnpm --filter @fxm/web screenshots` builds with `VITE_FXM_FAKE_CATALOG=on`, which includes the fake mode, and captures search and browse at 320, 768 and 1280 px in both themes (`catalog` in the file names). Production builds leave the fake catalog out.

## Files

| File | What |
|---|---|
| `sources.ts`, `sources-context.tsx`, `spotify-switch.ts`, `spotify-setting.tsx` | The sources module, its React context, the Spotify switch and its Settings control |
| `actions.tsx` | The actions adapter (player, library, downloads, equalizer) |
| `queries.ts` | TanStack Query hooks: search, suggestions, album, artist, playlist |
| `search-page.tsx`, `search-results.tsx`, `search-view.ts`, `use-debounced-value.ts` | The search page |
| `onboarding.tsx` | The onboarding entry point |
| `feedback.tsx` | The confirmation toast |
| `catalog/` | UI shared with the album, artist and playlist pages: rows, badges, cover art, menus, the add-to-playlist dialog, headers, states, links and formatting |
| `fake-catalog.ts`, `fake-actions.ts`, `dev-fakes.ts`, `testing.tsx` | Fakes, the development fake mode and test helpers |
