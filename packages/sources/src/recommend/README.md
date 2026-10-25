# Recommendation sources

`@fxm/sources/recommend` asks every recommendation source that can run for a seed (a track or an artist) and turns their answers into **one candidate format** for the recommendation engine (stage 3.3). It also fills tracks' artwork gaps. Everything runs on the user's device, through the injected `ctx.fetch`, and follows the catalog mode, the tier and the user's Spotify switch.

```ts
import { createArtworkFiller, createRecommendationCollector } from '@fxm/sources/recommend'

const collector = createRecommendationCollector({ youtube, youtubeLookup, spotify, spotifyMetadata, lastfmStations, listenbrainz })
const { candidates, outcomes } = await collector.collect(seedTrack, ctx)
const { shelves } = await collector.home(ctx)

const artwork = createArtworkFiller({ coverArt, listenbrainz, itunes })
const track = await artwork.fill(candidateTrack, ctx)
```

## The sources

`collect(seed, ctx, { parts, limit })` runs these at once, at most `limit` (50) candidates each. A source that can't run, or fails, adds nothing and says why in `outcomes`; only a cancelled `ctx.signal` rejects.

| Source | Part | Free only | Lite | Full | Needs |
|---|---|---|---|---|---|
| YouTube Music radio | `radio` | — | ✅ | ✅ | The YouTube Music provider (1.3) |
| Spotify radio | `radio` | — | — | ✅ | The Spotify provider (1.5), Spotify switched on |
| Spotify related artists | `similar-artists` | — | — | ✅ | The same |
| Last.fm's similar-artists station | `station` | — | — | ✅ | — |
| Last.fm similar artists | `similar-artists` | ✅ | ✅ | ✅ | A Last.fm API key |
| ListenBrainz similar artists | `similar-artists` | ✅ | ✅ | ✅ | — |

The tiers come from `ctx.capabilities`: YouTube runs unless `youtube` is `none`, Spotify unless `spotify` is `unreachable` or the user's switch (`spotifyEnabled`, on by default) is off, and Last.fm's stations only with `youtube: 'full'` (FXM Connect, the desktop app, the Android app).

**Catalog modes.** In Music mode, radio and recommendations hold songs only:

- **YouTube Music radio** is seeded with a song. An official music video seeds with its song: the one it links, else the one the video-to-song rule finds (`songForVideo`); without either, YouTube Music sits this one out (`unsupported-seed`), as it does for other videos. Its results are filtered to songs.
- **Spotify** tracks are songs, so they stay (they are matched to audio when they play, by the playback policy).
- **Last.fm's station** names songs with YouTube videos, which Music mode must classify before anything is queued. The collector looks up each video (`youtubeLookup`, one InnerTube call from the request budget each), at most `maxClassifications` (8) per station and only while the budget allows (`classificationBudget`):
  - a song becomes a track candidate;
  - an official video becomes its song, the linked one or the rule's;
  - the song must be the one the station names, by its artist, with its title and version (`namesSameSong`): Last.fm's video links are suggested by its users;
  - everything else becomes a **song search** (`song-search` candidate): the station's artists and title, which Last.fm knows, for the engine to find through YouTube Music's song search. That covers items beyond the budget, items whose lookup failed (they keep `youtubeId`), and items whose video turned out to be an upload, another recording or gone (the video is dropped, the song stays).

  A refusal from the budget (`RateLimited`), a bot check or a network error stops classifying; the rest become song searches.

In Music + Video mode, radio keeps every kind but episodes, and Last.fm's videos play as they are, as `yt` videos.

**Seeds.** Sources read the seed's main artist without YouTube's channel suffixes ("RadioheadVEVO", "Radiohead - Topic"), and a track's title proper. Spotify's related artists start from the seed's own Spotify artist, else from an artist search for its name, which must match exactly. ListenBrainz finds a track's artist through its own lookup; an artist seed needs its MusicBrainz ID from the `artistMbid` adapter. Every source leaves out the seed's own artist from similar artists.

## The candidate format

Every candidate (`RecommendationCandidate`) says where it came from and how strongly:

| Field | Meaning |
|---|---|
| `source`, `part` | The service (`ytm`, `spotify`, `lastfm`, `listenbrainz`) and the call (`radio`, `station`, `similar-artists`) |
| `seed` | The seed: `{ type, id?, name, artists? }` |
| `rank` | Its position in the source's list, from 0 |
| `score` | From 0 to 1: the source's own similarity where it gives one (Last.fm's `match`, ListenBrainz's score relative to the best), else from the rank (the first of `n` gets 1, the last `1/n`). Comparable within one list only |
| `key` | The same for every listing of one song (main artist and title proper, normalized, versions folded) or one artist, for grouping across sources |
| `attributionUrl` | The source's page to link to, for Last.fm, whose terms ask for it |

