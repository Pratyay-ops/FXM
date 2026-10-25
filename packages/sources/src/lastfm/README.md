# Last.fm

`@fxm/sources/lastfm` reads two things from [Last.fm](https://www.last.fm), on the user's device and only through the injected `ctx.fetch`:

- **Stations**, keyless: the playlists behind the play buttons on Last.fm's own pages. Each song names its artists, its title and usually a YouTube video. **Full tier only.**
- **Similar artists**, from the Last.fm API, on every tier, **with an API key**.

```ts
import { createLastfmApi, createLastfmStations } from '@fxm/sources/lastfm'

const stations = createLastfmStations()
const songs = await stations.station({ type: 'similar', artist: 'Radiohead' }, ctx)

const api = createLastfmApi({ apiKey }) // only when the app has a key
const artists = await api.similarArtists('Radiohead', ctx)
```

Station songs are not tracks yet: their YouTube videos are unclassified, and in Music mode only songs may play. The recommendation collector ([`@fxm/sources/recommend`](../recommend/README.md)) turns them into candidates, classifying each video within the request budget. Where each fact comes from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).

## Stations

`stations.station({ type, artist }, ctx)` fetches one of the stations Last.fm's artist pages offer:

| `type` | Path | What it holds |
|---|---|---|
| `artist` | `/player/station/music/<artist>` | The artist's popular songs (30 for Radiohead) |
| `similar` | `/player/station/music/<artist>/+similar` | Songs by the artist and similar artists (24 by about 20 artists), a new mix each time |

Each song comes back as a `LastfmStationTrack`: `title`, `artists`, `durationMs` when known, `youtubeId` when Last.fm links a video, and `url`, the song's Last.fm page. Songs without a title or an artist are skipped, and a song listed twice is kept once.

**Only the Full tier reaches them.** The answers carry no CORS headers, so a web page can read them only through FXM Connect, whose `lastfm-station` rule adds them, or from the desktop and Android apps. `lastfmStationsReachable(capabilities)` says whether the platform can (`youtube: 'full'`), and `station()` refuses with `Unsupported`, without a request, everywhere else. The request is a plain `GET` without headers, as Connect's rule requires, with `credentials: 'omit'`.

**Tag stations are left out.** Last.fm's tag pages have stations too (`/player/station/tag/<tag>`), but on 2026-10-26 they answered with Last.fm's JavaScript challenge page instead of JSON.

### Being a quiet client

Last.fm answers clients it suspects with a "Client Challenge" page, a check that only a browser running Last.fm's script passes. So one reader:

- sends its station requests one at a time, at least `minIntervalMs` (2 s) apart;
- takes a challenge page (`200 text/html`, or `403`) as a `BotCheck` and then stops asking for `challengeBackoffMs` (15 minutes): calls fail at once with `BotCheck`;
- honours `429` with `Retry-After`, plus up to 30 % jitter: calls fail with `RateLimited` until then.

A station is never cached: each request is a new mix.

## Similar artists

`api.similarArtists(name, ctx, { limit })` calls `artist.getSimilar` with `autocorrect=1`, so Last.fm corrects misspellings. Each artist has `name`, `mbid` when Last.fm knows it, `match` (0 to 1) and `url`, its Last.fm page. Last.fm's artist images are left out: they are placeholders.

**The key.** The API needs an API key, and FXM ships none. The app passes one from its configuration or the user's settings; without one, don't create the client (the collector reports `not-configured`). Never commit a key: the live test reads it from `FXM_LASTFM_API_KEY`. Before FXM ships a key of its own, the owner should weigh Last.fm's [API terms](https://www.last.fm/api/tos) (checked 2026-10-26, see the clean-room log): non-commercial use only; credit Last.fm and link to its pages; clause 2.6, under which a key holder "must not gather any other data from Last.fm in any other way", which sits uneasily with the keyless stations; and clause 4.7, on use "in conjunction with the unauthorised exploitation of intellectual property".

Answers are cached in memory for as long as Last.fm's `Cache-Control` says (between 10 minutes and 24 hours; 6 hours when it says nothing), as the terms ask, and an unknown artist for an hour. Requests go one at a time, 250 ms apart.

## Attribution

Last.fm's terms ask apps that show its data to credit Last.fm and link to its catalogue pages. Every station song and similar artist carries its page in `url`, and the collector passes it on as `attributionUrl`. The screens that show these recommendations (stage 3.3) should link to it and name Last.fm.

## Errors

| Code | When |
|---|---|
| `Unsupported` | A station outside the Full tier |
| `BotCheck` | Last.fm answered a station request with its challenge page, or `403`; for the next 15 minutes as well |
| `RateLimited` | `429`, or API error 29. `retryAfterMs` says how long to wait |
| `AuthRequired` | The API refused the key: error 10 (invalid) or 26 (suspended) |
| `Network` | The request failed, broke off or took longer than `timeoutMs` (10 s) |
| `Unavailable` | Any other HTTP error, or API errors such as 11 (offline) and 16 (temporary error) |
| `Parse` | An answer FXM can't read |

An artist Last.fm doesn't know gives an empty list: a station `404`, or API error 6. A cancelled `ctx.signal` rejects with its reason.

## Tests

- **`station.test.ts`, `api.test.ts`:** offline, against `fixtures/`. The stations are real answers recorded on 2026-10-26, trimmed to the fields FXM reads plus two it ignores. The challenge page is trimmed too. `api-similar-artists-synthetic.json` is **not a recording**: without a key, it follows the documented format, with names and MBIDs from ListenBrainz and made-up `match` values.
- **`live.test.ts`:** runs only with `FXM_LIVE=1`, in two requests: the similar station for Radiohead (and that it has no CORS headers), and the API's CORS headers and keyless error. With `FXM_LASTFM_API_KEY` set, a third request checks `artist.getSimilar` itself.

  ```sh
  FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/lastfm/live.test.ts
  ```
