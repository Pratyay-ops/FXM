# Recommendation sources

`@fxm/sources/recommend` asks every recommendation source that can run for a seed (a track or an artist) and turns their answers into **one candidate format** for the recommendation engine (stage 3.3). It also fills tracks' artwork gaps. Everything runs on the user's device, through the injected `ctx.fetch`, and follows the catalog mode, the tier and the user's Spotify switch.

```ts
import { createArtworkFiller, createRecommendationCollector } from '@fxm/sources/recommend'

const collector = createRecommendationCollector({ youtube, youtubeLookup, spotify, spotifyMetadata, lastfmStations, listenbrainz })
const { candidates, outcomes } = await collector.collect(seedTrack, ctx, { deadlineMs: 8_000 })
const { shelves } = await collector.home(ctx)

const artwork = createArtworkFiller({ coverArt, listenbrainz, itunes })
const track = await artwork.fill(candidateTrack, ctx)
```

## The sources

`collect(seed, ctx, { parts, limit, deadlineMs, onResult })` runs these at once, at most `limit` (50) candidates each. A source that can't run, fails or misses the deadline adds nothing and says why in `outcomes`; only a cancelled `ctx.signal` rejects, at once, whether or not the sources heed it.

| Source | Part | Free only | Lite | Full | Needs |
|---|---|---|---|---|---|
| YouTube Music radio | `radio` | — | ✅ | ✅ | The YouTube Music provider (1.3) |
| Spotify radio | `radio` | — | — | ✅ | The Spotify provider (1.5), Spotify switched on |
| Spotify related artists | `similar-artists` | — | — | ✅ | The same |
| Last.fm's similar-artists station | `station` | — | — | ✅ | — |
| Last.fm similar artists | `similar-artists` | ✅ | ✅ | ✅ | A Last.fm API key |
| ListenBrainz similar artists | `similar-artists` | ✅ | ✅ | ✅ | — |

The tiers come from `ctx.capabilities`: YouTube runs unless `youtube` is `none`; Spotify unless `spotify` is `unreachable` or the user's switch is off (`spotifyEnabled`, by default the Spotify provider's own `isAvailable`); Last.fm's stations only where the station reader's `isReachable(ctx)` says so, which is the one check (by default `youtube: 'full'`: FXM Connect, the desktop app, the Android app).

**Catalog modes.** In Music mode, and in any mode the collector doesn't know (it fails closed, as core's `modePolicy` does), radio and recommendations hold songs only:

