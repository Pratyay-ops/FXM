# SponsorBlock client

`@fxm/sources/sponsorblock` looks up the non-music parts of music videos (intros, skits, outros) in [SponsorBlock](https://sponsor.ajay.app), a database its community fills, so FXM can skip them in Music + Video mode (stage 8.7, [ARCHITECTURE.md §4](../../../../docs/ARCHITECTURE.md#4-catalog-modes-music-vs-music--video)). It runs on the user's device and uses only the injected `ctx.fetch`.

```ts
import { createSponsorBlockClient, skippableVideoId } from '@fxm/sources/sponsorblock'

const sponsorBlock = createSponsorBlockClient() // one for the app: it caches
const videoId = skippableVideoId(item, mode) // undefined for songs, and in Music mode
const segments = videoId === undefined ? [] : await sponsorBlock.nonMusicSegments(videoId, ctx)
// [{ startMs: 0, endMs: 14500, videoDurationMs: 240000, uuid: '…' }, …], in order of their start
```

Skipping itself is the player's segment skipper (`connectSegmentSkipper` in `@fxm/player`); the web app connects the two and owns the setting (`apps/web/src/features/sponsorblock/`).

## Opt-in, and private

SponsorBlock is off by default, and the app asks it nothing until the user turns it on. Even then, **the videoId never leaves the device.** Each lookup sends only the first four hex characters of the videoId's SHA-256 hash:

```
GET https://sponsor.ajay.app/api/skipSegments/6db9?category=music_offtopic
```

About one in 65,536 of all videos has each prefix, so SponsorBlock answers with every video of the group that has segments, and the client picks its own out. SponsorBlock can't tell which video plays. The request carries no cookies (`credentials: 'omit'`) and no custom headers, so it is a CORS-simple GET without a preflight. In a browser, SponsorBlock still sees the user's IP address and the page's `Origin` (FXM's site), as any service would.

The hash comes from Web Crypto (`crypto.subtle`), which browsers offer only in a secure context, as every FXM app is (HTTPS, `localhost`, the desktop and Android apps). Where it is missing, for example on a dev server opened over plain HTTP from another device, lookups reject with `Unsupported` and nothing is skipped: the client never falls back to sending the videoId.

## Which items

`skippableVideoId(item, mode)` returns the videoId only for a **video playing as itself in Music + Video mode**:

- the mode is `all`;
- the track is a `video` or `music-video` from YouTube Music or YouTube (`ytm:` or `yt:` with a well-formed videoId), which that mode plays (`modePolicy` says `playable`);
- the audio is the video's own: no candidate, or one for the same video. A song matched to the track plays in its place, and the video's segments don't fit it.

Songs never qualify, so a song is never cut, and neither does anything in Music mode.

## Category and answers

Only `music_offtopic` is asked for: SponsorBlock's "Non-Music Section", the parts of a music video that aren't music. Each segment is checked before it is used:

- the category must be `music_offtopic` and the action `skip` (or absent): `mute`, `full`, `poi` and `chapter` segments are dropped;
- `segment` must be two numbers of seconds, start before end, within a day;
- `videoDuration` (the video's duration when the segment was submitted) becomes `videoDurationMs`, unless it is 0, which SponsorBlock sends when it doesn't know. The skipper ignores segments whose duration differs from the track's by more than 2 s: the upload was edited since;
- at most 64 segments per video are kept.

A `404` (body `[]`) means no video of the prefix has segments, so the answer is an empty list.

## Cache and sharing

One answer covers every video of its prefix for an hour (`cacheTtlMs`), and the client keeps the answers of the 256 most recently used prefixes (`maxCachedPrefixes`). Lookups of the same prefix in flight share one request. A caller's `ctx.signal` stops its own wait at once, but not the request, which still fills the cache for whoever asks next; `timeoutMs` bounds it.

## Errors

`nonMusicSegments` resolves an empty list when SponsorBlock has nothing (or the ID is no videoId), and rejects with an `FxmError` otherwise:

| Code | When |
|---|---|
| `RateLimited` | SponsorBlock answered 429. `retryAfterMs` comes from `Retry-After` in seconds, else a minute; until then, lookups fail at once without a request |
| `Network` | The request failed, its body broke off, or it took longer than `timeoutMs` (10 s) |
| `Unavailable` | Any other HTTP error, e.g. 400 or 500 |
| `Parse` | The answer is not a JSON array |
| `Unsupported` | Web Crypto is missing (see above) |

A call whose `ctx.signal` aborts rejects with the signal's reason, and starts no request once the signal has aborted, not even when it aborts just as the hash is ready. A shared request it leaves behind never surfaces as an unhandled rejection. The app treats every failure as "nothing to skip".

## Licence and credit

SponsorBlock's data is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). FXM credits it where the data is used, after SponsorBlock's attribution template: "Uses SponsorBlock data licensed under CC BY-NC-SA 4.0 from sponsor.ajay.app", in Settings (next to the switch) and in Settings → About. `SPONSORBLOCK_DATA_LICENSE` holds the licence's name and link. FXM fetches the data at run time on the user's device and never redistributes it, and the repository holds none of it (see Tests).

## Options

| Option | Default | |
|---|---|---|
| `baseUrl` | `https://sponsor.ajay.app` | Another SponsorBlock server, e.g. a mirror (paths are kept) |
| `timeoutMs` | 10,000 | Per request, body included |
| `cacheTtlMs` | 3,600,000 | How long an answer serves its prefix |
| `maxCachedPrefixes` | 256 | How many prefixes' answers are kept |
| `sha256` | Web Crypto | The hash function, e.g. for tests |
| `now` | `Date.now` | The clock |

## Tests

- **`hash.test.ts`, `api.test.ts`, `skippable.test.ts`:** offline. `fixtures/bucket.json` keeps the shape of an answer recorded on 2026-10-26 (field names, order and types); its videoIDs, times, UUIDs and votes are made up, so no CC BY-NC-SA data is in the repository.
- **`live.test.ts`:** runs only with `FXM_LIVE=1` and makes three requests to sponsor.ajay.app: one lookup through the client, the answer's shape and CORS header, and the 404 for a prefix no video has.

  ```sh
  FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/sponsorblock/live.test.ts
  ```

The protocol facts the client relies on, each with its source and date, are in [CLEAN-ROOM.md](CLEAN-ROOM.md).
