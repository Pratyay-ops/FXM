# Search and browse (stage 2.4)

The search page and the album, artist and playlist pages (`features/{album,artist,playlist}`), plus the app's single place for music sources. Everything here works against the interfaces of `@fxm/core`; the stages that supply the real platform, providers, player and library plug in through small adapters (see [Wiring in the other stages](#wiring-in-the-other-stages)).

## What the user gets

- **Search** (`/search?q=…`): the query is searched once it has paused for 300 ms (`searchTiming`), and completions from the source's `suggest` appear as links above the results after 150 ms. Typing in the search box updates the URL on every keystroke, so both waits live on the page, which stays mounted. A query that was in the URL when the page opened (a reload, Back or Forward) is searched at once; one typed in the top bar elsewhere opens the page with its first letter, which waits like the keystrokes after it, so a single letter is never searched. While a newer query waits or loads, the results before it stay, dimmed.
- **Suggestions** keep their row's height while they load and when there are none, so the results never jump. Picking one moves focus to the results' heading, as the chosen link goes away (it is the query now). A source without `suggest` (Spotify, Internet Archive, Jamendo) shows none, never another source's, and so does one to call only on request (`requestPolicy: 'explicit'`, see `canSuggest`).
- **The mode chip** (Music / Music + Video) with a line that explains the mode. On phones the mode chip and the source switch share one row that scrolls sideways, and the hint, the "Search in" label and the results' heading are for screen readers only, so at least three results show above the mini player on a 375 × 667 screen.
- **Tabs:** Songs, Albums, Artists, Playlists, plus Videos in Music + Video mode for YouTube sources. Each tab asks the provider for its own type only (one InnerTube call per query and tab, from the shared request budget), a page of 20 at a time with "Show more". Selection follows focus in the tabs, so a tab is fetched only once it has stayed selected for 250 ms: arrowing from Songs to Videos searches Videos only. The tab and source picked last are kept for the session (`search-view.ts`), because the URL holds only the query.
- **The source switch** ("Search in"): YouTube Music, plus Spotify when it is switched on and reachable, plus any other registered source that can be used (Internet Archive and Jamendo once 1.6 is wired in). It is a row of chips (radio buttons) as wide as their names, so any number of sources fits. A source that stops being offered, e.g. Spotify switched off, falls back to YouTube Music.
- **Kind and source badges on every row:** `Song`, `Official video`, `Video`, `Album`, `Single`, `EP`, `Artist`, `Playlist` …, and `YouTube Music`, `YouTube`, `Spotify` … They follow the artist and album names, so the names line up. Text in FXM's own colors only: no service logos or brand colors (docs/LEGAL.md).
- **Album, artist and playlist pages:** play (in order) and shuffle, and a menu with play next, add to queue, add to playlist and download; each track row has its own menu (also "Go to album", "Go to artist" and the equalizer). Artist and album names in rows link to their pages only on screens 1024 px and wider with a mouse or trackpad: elsewhere they are too small to tap, so a tap plays the row and the menu has the links. Playlists load a page at a time, and in Music mode say what they hide ("7 of 8 songs", with a switch to Music + Video). Lists respect the catalog mode (`applyModeFilter`).
- **For keyboard and screen reader users:** every list of results has a polite status line ("Searching…", "9 songs for “harbor”", "No songs found", "20 more songs loaded, 40 in all"); "Show more" keeps focus while it loads (`aria-disabled`, not `disabled`) and then moves it to the first new row (`catalog/show-more.tsx`); focus rings on links in rows are drawn inside them, as the rows' text boxes clip.

### Tiers

