# Home (stage 3.3)

The Home page: shelves of music built on this device from what the user plays (stage 3.1's listening affinity) and what the recommendation sources suggest (stage 3.2), ranked by the engine in `@fxm/core` ([its README](../../../../../packages/core/src/recommend/README.md)). Nothing leaves the device but the sources' own requests.

## What the user gets

| Shelf | What it holds |
|---|---|
| **Quick picks** | Favourites and new songs for right now, in columns of four that scroll sideways; nothing played in the last 12 hours |
| **Daily Mixes** | One card per cluster of the user's top artists: about half favourites, half new songs, changing once a day. A card opens the mix's songs, with Play |
| **Discover** | Songs the user never played, by artists they hardly know (never the artists they picked), changing every Monday |
| **Because you listened to X** | What the sources suggest for a recent play, new to the user (up to three shelves) |
| **On repeat** | The songs played most lately |
| **Rediscover** | Songs the user loved a while ago and hasn't played for a month |
| **Spotify's sections** | A connected Spotify account's personal home, only when Spotify is switched on, reachable and connected (stage 3.5 connects it) |

Every song plays its shelf from that song, with the shelf as the queue's context ("Playing from Quick picks"; a Because shelf plays as the seed's radio), once playback is wired in. No song shows on two shelves (the mixes are lists of their own). A song or artist the user skips, and a song they played long ago, never comes back as new.

