# MusicBrainz (`musicbrainz`)

A helper, not a playback source: it finds ISRCs and recordings in [MusicBrainz](https://musicbrainz.org) for the matching engine and for imports. It works in any browser without FXM Connect, and on every platform through the injected `ctx.fetch`.

```ts
import {
  createMusicBrainzClient,
  findExactIsrc,
  findExactIsrcs,
  findIsrcHint,
} from '@fxm/sources/musicbrainz'

const musicBrainz = createMusicBrainzClient()

// Exact: an ISRC-verified input for the matcher.
const exact = await findExactIsrc(musicBrainz, 'spotify:track:70LcF31zb1H0PyJoS1Sx1r', ctx)
// → { kind: 'exact', isrcs: ['GBAYE9200070'], recording: { lengthMs: 236666, … } }

// Fuzzy: a ranking hint only.
const hint = await findIsrcHint(musicBrainz, { title, artists, durationMs }, ctx)

// The other way round: recordings that carry an ISRC.
const recordings = await musicBrainz.lookupIsrc('GBAYE9200070', ctx)
```

## Exact path and fuzzy path

They differ in what the matching engine may do with the result (ARCHITECTURE.md §12):

| | Exact (`findExactIsrc`, `findExactIsrcs`) | Fuzzy (`findIsrcHint`) |
|---|---|---|
| How | The Spotify track's URL, `https://open.spotify.com/track/<id>`, looked up through MusicBrainz URL relationships (`/ws/2/url?resource=…&inc=recording-rels`), then the recording's ISRCs and length (`/ws/2/recording/<mbid>?inc=isrcs+artist-credits`) | A recording search by title (without version qualifiers) and main artist, within max(10 s, 5 %) of the duration when there is one (`/ws/2/recording?query=recording:"…" AND artist:"…" AND dur:[… TO …]`) |
| Picks | The one recording linked to the URL. None when no recording is linked, or more than one (the ISRC is then unsure) | Of the hits whose title core and artist fit and whose strong version tags (live, remix, acoustic…, also read from the disambiguation) are the track's: the one on the most releases, then the closest in length, then the best score |
| Result | `kind: 'exact'`: **counts as an ISRC-verified input** | `kind: 'hint'`: **only a hint for ranking**. It never makes a match play without asking and must not be stored as the track's ISRC |
| Cost | 2 requests (batch: 1 per 100 URLs plus 1 per 50 recordings) | 1 request |

The fuzzy path needs that rule because MusicBrainz scores many same-titled recordings 100 and lists live, compilation and soundtrack versions first: for Radiohead's "Creep" its first five hits were bootleg and live recordings, and the album recording (130 releases, ISRC GBAYE9200070) came sixth.

A recording can carry several ISRCs (different masterings or releases), and nothing says which one Spotify uses, so `isrcs` lists them all. `isrcs` is empty when MusicBrainz has none; the recording's length is still useful, e.g. for a data-export row without a duration. `spotifyTrackUrl()` accepts a bare Spotify ID, a `spotify:track:` URI (FXM's `EntityId` for it) and open.spotify.com URLs with locale segments, queries or fragments.

`findExactIsrcs` serves imports: one `/url` request takes up to 100 `resource` parameters, and the recordings' ISRCs come from one search by MBID per 50 (`rid:"…" OR rid:"…"`), with a lookup each for any recording the search index does not have yet.

## One request per second, shared

MusicBrainz allows each IP address one request per second on average, and declines **every** request with 503 while the rate is above that. So every request waits its turn in one `RequestQueue` that the whole app shares (`musicBrainzQueue`): tasks start one at a time, in order, at least a second apart from start to start. A request cancelled while it waits leaves the queue without using a turn.

MusicBrainz also answers 503 when its servers as a whole, or its search, are busy (`X-RateLimit-Zone: global` or `search`), with `Retry-After: 0`: three of thirteen requests got one on 2026-10-25, although they were sent at least 1.5 s apart. After a 503 the queue holds every request back for the `Retry-After` delay, at least a second, doubling with each further 503, and tries again; after 3 tries (`maxAttempts`) the call rejects with `RateLimited`. Separate browser tabs each have their own queue.

## User-Agent

MusicBrainz asks every client for a User-Agent naming the application, its version and a contact, and throttles anonymous ones. FXM's is `FXM/<version> ( https://github.com/Pratyay-ops/FXM )` (`MUSICBRAINZ_USER_AGENT`). Who sends it is a transport question, so it is the client's `userAgent` option:

| Platform (`ctx.platform`) | Default | Why |
|---|---|---|
| `web` | None of FXM's own | Chromium does not let page scripts set `User-Agent`, and where a browser does (Firefox), the header would cost a CORS preflight. The browser's own User-Agent is not one MusicBrainz counts as anonymous |
| `desktop`, `android` | `MUSICBRAINZ_USER_AGENT` | Their native HTTP sends whatever FXM sets |

`userAgent: '<string>'` sends that on every platform (only where the platform's `fetch` can), and `userAgent: false` never sends one.

## CORS (measured 2026-10-25)

Every answer carries `Access-Control-Allow-Origin: *`: 200s, 404s (`{"error":"Not Found"}`) and 503s alike. Requests from a web page send no headers and no credentials, so they never need a preflight.

## Caching and errors

Lookups (URLs, recordings, ISRCs) are kept for a day and searches for an hour, in memory; a 404 is kept too, since MusicBrainz data changes slowly. Concurrent identical requests share one.

| Situation | Result |
|---|---|
| Unknown URL or ISRC | No recordings (`[]`, `null`) |
| Unknown recording (`getRecording`) | `NotFound` |
| 503 after the last try | `RateLimited`, with the last wait |
| Other HTTP errors | `Unavailable` (429: `RateLimited`) |
| Unreachable, timed out (15 s by default) | `Network` |
| An answer that is not what the API documents | `Parse` |
| Not a Spotify track (`findExactIsrc`), not an ISRC (`lookupIsrc`) | `RangeError`, without a request |

## Tests

Offline tests use answers recorded on 2026-10-25 in `fixtures/`, trimmed to the fields FXM reads: the URL lookup for "Creep" (single, batch, and a batch with no match), its recording, its ISRC lookup, the fuzzy search (with every recording's releases), a search by MBID, a 404 and a 503 body. The queue's spacing, pauses and cancellation are tested with fake timers.

The live smoke test acts as the desktop app (FXM's User-Agent) and makes five requests at one per second:

```sh
FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/musicbrainz/live.test.ts
```
