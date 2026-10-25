# LRCLIB lyrics provider

`@fxm/sources/lrclib` is the `LyricsProvider` for [LRCLIB](https://lrclib.net), a free, open database of synced (LRC) and plain lyrics. It runs on the user's device and uses only the injected `ctx.fetch`.

```ts
import { createLrclibProvider } from '@fxm/sources/lrclib'

const lyricsProvider = createLrclibProvider()
const lyrics = await lyricsProvider.getLyrics(track, ctx) // Lyrics | null
```

The result is a core `Lyrics` with `source: 'lrclib'`, parsed by `parseLrc` (so `lineAt` works on it as is), and `metadata` (title, artist, album, length) from the LRCLIB record it came from.

## Works everywhere, without FXM Connect

LRCLIB answers every origin with `Access-Control-Allow-Origin: *` and exposes `Retry-After`. Its preflight allows `content-type`, `x-user-agent`, `lrclib-client`, `lrclib-app-id` and `lrclib-api-key`, but not `user-agent`. Both were checked live on 2026-10-25, and the live test checks them again. So the web app calls LRCLIB directly, with or without FXM Connect, and so do the desktop and Android apps.

## What is sent

Each request is a `GET` with:

- the query parameters below, and nothing about the user;
- `Lrclib-Client: FXM v<version> (https://github.com/Pratyay-ops/FXM)`, from `APP_NAME` and `APP_VERSION` in `@fxm/core`, or the `client` option;
- `credentials: 'omit'`, so no cookies.

LRCLIB asks every client to identify itself, normally with `User-Agent`. A web page can't do that reliably. Most browsers ignore a `User-Agent` set by the page. Firefox sends it, but only after a CORS preflight, and LRCLIB's preflight refuses that header. LRCLIB accepts `Lrclib-Client` instead, so FXM sends that header on every platform and never sets `User-Agent`.

What else LRCLIB sees depends on the platform:

- **Browser:** the browser's own `User-Agent`, plus `Origin: https://fxm-music.pages.dev`, which also identifies FXM. `Lrclib-Client` is not CORS-safelisted, so each request costs a preflight (LRCLIB sends no `Access-Control-Max-Age`).
- **Desktop and Android:** the native HTTP stack's default `User-Agent`.

FXM is not registered with LRCLIB. Registering it as a client-side application would give a public `Lrclib-App-Id` with a higher rate limit (see follow-ups).

## Lookup order

`getLyrics(track, ctx)` makes at most three requests and prefers synced lyrics:

1. **`GET /api/get`** with `track_name`, `artist_name`, `album_name` and `duration`:
   - `track_name` is the title without presentation noise ("(Official Video)") or an "Artist - " prefix;
   - `artist_name` lists every artist, comma-separated, without YouTube's "VEVO" and " - Topic" suffixes;
   - `duration` is in whole seconds, sent only between 1 and 3,600 s, LRCLIB's range. LRCLIB matches it within ±2 s.

   What the record holds decides the next step:
   - **Instrumental:** no lyrics (`null`).
   - **Synced:** returned at once.
   - **Plain only:** one search looks for synced lyrics of the same cut. If that finds none or fails, the plain lyrics are returned.
2. **`GET /api/search?q=<main artist> <core title>`** when the exact lookup misses. The core title is the title without qualifiers or featured artists. Results are scored with the core text helpers (`match.ts`):
   - **Gates:** title similarity of at least 0.9 and artist similarity of at least 0.6, after `stripPresentationNoise`, removing the artist prefix and `splitTitle`. Both sides must have the same strong version tags (live, remix, acoustic and so on).
   - **Ranking:** synced lyrics that fit, then any lyrics, then the rest. Then the score `0.40·title + 0.35·artist + 0.25·duration` (the matching engine's weights), then the same album, then the closest duration, then LRCLIB's order.
   - **Sync:** synced lyrics are used only when the record's duration is within 2 s of the track's, or the track's duration is unknown. Otherwise the record's text comes back as plain lyrics, because its times would run early or late. This is what a music video with an intro gets.
3. **`GET /api/get/<id>`**, only when a search result comes without its lyrics. Today search results carry the full record (checked 2026-10-25), so this step is a safeguard rather than a round trip on every miss.

A track without a title or an artist gets `null` without a request.

## Being a good client

LRCLIB asks for the following, and one provider instance does it for all its calls:

- **One request at a time, with a short pause.** Requests start at least `minIntervalMs` (250) apart.
- **Honour `Retry-After` with jitter, or risk a ban.**
  - A 429 holds every request back for `Retry-After` plus up to 30 %. Until then, calls fail at once with a `RateLimited` `FxmError` that carries `retryAfterMs`.
  - A 503 delays the next request the same way. A wait longer than `maxWaitMs` (5 s) fails with `RateLimited` instead of blocking the caller.

**Misses answer 503.** On 2026-10-25, LRCLIB answered every miss (`/api/get` with no matching record, `/api/get/<id>` with an unknown ID) with `503 ServerOverloaded` and `Retry-After: 1` after about 1.5 s, not the documented 404. So a 503 from `/api/get` counts as a miss: the provider waits about a second, then searches. A miss therefore takes about 3 to 4 seconds.

## Errors

`getLyrics` resolves `null` when LRCLIB has nothing, and rejects with an `FxmError` otherwise:

| Code | When |
|---|---|
| `RateLimited` | LRCLIB answered 429, or 503 to a search or ID lookup, or the wait would exceed `maxWaitMs`. `retryAfterMs` says how long to wait |
| `Network` | The request failed or took longer than `timeoutMs` (10 s) |
| `Unavailable` | Any other HTTP error, e.g. 500 or 400 |
| `Parse` | The answer is not the JSON LRCLIB documents |

A call whose `ctx.signal` aborts rejects with the signal's reason. There is no cache: the app caches lyrics per track.

## Options

| Option | Default | |
|---|---|---|
| `baseUrl` | `https://lrclib.net` | Another LRCLIB server, e.g. a self-hosted one (paths are kept) |
| `client` | `FXM v<version> (https://github.com/Pratyay-ops/FXM)` | The `Lrclib-Client` header. A fork should name itself |
| `timeoutMs` | 10,000 | Per request |
| `minIntervalMs` | 250 | Between request starts |
| `maxWaitMs` | 5,000 | The longest wait for a turn before failing with `RateLimited` |

## Tests

- **`api.test.ts`, `match.test.ts`, `provider.test.ts`:** offline, against `fixtures/`. The fixtures are LRCLIB responses recorded on 2026-10-25 and sanitized: catalog fields (IDs, titles, artists, albums, durations) are real, every lyric is a placeholder line, and one uploader's handle is generic. The search results for "Radiohead Creep" keep LRCLIB's real noise.
- **`live.test.ts`:** runs only with `FXM_LIVE=1` and makes five requests to lrclib.net: Creep's synced lyrics, the search fallback for a music video, and the CORS headers.

  ```sh
  FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/lrclib/live.test.ts
  ```
