# iTunes Search

`@fxm/sources/itunes` searches Apple's iTunes Store catalog with the [iTunes Search API](https://performance-partners.apple.com/search-api), only to fill artwork gaps: a track whose source gave no cover and the Cover Art Archive has none. It runs on the user's device, only through the injected `ctx.fetch`, needs no key and answers any origin, so it works on every tier.

```ts
import { bestItunesSong, createItunesClient, itunesArtwork } from '@fxm/sources/itunes'

const itunes = createItunesClient()
const query = { title: 'Get Lucky', artists: ['Daft Punk'] }
const song = bestItunesSong(await itunes.searchSongs('Daft Punk Get Lucky', ctx), query)
const artwork = song?.artworkUrl === undefined ? [] : itunesArtwork(song.artworkUrl)
```

Where each fact comes from is in [CLEAN-ROOM.md](CLEAN-ROOM.md).

## Calls

- `searchSongs(term, ctx, options)` and `searchAlbums(term, ctx, options)` search the store's music (`media=music`, `entity=song` or `album`), 10 results by default (`limit`, up to 200; a value that is not a finite number means 10). The store is `options.country`, else the context's `region`, else the US store, Apple's default. Each `ItunesSong` and `ItunesAlbum` keeps its store page as `storeUrl` (Apple's `trackViewUrl` or `collectionViewUrl`), for the store badge Apple's terms ask for.
- `itunesArtwork(artworkUrl100)` turns a result's 100-pixel cover into the sizes FXM offers, 100, 300 and 600 pixels square: Apple's image servers (`*.mzstatic.com`) scale an image to the size its URL names. It refuses URLs on other hosts.

## Matching

Searches are noisy. On 2026-10-26 the US store's top 25 songs for "Radiohead Creep" held covers, lullaby versions, an acoustic EP and other artists' songs called "Creep", but not the original, and the album search for "Radiohead Pablo Honey" found another artist's "Pablo Honey". So a cover is used only when its result is clearly the track's:

- `bestItunesSong(songs, query)`: by the track's artist (one name of the credit, such as "Daft Punk" in "Daft Punk, Pharrell Williams & Nile Rodgers", at least 0.9 similar to one of the track's artists, so that "Radiohead Tribute", "Radiohead Karaoke" or "Amuse" for Muse don't count), with its title (0.9 or more for the title proper) and the same strong version tags (live, remix, acoustic…), and no more than 30 s longer or shorter when both durations are known. The exact title wins, then the track's album, then Apple's order.
- `bestItunesAlbum(albums, query)`: by the artist (the same rule), with the album's name proper (without " - Single" or " - EP") and the same strong version tags. The exact name wins over an edition such as "(10th Anniversary Edition)".

Anything else gives no cover rather than a wrong one.

## Apple's terms

Apple's documentation (read 2026-10-26) says developers "may use promotional content in the API, including … album art … only to promote store content and not for entertainment purposes", and that assets "must be proximate to a store badge". FXM would show these covers as artwork for tracks it plays from other sources, which those terms don't cover; the artwork filler marks each cover's source (`source: 'itunes'`) and passes on the store page (`pageUrl`), so that the screens can show a badge next to it if FXM keeps iTunes. The plan (revision 3) chose iTunes Search for artwork gaps; the owner should weigh this before turning it on in a release. The collector works without it: leave `itunes` out of `createArtworkFiller`, and the Cover Art Archive alone fills gaps.

## Being a good client

- At most 20 searches in any minute (`maxPerMinute`), Apple's documented limit. A search waits for its turn at most `maxWaitMs` (60 s) from when it was made, the searches queued ahead of it included, and otherwise fails with `RateLimited`; it fails at once when the limit alone would keep it waiting longer. Higher priorities go first: the artwork filler passes `priority: 'bulk'` for a list it fills in the background, so the cover the user is looking at never waits behind it.
- Answers are cached in memory for as long as Apple's `Cache-Control` says (it sends a day), between 1 and 24 hours, as Apple asks of large sites.
- Apple doesn't document how it refuses a client over the limit: a `403` or `429` holds every request back for `Retry-After` (a minute when it doesn't say), plus up to 30 % jitter.

## Errors

| Code | When |
|---|---|
| `RateLimited` | A search that would wait longer than `maxWaitMs` for its turn; or a `403` or `429` |
| `Network` | The request failed, broke off or took longer than `timeoutMs` (10 s) |
| `Unavailable` | Any other HTTP error |
| `Parse` | An answer without `results` |

An empty term gives an empty list without a request. A cancelled `ctx.signal` rejects with its reason.

## Tests

- **`api.test.ts`, `match.test.ts`:** offline, against `fixtures/`, four searches recorded on 2026-10-26 and trimmed to the fields FXM reads: Daft Punk's "Get Lucky" and "Random Access Memories", where the right result is there, and Radiohead's "Creep" and "Pablo Honey", where it isn't.
- **`live.test.ts`:** runs only with `FXM_LIVE=1`: one search with its CORS header, and one request for the 600-pixel cover.

  ```sh
  FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/itunes/live.test.ts
  ```
