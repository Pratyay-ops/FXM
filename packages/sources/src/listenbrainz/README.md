# ListenBrainz

`@fxm/sources/listenbrainz` reads [ListenBrainz](https://listenbrainz.org)'s labs API (`labs.api.listenbrainz.org`), on the user's device and only through the injected `ctx.fetch`. It needs no key and answers any origin, so it works on every tier, without FXM Connect.

```ts
import { createListenBrainzClient } from '@fxm/sources/listenbrainz'

const listenbrainz = createListenBrainzClient()
const lookup = await listenbrainz.lookupRecording('Radiohead', 'Creep', ctx)
const similar = await listenbrainz.similarArtists(lookup.artistMbids[0], ctx)
```

Where each fact comes from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).

## Calls

| Method | Endpoint | Gives |
|---|---|---|
| `lookupRecording(artistCredit, recording, ctx)` | `GET /acr-lookup/json` | The MusicBrainz recording, its artists' MBIDs (in credit order) and a release it is on, or `null`. ListenBrainz compares names without punctuation, accents or case |
| `similarArtists(artistMbid, ctx, { limit })` | `GET /similar-artists/json` | Artists whose music the same listeners play, most similar first, never the artist itself. `score` is ListenBrainz's own count; `similarity` is the score relative to the best, from 0 to 1 |

The recommendation collector uses both: the lookup finds the seed's artist MBID, which similar artists need. The artwork filler uses the lookup's release for the Cover Art Archive.

**Not used:** the main API's metadata lookup (`api.listenbrainz.org/1/metadata/lookup/`) and LB Radio both need a user token (401 without one). For an artist seed without a recording, the collector needs the artist's MBID from elsewhere (MusicBrainz, stage 1.6, through the `artistMbid` adapter).

**The data set.** `similarArtists` asks for `DEFAULT_SIMILAR_ARTISTS_ALGORITHM` (`session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30`), one of the six the labs form offered on 2026-10-26: listening sessions over about 20 years. The `algorithm` option picks another. Labs data sets can change without notice; a renamed one answers with an error (`Unavailable`), and the collector carries on without ListenBrainz.

## Being a good client

- Requests go one at a time, at least 200 ms apart.
- Lookups and similar artists are cached in memory for 24 hours (`cacheTtlMs`), and misses for an hour. A call that waited behind the same request gets its answer without asking again.
- A `429` holds every request back for `Retry-After` (or `X-RateLimit-Reset-In`, as ListenBrainz's main API sends), plus up to 30 % jitter; until then calls fail at once with `RateLimited`.

## Errors

| Code | When |
|---|---|
| `RateLimited` | `429`; `retryAfterMs` says how long to wait |
| `Network` | The request failed, broke off or took longer than `timeoutMs` (10 s) |
| `Unavailable` | Any other HTTP error, e.g. `500`, or `400` for an unknown data set |
| `Parse` | An answer that is not a JSON list |

A `404`, an empty answer and a value that isn't an MBID give `null` or an empty list. A cancelled `ctx.signal` rejects with its reason.

## Tests

- **`api.test.ts`:** offline, against `fixtures/`, real answers recorded on 2026-10-26 (similar artists trimmed to the first 25).
- **`live.test.ts`:** runs only with `FXM_LIVE=1`, in two requests: the lookup for Radiohead's "Creep" and Radiohead's similar artists, both with their CORS headers.

  ```sh
  FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/listenbrainz/live.test.ts
  ```
