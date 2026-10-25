# Home (stage 3.3)

The Home page: shelves of music built on this device from what the user plays (stage 3.1's listening affinity) and what the recommendation sources suggest (stage 3.2), ranked by the engine in `@fxm/core` ([its README](../../../../../packages/core/src/recommend/README.md)). Nothing leaves the device but the sources' own requests.

## What the user gets

| Shelf | What it holds |
|---|---|
| **Quick picks** | Favourites and new songs for right now, in columns of four that scroll sideways; nothing played in the last 12 hours |
| **Daily Mixes** | One card per cluster of the user's top artists: about half favourites, half new songs, changing once a day. A card opens the mix's songs, with Play |
| **Discover** | Songs the user never played, by artists they hardly know, changing every Monday |
| **Because you listened to X** | What the sources suggest for a recent play, new to the user (up to three shelves) |
| **On repeat** | The songs played most lately |
| **Rediscover** | Songs the user loved a while ago and hasn't played for a month |
| **Spotify's sections** | A connected Spotify account's personal home, only when Spotify is switched on, reachable and connected (stage 3.5 connects it) |

Every song plays its shelf from that song, with the shelf as the queue's context ("Playing from Quick picks"; a Because shelf plays as the seed's radio), once playback is wired in. No song shows on two shelves (the mixes are lists of their own).

**The cold start.** While FXM knows fewer than three artists the user likes, Home asks: *What do you like to listen to?* The user picks three or more artists (those they follow, and the popular artists of the services' home feeds where those can be reached, e.g. Spotify's for the user's market) or types any, plus any genres. The picks stay on this device (`localStorage`, `fxm.home.taste.v1`) and count like likes, so they seed the first mixes and Discover and fade as real listening takes over. "Not now" puts it off; a small card brings it back.

### Tiers

| | Free only | Lite | Full |
|---|---|---|---|
| On repeat, Rediscover (the user's own music) | ✅ | ✅ | ✅ |
| Recommendations: Quick picks, Daily Mixes, Discover, Because you listened | — (a note says how to get them) | ✅ YouTube Music radio, ListenBrainz | ✅ also Spotify radio and related artists, Last.fm's station |
| The onboarding | — | ✅ | ✅ |
| A connected Spotify account's sections | — | — | ✅ |

New music comes only where YouTube Music is reachable, because its songs are what plays (`canRecommend`). The collector applies the other rules of each source (stage 3.2).

## How it works

`feed.ts` builds Home around the engine; `use-home-feed.ts` runs it as a TanStack Query, kept for ten minutes so the shelves don't reshuffle while the user plays from them, and rebuilt at once when the catalog mode, the tier, the Spotify switch, the services or the onboarding picks change.

1. **Profile:** the top 400 tracks, 120 artists and 60 tags of the affinity, the tracks' cached metadata and the 200 latest distinct plays, read through the library repository.
2. **Seeds:** the engine's `planSeeds`. An artist seed known only by name (an onboarding pick) gets YouTube Music's own artist first (`catalog.findArtist`, only an artist of the same name), because YouTube Music's radio needs it.
3. **Candidates:** `recommendations.collect` for each seed and its parts, three seeds at a time. Each collection is cached for 30 minutes, per recommendation sources object.
4. **Expansions:** the engine's `planExpansions` picks up to four similar artists (`catalog.artistTracks`) and six song searches (`catalog.findSong`) to turn into tracks.
5. **Spotify:** `spotifyAccount.status`, and when connected, `recommendations.home`'s Spotify sections.
6. **Shelves:** `buildHome`, with the local time zone. Discover and the Daily Mixes are kept in `localStorage` (`fxm.home.stable.v1`) for their week and day, read back through `sanitizeStableShelves`.

A source that fails adds nothing; only leaving the page cancels a build.

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

In `make dev`, `?fake-home=lite` or `?fake-home=full` plugs fake services into Home (`dev-fakes.ts`: an invented catalog, no network, no artwork); the tab keeps the choice until `?fake-home=off`. Restore `e2e/fixtures/library-backup.json` from the Library page to see the user's own shelves too. Builds with `VITE_FXM_FAKE_CATALOG=on` (2.4's screenshot builds) include the fakes; production builds leave them out.

## Files

| File | What |
|---|---|
| `home-page.tsx` | The page and its greeting, which ship with the shell; the rest loads as a chunk of its own, so the library database and the engine don't weigh on the first load |
| `home-content.tsx`, `home-skeleton.tsx` | The notes, the onboarding, the shelves and the mix dialog; Home while they load |
| `shelves.tsx` | Shelf sections, song cards and lines, mix cards, a service's section |
| `onboarding.tsx` | The cold-start onboarding and its reminder |
| `feed.ts`, `use-home-feed.ts` | Building Home, and its query |
| `services.tsx` | The seam to the other stages, its store and React context |
| `taste-store.ts`, `stable-storage.ts` | The onboarding picks, and the lists kept for their period |
| `dev-fakes.ts`, `testing.tsx` | The development fakes and the test helpers |

## Tests

`feed.test.ts` builds Home from a real library (fake IndexedDB) with fake services: each tier, the Spotify rules, expansions, artist seeds found by name, the collection cache, Discover kept for its week, a failing source and cancellation. `taste-store.test.ts` and `stable-storage.test.ts` cover what is kept in `localStorage`, corrupt and blocked storage included. `feed.collector.test.ts` does the same with stage 3.2's real collector over its fakes. `home-page.test.tsx` renders the whole app: the Free-only note, the onboarding from suggestions and typed names to built shelves, "Not now", playback with each shelf's context, the mix dialog and Spotify's sections. All offline.