- **YouTube Music radio** is seeded with a song. An official music video seeds with its song: the one it links, else the one the video-to-song rule finds (`songForVideo`, at any band but `none`: a guess only steers the radio). A seed YouTube Music can't start from as it is (a Spotify or Archive track, an artist from Spotify, Last.fm or ListenBrainz) goes to the `youtubeSeed` adapter; without either, YouTube Music sits this one out (`unsupported-seed`), as it does for other videos. Its results are filtered to songs.
- **Spotify** tracks are songs, so they stay (they are matched to audio when they play, by the playback policy).
- **Last.fm's station** names songs with YouTube videos, which Music mode must classify before anything is queued. The collector looks up each video (`youtubeLookup`), at most `maxClassifications` (8) calls per station, only while the budget allows (`classificationBudget`), at the budget's priority, and for at most `maxClassificationMs` (6 s), after which the call in flight is cancelled:
  - a song becomes a track candidate;
  - an official video becomes its linked song (`match: { via: 'link' }`), or, while the user's Auto setting is on (`autoMatch`), the song the video-to-song rule maps it to at the `auto` band, with the verdict kept (`match: { via: 'match', verdict }`), so that the player applies the setting again at play time with `effectiveMatchBand`;
  - the song must be the one the station names, by its artist (by name: a tribute or karaoke act named after the artist doesn't count), with its title and version (`namesSameSong`): Last.fm's video links are suggested by its users;
  - everything else becomes a **song search** (`song-search` candidate): the station's artists and title, which Last.fm knows, for the engine to find through YouTube Music's song search. That covers items beyond the budget or the time (they keep `youtubeId`), items whose lookup failed (they keep it too), and items whose video turned out to be an upload, another recording, gone, or an official video without a song FXM may play unasked (the video is dropped, the song stays).

  Every lookup, linked-song lookup and video-to-song call counts against the allowance. A refusal from the budget (`RateLimited`), a bot check or a network error stops classifying; the rest become song searches.

In Music + Video mode, radio keeps every kind but episodes, and Last.fm's videos play as they are, as `yt` videos.

**Seeds.** A seed is a `Track` or an `ArtistSeed` (an artist, with its `mbid` when known: an `ArtistCandidate`'s `artist` can be passed back as it is). Sources read the seed's main artist without YouTube's channel suffixes ("RadioheadVEVO", "Radiohead - Topic"), and a track's title proper. Spotify's related artists start from the seed's own Spotify artist, else from an artist search for its name, which must match exactly. ListenBrainz uses the seed's MBID, else finds a track's artist through its own lookup, else asks the `artistMbid` adapter for an artist. Every source leaves out the seed's own artist from similar artists.

**Progress and deadlines.** `onResult(result)` gets each source's `{ outcome, candidates }` as soon as it has them, for screens that show what is ready. `deadlineMs` bounds the whole call: sources still running then are cancelled (their requests abort) and reported as `timed-out`, and the call resolves with what the others found. `home(ctx, { deadlineMs, onResult })` takes the same options.

**Limits are read defensively.** A `limit` that is not a finite number means 50, and others are rounded down to 0 or more (0 asks nothing); a `maxClassifications` that is not a whole number of at least 0 means 8; a budget allowance that is not a number counts as 0.

## The candidate format

Every candidate (`RecommendationCandidate`) says where it came from and how strongly:

| Field | Meaning |
|---|---|
| `source`, `part` | The service (`ytm`, `spotify`, `lastfm`, `listenbrainz`) and the call (`radio`, `station`, `similar-artists`: a `CandidatePart`) |
| `seed` | The seed: `{ type, id?, name, artists? }` |
| `rank` | Its position in the source's list, from 0 |
| `score` | From 0 to 1: the source's own similarity where it gives one (Last.fm's `match`, ListenBrainz's score relative to the best), else from the rank (the first of `n` gets 1, the last `1/n`). Comparable within one list only |
| `key` | The same for every listing of one song (main artist and title proper, normalized, versions folded) or one artist, for grouping across sources. A name of symbols only, such as the band "!!!", keeps a key of its own |
| `attributionUrl` | The source's page to link to, for Last.fm, whose terms ask for it |

and is one of three types:

- `track`: a `Track` that passes the mode's list filter, with `match` when it is the song of a video the source linked (see above).
- `song-search`: a song known by `title`, `artists` and maybe `youtubeId` only, for the engine to search for when it needs it.
- `artist`: a `CandidateArtist` (`name`, a Spotify `id`, an `mbid`, `artwork`), for the engine to turn into songs.

Candidates come grouped by source, in each source's order, and are not de-duplicated across sources: that, the scoring, MMR diversity and the history filter are the engine's (3.3).

`outcomes` lists each source and part:

| `status` | Extra fields | When |
|---|---|---|
| `ok` | `count` | It ran |
| `skipped` | `reason` | The collector's own checks: `not-configured`, `switched-off`, `unreachable`, `needs-full-tier`, or `unsupported-seed` (no artist name, no MBID, no YouTube seed, no Spotify artist found). A provider's refusal is a skip only when it is explicitly about the seed or the switch: Spotify's `unsupported-seed`, `disabled` and `unreachable` |
| `failed` | `code`, `message`, `error` | Anything else it threw, `Unsupported` included: a closed transport route (`isRouteUnavailable(error)`, with `needs` and `connectFeature` to offer the fix), Spotify's `client-rejected` or `operation-unsupported`, the budget's refusal (`isBudgetError(error)`) |
| `timed-out` | `afterMs` | It had not finished at the deadline |

## Home feeds

`home(ctx)` collects the home feeds of YouTube Music and of Spotify (when it is on and reachable), with each shelf's tracks filtered to the mode like radio, and shelves left empty dropped. A home feed has no seed, so every `Unsupported` refusal of one is a failure.

## Artwork

`createArtworkFiller({ coverArt, listenbrainz, releaseMbid, itunes })` fills gaps for any track. `artworkFor(track, ctx, { priority })` returns `{ artwork, source, pageUrl }` or `null`, and `fill(track, ctx)` returns a track that has covers as it is, else the track with the cover found. It looks, in order, for:

1. **The Cover Art Archive**'s front cover of the track's MusicBrainz release (`source: 'coverartarchive'`, `pageUrl` the MusicBrainz release): the release from the `releaseMbid` adapter (trusted as the track's own), else from ListenBrainz's lookup of the main artist and the title, which must find the **same version** (by its strong version tags; a version is looked up by its whole title, e.g. "Love Story (Taylor's Version)") on a release that is the album the track names, if it names one.
2. **iTunes Search** (`source: 'itunes'`, `pageUrl` the store page for the badge Apple's terms want): the track's album, else the song, matched strictly (see [its README](../itunes/README.md)).

A gap stays a gap rather than showing another record's cover: a live take, an acoustic version or a re-recording never gets the studio album's cover, and a release that is not the track's album is not used at all. Sources that fail are skipped; results are cached for 24 hours, and misses for 6 hours unless a source failed, keyed on the song, its versions and its album. Pass `priority: 'bulk'` when filling a list in the background: every request then waits behind the cover the user is looking at. iTunes is optional: see Apple's terms in its README.

## Wiring

Each touch-point with another stage is in [`adapters.ts`](adapters.ts), as a core type or a small interface, with a fake in `@fxm/sources/recommend/testing`. Stages 1.2, 1.3, 1.5 and 1.7 have merged; whoever builds the collector (stage 3.3) passes the real ones, roughly:

```ts
import { matchVideoToSong, videoSongsQuery } from '@fxm/core'
import { createLastfmStations, LASTFM_STATION_PREFIX } from '@fxm/sources/lastfm'
import { createListenBrainzClient } from '@fxm/sources/listenbrainz'
import { createSpotifyProvider } from '@fxm/sources/spotify'
import { createYouTubeProviders } from '@fxm/sources/youtube'

const { music: ytm } = createYouTubeProviders({ session })                // 1.3
const spotify = createSpotifyProvider({ isEnabled: () => settings.spotify.enabled }) // 1.5
const listenbrainz = createListenBrainzClient()                           // share it with the artwork filler

const collector = createRecommendationCollector({
  youtube: ytm,                 // radio, home
  youtubeLookup: ytm,           // getTrack classifies a videoId: one InnerTube call
  youtubeSeed: async (seed, ctx) => /* 1.7: matchTrack over a YouTube Music search, or the match cache */ null,
  spotify,                      // radio, home; its isAvailable is the switch
  spotifyMetadata: spotify,     // search, getRelatedArtists
  classificationBudget: {       // 1.2
    allowance: () => platform.budget.snapshot().remaining - BUDGET_DEFAULTS.reserves.interactive,
    context: (ctx) => platform.context({ mode: ctx.mode, priority: 'prefetch' }),
  },
  songForVideo: async (video, ctx) => {                                   // 1.7, one songs search
    const songs = (await ytm.search(videoSongsQuery(video), { types: ['track'] }, ctx)).tracks?.items ?? []
    const match = matchVideoToSong(video, songs)
    const song = songs.find((track) => track.id === match.songId)
    if (match.via === 'none' || song === undefined) return null
    return { song, via: match.via, ...(match.best?.verdict ? { verdict: match.best.verdict } : {}) }
  },
  autoMatch: () => settings.matching.auto,
  lastfmStations: createLastfmStations({
    reachable: () => platform.transport.canReach(LASTFM_STATION_PREFIX), // knows Connect's lastfm feature
  }),
  listenbrainz,
  // artistMbid: stage 1.6 has no artist search yet; artist candidates carry their MBIDs.
  // Only with a Last.fm API key, which FXM doesn't ship (see the Last.fm README):
  ...(lastfmKey === undefined ? {} : { lastfmApi: createLastfmApiClient({ apiKey: lastfmKey }) }),
})
```

Every InnerTube call the YouTube Music provider makes draws on the request budget through `ctx.fetch` (1.2's transport); `classificationBudget` lets the collector stop before the budget starts refusing and makes classification draw at `prefetch` instead of the priority radio was asked at.

## Hosts

This module makes FXM contact these hosts. The web app's CSP (2.8) and the site's privacy page need them:

| Service | `connect-src` | `img-src` | Privacy page |
|---|---|---|---|
| Last.fm stations (Full tier) | `https://www.last.fm` | — | Last.fm: recommendations and radio |
| Last.fm API (with a key) | `https://ws.audioscrobbler.com` | — | The same entry |
| ListenBrainz labs | `https://labs.api.listenbrainz.org` | — | ListenBrainz: recommendations, and finding albums for cover art |
| Cover Art Archive | `https://coverartarchive.org`, `https://archive.org`, `https://*.archive.org` (its redirects) | `https://coverartarchive.org https://archive.org https://*.archive.org` | Cover Art Archive: album covers |
| iTunes Search | `https://itunes.apple.com` | `https://*.mzstatic.com` | Apple's iTunes Search: album covers |

The platform's host table (1.2) already lists every `connect-src` host above. `api.listenbrainz.org` and `lastfm.freetls.fastly.net`, which the plan's 2.8 notes list for this stage, are not contacted: ListenBrainz's main API needs a token, and Last.fm's artist images are placeholders FXM leaves out.

## Layout

The provider clients (`lastfm`, `listenbrainz`, `coverart`, `itunes`) depend only on `shared/` (`gate.ts`: pacing, priorities and the wait limit; `http.ts`: text requests with a size cap; `names.ts`: name matching, also LRCLIB's; `mbid.ts`; `numbers.ts`), and this module depends on them, never the other way round.

## Tests

`*.test.ts` run offline with the fakes in `testing/`, and with the providers' recorded fixtures through a fake network (`fakeFetch`, from `shared/fake-network.ts`). They cover each tier, both modes and an unknown one, the Spotify switch, classification within the budget, its time limit and the match verdicts, versioned artwork, failures, deadlines, progressive delivery and cancellation. The providers' own live tests run with `FXM_LIVE=1`.