and is one of three types:

- `track`: a `Track` that passes the mode's list filter.
- `song-search`: a song known by `title`, `artists` and maybe `durationMs` and `youtubeId` only, for the engine to search for when it needs it.
- `artist`: a `CandidateArtist` (`name`, a Spotify `id`, an `mbid`, `artwork`), for the engine to turn into songs.

Candidates come grouped by source, in each source's order, and are not de-duplicated across sources: that, the scoring, MMR diversity and the history filter are the engine's (3.3). `outcomes` lists each source and part as `ok` (with a count), `skipped` (`not-configured`, `switched-off`, `unreachable`, `needs-full-tier`, `unsupported-seed`) or `failed` (the `FxmError` code and message).

## Home feeds

`home(ctx)` collects the home feeds of YouTube Music and of Spotify (when it is on and reachable), with each shelf's tracks filtered to the mode like radio, and shelves left empty dropped.

## Artwork

`createArtworkFiller({ coverArt, listenbrainz, releaseMbid, itunes })` fills gaps for any track. `fill(track, ctx)` returns a track that has covers as it is; otherwise it looks, in order, for:

1. **The Cover Art Archive**'s front cover of the track's MusicBrainz release: from the `releaseMbid` adapter (MusicBrainz, stage 1.6), else from ListenBrainz's lookup of the main artist and title.
2. **iTunes Search**: the track's album, else the song, matched strictly (see [its README](../itunes/README.md)).

When ListenBrainz's release isn't the album the track names (a compilation, say), iTunes goes first and the archive's cover is the last resort. Sources that fail are skipped; results are cached for 24 hours, and misses for 6 hours unless a source failed. iTunes is optional: see Apple's terms in its README.

## Wiring

Stages 1.2, 1.3, 1.5, 1.6 and 1.7 were not merged when this module was written. Each touch-point is in [`adapters.ts`](adapters.ts), as a core type or a small interface, with a fake in `@fxm/sources/recommend/testing`. When those stages merge, whoever builds the collector (stage 3.3) passes the real ones:

```ts
const collector = createRecommendationCollector({
  youtube: youtubeMusicProvider,           // 1.3: RecommendationProvider (radio, home)
  youtubeLookup: youtubeMusicProvider,     // 1.3: getTrack classifies a videoId
  spotify: spotifyProvider,                // 1.5: RecommendationProvider (radio, home)
  spotifyMetadata: spotifyProvider,        // 1.5: search, getRelatedArtists
  spotifyEnabled: () => settings.spotify,  // the user's switch
  classificationBudget,                    // 1.2: e.g. { allowance: () => budget room above the prefetch reserve }
  fullTier,                                // 1.2: optional; default `youtube === 'full'`
  songForVideo,                            // 1.7: the video-to-song rule
  artistMbid,                              // 1.6: MusicBrainz artist search
  lastfmStations: createLastfmStations(),
  listenbrainz: createListenBrainzClient(),
  // Only with a Last.fm API key, which FXM doesn't ship (see the Last.fm README).
  ...(lastfmKey === undefined ? {} : { lastfmApi: createLastfmApi({ apiKey: lastfmKey }) }),
})
```

Every InnerTube call the YouTube Music provider makes draws on the request budget through `ctx.fetch` (1.2's transport), so classification needs nothing more than `classificationBudget`, which only lets the collector stop early, before the budget starts refusing.

## Hosts

This module makes FXM contact these hosts. The web app's CSP (2.8) and the site's privacy page need them:

| Service | `connect-src` | `img-src` | Privacy page |
|---|---|---|---|
| Last.fm stations (Full tier) | `https://www.last.fm` | — | Already named (recommendations) |
| Last.fm API (with a key) | `https://ws.audioscrobbler.com` | — | The same entry |
| ListenBrainz labs | `https://labs.api.listenbrainz.org` | — | Already named (recommendations); also used for artwork |
| Cover Art Archive | `https://coverartarchive.org` (redirects to `archive.org`, already listed) | `https://coverartarchive.org https://archive.org https://*.archive.org` | **New:** cover art for tracks without one |
| iTunes Search | `https://itunes.apple.com` | `https://*.mzstatic.com` | **New:** Apple's iTunes Search, cover art for tracks without one |

`api.listenbrainz.org` and `lastfm.freetls.fastly.net`, which the plan's 2.8 notes list for this stage, are not contacted: ListenBrainz's main API needs a token, and Last.fm's artist images are placeholders FXM leaves out.

## Tests

`*.test.ts` run offline with the fakes in `testing/`, and with the providers' recorded fixtures through a fake network (`fakeFetch`). The tests cover each tier, both modes, the Spotify switch, classification within the budget, failures and cancellation. The providers' own live tests run with `FXM_LIVE=1`.