| | Free only (`youtube: 'none'`) | Lite (`'simple'`) | Full (`'full'`) |
|---|---|---|---|
| YouTube Music results and pages | The onboarding entry point instead of results and their tabs, and a banner on the empty search page | ✅ | ✅ |
| Download and equalizer on YouTube items | — | Hidden (the bytes can't be read), with a note that says why on search and on album, artist and playlist pages | ✅ |
| Spotify in the source switch | — | — | ✅ when switched on |

`itemFeatures(capabilities, source)` in `sources.ts` is the one rule for download and the equalizer: YouTube and Spotify items need `mediaBytes` (only `full` has it); Internet Archive and Jamendo always allow them, and local files the equalizer only (they are on the device already).

### Page URLs

An entity page names its entity as `<source>:<native ID>`, with the kind in the path: `/album/ytm:MPREb_…`, `/artist/spotify:0Od…`, `/playlist/ytm:PL…`. Build links with `albumPath`, `artistPath` and `playlistPath` from `catalog/links.ts`. A playlist ID without a source, such as the sidebar's `liked`, still shows the shell's placeholder until the library (2.6) gives its playlists pages; any other ID that isn't `<source>:<native ID>` (`ytm:`, `foo:bar`) is "not found", as on the album and artist pages.

## The sources module

`sources.ts` and `sources-context.tsx` are the app's single place for sources:

- the registered `MetadataProvider`s, by source (`sources.register(provider)`);
- the platform's `NetworkCapabilities`, kept current (`sources.setPlatform(platform)`). Every new platform bumps `platformRevision`, which query keys hold: a query that failed through the stand-in (which refuses every request) runs again through the real platform, even when both report the same capabilities;
- the user's Spotify switch: on by default, persisted under `fxm.sources.v1` and shown in Settings → Sources. It is a setting, not a capability: Spotify is used only when it is on **and** reachable;
- whether the tier is still being worked out (`detecting`, `sources.setDetecting()`): FXM Connect's marker is on the page but it hasn't answered yet. `SourceUnavailable` and the search page then say "Connecting to FXM Connect…" instead of offering the install (the composition root sets and ends it, see `src/app/services`);
- `sources.context({ mode, signal })`, the `ProviderContext` for one provider call. It asks the platform for a context at the `interactive` priority (search, suggestions and opened pages, as the shared YouTube request budget ranks them) unless the call names another `priority`.

Components read it with `useSourcesSnapshot()`; `sourceAvailability(snapshot, source)` says whether a source can be used, and if not why (`needs-youtube`, `spotify-off`, `spotify-unreachable`, `missing`), which picks what the page shows instead. `appSources` is the app's instance; `<SourcesProvider>` swaps in another (tests do).

## Wiring in the other stages

Every touch-point with a stage built in parallel goes through one interface here, with a fake. Wiring a stage in is a few lines, for example in `main.tsx`:

| Stage | Touch-point | Until it is wired in | To wire it in |
|---|---|---|---|
| 1.2 platform | `SourcesPlatform` (the `capabilities.current`, `capabilities.subscribe` and `context()` of `FxmPlatform`) | `createStaticPlatform()`: the Free-only tier, a `fetch` that refuses | `appSources.setPlatform(await createPlatform(…))`, before registering providers, so no page calls one through the stand-in |
| 1.3 YouTube Music, 1.5 Spotify (and 1.6) | `MetadataProvider` from `@fxm/core` | No providers | `appSources.register(provider)` for each |
| 2.2 player facade (merged), playing once 2.3 resolves streams | `PlaybackActions` (`play`, `playNext`, `addToQueue`); `playbackFromPlayer(player)` maps the facade onto it | No play or queue buttons | `appActions.set({ ...appActions.get(), playback: playbackFromPlayer(player) })` with the app's `Player` |
| 2.6 library | `LibraryActions` (`playlists`, `addToPlaylist`, `createPlaylist`) | No "Add to playlist" | `appActions.set({ ...appActions.get(), library })` |
| 4.1 downloads | `DownloadActions` | No "Download" | Wired (2.9b): the downloads' own action, which says what became of the click; a track whose download exists has "Cancel download" or "Remove download" in its menu instead (`useDownloadMenuItem`, read once per list) |
| 8.1 audio effects | `EqualizerActions` | No "Equalizer" | `appActions.set({ …, equalizer })` |
| 2.7 onboarding | `ONBOARDING_URL` in `onboarding.tsx` | — | Wired (2.9b): `/connect`, the in-app onboarding, opened in the app |

An action appears in the UI only when its group is wired in, so the app never shows a button that does nothing. Queues start with `QueueContext` from `@fxm/core`: the album, artist or playlist, or the search query, so "Playing from …" can link back.

## The fake catalog

`fake-catalog.ts` is a `MetadataProvider` over a small invented library (no real artists, no network), posing as YouTube Music, Spotify, Internet Archive or Jamendo, with cursors, the catalog mode, `NotFound`, abortable latency and failures on demand. Like the real providers, only the YouTube Music fake has videos and suggestions. `fake-actions.ts` records what the player and library were asked to do.

- **Tests:** `renderCatalog(path, { tier, spotifyEnabled, actions, freeSources })` from `testing.tsx` renders the whole app with the fakes plugged in (YouTube Music and Spotify; Internet Archive and Jamendo too with `freeSources`), and returns them. Call `resetCatalogState()` after each test.
- **Development:** in `make dev`, open the app with `?fake=full`, `?fake=lite` or `?fake=free` (for example `/app/search?q=harbor&fake=full`); the tab keeps it until `?fake=off`. Add `&fake-sources=all` for fake Internet Archive and Jamendo too, until the next reload. Fake actions confirm themselves in a toast.
- **Screenshots:** `pnpm --filter @fxm/web screenshots` builds with `VITE_FXM_FAKE_CATALOG=on`, which includes the fake mode, and captures search and browse at 320, 768 and 1280 px in both themes (`catalog` in the file names), with four sources in the switch, and at 375 × 667. It also checks that nothing overflows, that three whole results show above the mini player at 375 × 667, and that a focused link in a row has its ring inside the box that clips it. Production builds leave the fake catalog out.

## Files

| File | What |
|---|---|
| `sources.ts`, `sources-context.tsx`, `spotify-switch.ts`, `spotify-setting.tsx` | The sources module, its React context, the Spotify switch and its Settings control |
| `actions.tsx` | The actions adapter (player, library, downloads, equalizer) |
| `queries.ts` | TanStack Query hooks: search, suggestions, album, artist, playlist |
| `search-page.tsx`, `search-results.tsx`, `search-view.ts`, `use-debounced-value.ts` | The search page |
| `onboarding.tsx` | The onboarding entry point |
| `feedback.tsx` | The confirmation toast: a message keeps its own 4 seconds, also across pages, and never comes back later |
| `catalog/` | UI shared with the album, artist and playlist pages: rows, badges, cover art, menus, the add-to-playlist dialog (it goes with the page that opened it), headers, states, "Show more", the Lite note, links and formatting |
| `fake-catalog.ts`, `fake-actions.ts`, `dev-fakes.ts`, `testing.tsx` | Fakes, the development fake mode and test helpers |
