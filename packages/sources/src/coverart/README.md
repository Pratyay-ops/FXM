# Cover Art Archive

`@fxm/sources/coverart` finds a release's front cover in the [Cover Art Archive](https://coverartarchive.org), the cover database of MusicBrainz and the Internet Archive, on the user's device and only through the injected `ctx.fetch`. It needs no key and answers any origin, so it works on every tier, without FXM Connect.

```ts
import { createCoverArtClient } from '@fxm/sources/coverart'

const coverArt = createCoverArtClient()
const artwork = await coverArt.releaseArtwork('07aab296-9a40-42a9-8d1f-6b06aa032e8a', ctx)
// [{ url: 'https://coverartarchive.org/release/…-250.jpg', width: 250 }, … 500, … 1200]
```

`releaseArtwork(mbid, ctx)` asks for a MusicBrainz release's listing and returns its front cover (an approved one first) as core `Artwork`, in 250, 500 and 1200 pixels, smallest first, with `width` only: the archive scales covers to fit those sizes and doesn't say the other side. The artwork filler ([`@fxm/sources/recommend`](../recommend/README.md)) finds the release through ListenBrainz, or through MusicBrainz once stage 1.6 is wired in. Where each fact comes from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).

## What the browser loads

The listing redirects twice, from `coverartarchive.org` to `archive.org` and on to one of its servers (`*.ca.archive.org`), and each hop allows any origin. The image URLs in it point at `coverartarchive.org` again and redirect the same way. The archive writes them with `http:`; FXM turns them into `https:`, which the archive also serves, and drops any URL on another host. So the app's CSP needs `coverartarchive.org`, `archive.org` and `*.archive.org` in `connect-src` (the listing) and `img-src` (the covers).

## Being a good client

- Requests go one at a time. The archive documents a rate limit (`503` when exceeded) but not its size.
- Covers are cached in memory for 24 hours (`cacheTtlMs`); releases without one for 6 hours (`missTtlMs`).
- A `429` or `503` holds every request back for `Retry-After` (10 s when it doesn't say), plus up to 30 % jitter; until then calls fail at once with `RateLimited`.

## Errors

| Code | When |
|---|---|
| `RateLimited` | `429` or `503`; `retryAfterMs` says how long to wait |
| `Network` | The request failed, broke off or took longer than `timeoutMs` (10 s), redirects included |
| `Unavailable` | Any other HTTP error |
| `Parse` | A listing without `images` |

A release without art (`404`), an MBID the archive refuses (`400`) and a value that isn't an MBID (no request) give an empty list. A cancelled `ctx.signal` rejects with its reason.

## Tests

- **`api.test.ts`:** offline, against `fixtures/release-pablo-honey.json`, the listing recorded on 2026-10-26.
- **`live.test.ts`:** runs only with `FXM_LIVE=1`: it follows the listing's redirects hop by hop, checking each one's CORS header, then reads the listing through the client.

  ```sh
  FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/coverart/live.test.ts
  ```