**The cold start.** While FXM knows fewer than three artists the user likes, Home asks: *What do you like to listen to?* The user picks three or more artists (those they follow, and the popular artists of the services' home feeds where those can be reached, e.g. Spotify's for the user's market) or types any, plus any genres. Each artist is listed once, with the ID a suggestion carries even when its name was typed first. The picks stay on this device (`localStorage`, `fxm.home.taste.v1`) and count like likes, so they seed the first mixes and fade as real listening takes over. "Build my Home" and the count of picks stay in view, above the bottom bars, while the user picks. "Not now" puts the onboarding off: a small card brings it back, and the welcome card says what to do meanwhile.

**Your artists.** At the end of Home, once it has more to go on than a cold start, a small card lists the picks, with *Change* (the same form, the picks selected) and *Clear picks*, or offers to pick some.

### Tiers

| | Free only | Lite | Full |
|---|---|---|---|
| On repeat, Rediscover (the user's own music) | ✅ | ✅ | ✅ |
| Recommendations: Quick picks, Daily Mixes, Discover, Because you listened | — (a note below the user's shelves says how to get them; with no shelves, the welcome card does) | ✅ YouTube Music radio, ListenBrainz | ✅ also Spotify radio and related artists, Last.fm's station |
| The onboarding, Your artists | — | ✅ | ✅ |
| A connected Spotify account's sections | — | — | ✅ |

New music comes only where YouTube Music is reachable, because its songs are what plays (`canRecommend`). The collector applies the other rules of each source (stage 3.2).

### Keyboard, screen readers and small screens

- Focus never drops to the page: after "Not now" it moves to the reminder's *Pick artists*, after *Pick artists* to the onboarding's heading, and once Home is built from the picks to its first shelf (the button says *Building your Home…* meanwhile). *Change*, *Save*, *Cancel* and *Clear picks* work the same way.
- A focused song that shows only in part at the edge of a row scrolls into view (`revealFocused`). A row with nothing focusable in it (no playback wired in) takes focus itself, so the keyboard can scroll it in Safari too.
- On phones, part of the next card always shows, so a row reads as one that scrolls.
- In forced colors (Windows High Contrast), a picked chip keeps its label, in system colors.

## How it works

`feed.ts` builds Home around the engine; `use-home-feed.ts` runs it as TanStack Queries.

1. **Profile:** the top 400 tracks, 120 artists and 60 tags of the affinity, the tracks' cached metadata and the 200 latest distinct plays, with the affinity of those that miss the top (a song the user skips at once has skips, no affinity, so it never makes it), read through the library repository.
2. **First pass:** the user's own shelves (On repeat, Rediscover, and Discover and the mixes kept from earlier builds) from the library alone. Home shows them at once, with a placeholder where the recommendations will go, while the sources are asked.
3. **Seeds:** the engine's `planSeeds`. An artist seed known only by name (an onboarding pick) gets YouTube Music's own artist first (`catalog.findArtist`, only an artist of the same name), because YouTube Music's radio needs it.
4. **Candidates:** `recommendations.collect` for each seed and its parts, three seeds at a time. Each whole collection is cached for 30 minutes, per recommendation sources object.
5. **The rest of the taste:** the affinity of every track and main artist the candidates name and the profile lacks (`completeProfile`: two bulk reads), so the skip penalty and the history filters see all of the history, not only its top.
6. **Expansions:** the engine's `planExpansions` picks up to four similar artists (`catalog.artistTracks`) and six song searches (`catalog.findSong`) to turn into tracks.
7. **Spotify:** `spotifyAccount.status`, and when connected, `recommendations.home`'s Spotify sections, asked alongside the collections.
8. **Shelves:** `buildHome`, with the local time zone.

The network steps get eight seconds in all (`FEED_LIMITS.deadlineMs`); Home is then built from what arrived, and what is still on its way goes on and is cached for the next build. A source that fails adds nothing, and only leaving the page cancels a build.

**Lists kept for their period.** Discover and the Daily Mixes are kept in `localStorage` (`fxm.home.stable.v1`) for their week and day, read back through `sanitizeStableShelves`. Only a build that heard from every source in time keeps them, so a thin list made while a source failed doesn't last the week, and builds without the sources (the Free-only tier) keep none. They are kept with the listening history they came from, as the time it starts (`historyStart`): clearing the history, replacing the library from a backup or importing older plays changes it, and Home forgets them.

**The query.** A built Home is kept for ten minutes (two, when a source missed it), so the shelves don't reshuffle while the user plays from them, and stays cached for half an hour after leaving Home. It is rebuilt at once when the catalog mode, the tier, the Spotify switch, the services, the onboarding picks or the start of the listening history (a live query) change.

## Wiring in the other stages

Home reaches everything through one seam, `services.tsx` (`appHomeServices`, a store like 2.4's `appActions`). Until the parts are wired in, Home is the Free-only tier with no recommendation sources: the user's own shelves and the note.

| Part | From | Wire in (e.g. in `main.tsx`) |
|---|---|---|
| `sources` | 2.4's `appSources`, which holds 1.2's platform and the Spotify switch | `sources: appSources` |
| `recommendations` | 3.2's `createRecommendationCollector({ youtube, youtubeLookup, spotify, spotifyMetadata, spotifyEnabled, lastfmStations, listenbrainz, … })` with 1.3's and 1.5's providers | `recommendations: collector` (it fits the seam as it is; `feed.collector.test.ts` checks) |
| `catalog` | 1.3: artist search (`findArtist`), artist pages' top songs (`artistTracks`); 1.7: song search (`findSong`) | `catalog: { findArtist, artistTracks, findSong }` |
| `spotifyAccount` | 1.5's Spotify provider (`status`), connected by 3.5 | `spotifyAccount: spotify` |
| `playback` | 2.2's player, as 2.4's `PlaybackActions` | `playback: appActions.get().playback` |

```ts
appHomeServices.set({ sources: appSources, recommendations: collector, catalog, spotifyAccount: spotify, playback })
```

Album, artist and playlist cards (in Spotify's sections) link to `/<kind>/<source>:<native ID>`, the form of 2.4's pages (`entityPath` in `shelves.tsx`).

## Development

In `make dev`, `?fake-home=lite` or `?fake-home=full` plugs fake services into Home (`dev-fakes.ts`: an invented catalog, no network, no artwork); the tab keeps the choice until `?fake-home=off`. Restore `e2e/fixtures/library-backup.json` from the Library page to see the user's own shelves too. Builds with `VITE_FXM_FAKE_CATALOG=on` (2.4's screenshot builds) include the fakes; production builds leave them out. The end-to-end checks of Home with recommendations, and its onboarding's forced-colors screenshot, need such a build: `VITE_FXM_FAKE_CATALOG=on pnpm --filter @fxm/web e2e`.

## Files

| File | What |
|---|---|
| `home-page.tsx` | The page and its greeting, which ship with the shell, and on phones the install offer of stage 5.1 (`InstallCard`); the rest loads as a chunk of its own, so the library database and the engine don't weigh on the first load |
| `home-content.tsx`, `home-skeleton.tsx` | The notes, the onboarding, the shelves, Your artists and the mix dialog, and where focus goes; Home while it loads |
| `shelves.tsx` | Shelf sections, song cards and lines, mix cards, a service's section |
| `onboarding.tsx` | The onboarding (for the cold start, and to change the picks), its reminder, and Your artists |
| `feed.ts`, `use-home-feed.ts` | Building Home in two passes, and its queries |
| `services.tsx` | The seam to the other stages, its store and React context |
| `taste-store.ts`, `stable-storage.ts` | The onboarding picks, and the lists kept for their period |
| `dev-fakes.ts`, `testing.tsx` | The development fakes and the test helpers |

## Tests

`feed.test.ts` builds Home from a real library (fake IndexedDB) with fake services: each tier, the Spotify rules, expansions, artist seeds found by name, the collection cache, Discover kept for its week and forgotten with the history, lists kept only from a whole build, a song skipped at once and one played long ago outside the profile's window, a failing source, a source that doesn't answer in time, the first pass, and cancellation (also while a source is silent). `taste-store.test.ts` and `stable-storage.test.ts` cover what is kept in `localStorage`, corrupt and blocked storage included. `feed.collector.test.ts` does the same with stage 3.2's real collector over its fakes. `home-page.test.tsx` renders the whole app: the Free-only welcome and note, the user's own shelves while the sources are silent, the onboarding from suggestions and typed names to built shelves, artists listed once with their IDs, "Not now", where focus goes, changing and clearing the picks (also while Home is still being built), playback with each shelf's context, the mix dialog and Spotify's sections. `shelves.test.tsx` checks when a focused song scrolls into view. All offline. In `e2e/smoke.spec.ts`, every row of Home that scrolls must be reachable from the keyboard.
