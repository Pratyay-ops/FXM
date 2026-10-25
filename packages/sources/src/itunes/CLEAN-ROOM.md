# iTunes Search clean-room log

Every fact FXM's iTunes Search code relies on, with its source and the date it was seen, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) requires. Apple documents the Search API; add a fact here before code relies on it.

The own requests ran from one residential connection in India on 2026-10-26 (IST; the evening of 2026-10-25 UTC), with the FXM web app's address as `Origin`; the API answers any origin alike.

| Fact | Source | Date |
|---|---|---|
| The search URL is `https://itunes.apple.com/search?<parameters>`: `term` (URL-encoded), `country` (two-letter ISO code; listed as required, default `US`), `media` (`music`), `entity` (for music: `musicArtist`, `musicTrack`, `album`, `musicVideo`, `mix`, `song`), `limit` (1 to 200, default 50), `lang`, `explicit` and others. Results are JSON | Apple's iTunes Search API documentation, <https://performance-partners.apple.com/search-api> | 2026-10-26 |
| "The Search API is limited to approximately 20 calls per minute (subject to change)", and "Large websites should set up caching logic for the search and lookup requests" | The documentation above | 2026-10-26 |
| "Developers may use promotional content in the API, including previews of songs, music videos, album art and App icons only to promote store content and not for entertainment purposes. Use of sound samples and other assets from the API must be proximate to a store badge." | The documentation above | 2026-10-26 |
| Answers are `200` with `Content-Type: text/javascript; charset=utf-8`, a JSON body `{"resultCount", "results"}`, `Access-Control-Allow-Origin: *` and `Cache-Control: max-age=86400` | Own requests (`entity=song` and `entity=album`); `live.test.ts` checks the CORS header again | 2026-10-26 |
| Song results have `wrapperType: "track"`, `kind: "song"`, `trackId`, `trackName`, `artistName` (the whole credit, e.g. "Daft Punk, Pharrell Williams & Nile Rodgers"), `collectionName`, `trackTimeMillis`, `releaseDate` and `artworkUrl30`/`60`/`100`. Album results have `wrapperType: "collection"`, `collectionType: "Album"`, `collectionId`, `collectionName` (singles and EPs end in " - Single" or " - EP"), `artistName` and `artworkUrl60`/`100` | Own requests; `fixtures/search-*.json` (trimmed to these fields) | 2026-10-26 |
| `artworkUrl100` looks like `https://is1-ssl.mzstatic.com/image/thumb/<path>/<file>/100x100bb.jpg`. The same URL with `300x300bb.jpg` or `600x600bb.jpg` answers `200 image/jpeg` (47 KB and 184 KB), with `Access-Control-Allow-Origin: *` | Own `HEAD` requests; `live.test.ts` checks the 600-pixel size again | 2026-10-26 |
| Searches are noisy: the US store's top 25 songs for "Radiohead Creep" held covers, lullaby versions, an acoustic EP and other artists' songs called "Creep", but not the original; the album search "Radiohead Pablo Honey" found another artist's album called "Pablo Honey" | Own requests; `fixtures/search-*-radiohead-*.json` | 2026-10-26 |
| What Apple answers over its limit is not documented. FXM treats `403` and `429` as "slow down" (an inference; not observed) | — | — |
