# SponsorBlock clean-room log

The SponsorBlock client in this folder (stage 8.7) calls SponsorBlock's public API at `https://sponsor.ajay.app`. The [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks that every protocol fact the code relies on be recorded here, with where it came from and when.

**Nothing here came from a GPL, AGPL or unlicensed project.** SponsorBlock's server and browser extension are AGPL-3.0 and GPL-3.0; neither was opened while this folder was written, and no code, fixture or translated logic was taken from them. The facts come from FXM's own requests, SponsorBlock's website and FXM's research memo. SponsorBlock's wiki, which documents the API, answered every automated request with a bot check (Anubis) on 2026-10-26, so it is not a source here.

## Sources

| Key | Source |
|---|---|
| **Memo** | FXM's research memo, [`docs/research/2026-10-25-userside-memo.md`](../../../../docs/research/2026-10-25-userside-memo.md), §5 rule 8 and the claims table: a live check from a residential connection on 2026-10-25 |
| **Rec-26** | FXM's own requests with curl from a residential connection on 2026-10-26 (2026-10-25 21:31 UTC), read and not kept: `GET /api/skipSegments/6db9?category=music_offtopic` (6db9 is the prefix of `sOnqjkJTMaA`), the same with a 32-character prefix no video has, and with the prefix `zz9`. `live.test.ts` repeats the first two |
| **Database** | [sponsor.ajay.app/database](https://sponsor.ajay.app/database) and the attribution template it links ([a gist by the SponsorBlock author](https://gist.github.com/ajayyy/4b27dfc66e33941a45aeaadccb51de71)), read on 2026-10-26 |
| **yt-dlp** | yt-dlp's `yt_dlp/postprocessor/sponsorblock.py` on its `master` branch (the Unlicense), read on 2026-10-26 |

## Lookup

| Fact | Source | Date |
|---|---|---|
| `GET https://sponsor.ajay.app/api/skipSegments/<prefix>` takes a prefix of the lower-case hex SHA-256 of the videoId, and answers for every video whose hash starts with it. FXM sends the first four characters, which the memo measured and yt-dlp uses ("SponsorBlock API recommends using first 4 hash characters"); 32 are accepted too | Memo; yt-dlp; Rec-26 | 2026-10-26 |
| A prefix that isn't 4 to 32 hex characters gets `400` with the text body `Hash prefix does not match format requirements.` | Rec-26 (`zz9`) | 2026-10-26 |
| `?category=music_offtopic` limits the answer to that category; the answer to the 6db9 request held no other category | Rec-26 | 2026-10-26 |
| `music_offtopic` is the "Non-Music Section": the parts of a music video that aren't music | Memo (ARCHITECTURE.md §4 names the category from it); Rec-26 (the segments of the Thriller short film's story parts carry it) | 2026-10-26 |
| No cookies, keys or custom headers are needed: the lookups above sent none | Rec-26 | 2026-10-26 |

## Answer

| Fact | Source | Date |
|---|---|---|
| `200` answers a JSON array of `{ videoID, segments }`, one entry per video of the prefix with segments of the asked category: seven for 6db9. There is no `hash` field | Rec-26 | 2026-10-26 |
| Each segment has `category`, `actionType` (`skip` for every `music_offtopic` segment seen), `segment` (`[start, end]` in seconds, fractional, e.g. `[173.37, 185.681]`), `UUID` (65 characters), `videoDuration` (seconds, fractional), `locked` (0 or 1), `votes` (an integer) and `description` (empty) | Rec-26 | 2026-10-26 |
| `videoDuration` is the video's duration when the segment was submitted; an outro segment often ends exactly there (`[173.37, 185.681]` with `videoDuration` 185.681). It can be `0` | Rec-26 (values); Memo; yt-dlp, which skips its duration check when the value is 0 or missing and otherwise drops a segment whose `videoDuration` differs from the file's by 1 s or more (up to 5 s for long segments). FXM reads `0` as unknown and allows 2 s, its own choice | 2026-10-26 |
| A prefix with no video that has segments of the category gets `404` with the JSON body `[]` | Rec-26 | 2026-10-26 |
| Answers carry `Access-Control-Allow-Origin: *`, also on 404 and 400, plus `Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE` and `Access-Control-Allow-Headers: Content-Type, If-None-Match, x-client-name` | Memo (the 200's ACAO); Rec-26 (all of it) | 2026-10-26 |
| Answers carry an `ETag` (`"skipSegmentsHash;6db9;YouTube;<time>"`) and no `Cache-Control`; Cloudflare passes them through (`cf-cache-status: DYNAMIC`) | Rec-26 | 2026-10-26 |
| No rate-limit headers were sent. FXM treats a `429` like other services' (wait for `Retry-After` in seconds, else a minute); this is not a measured fact | Rec-26 | 2026-10-26 |

## Licence

| Fact | Source | Date |
|---|---|---|
| "The API and database follow CC BY-NC-SA 4.0 unless you have explicit permission" | Database | 2026-10-26 |
| The attribution template: "Uses SponsorBlock data licensed used under CC BY-NC-SA 4.0 from https://sponsor.ajay.app/", where the licence link may be left out; shorter forms such as "Uses SponsorBlock data from https://sponsor.ajay.app/" are offered for small spaces. FXM shows "Uses SponsorBlock data licensed under CC BY-NC-SA 4.0 from sponsor.ajay.app", with both links, in Settings and About | Database (the linked gist) | 2026-10-26 |
| The test fixture keeps only the answer's shape (field names, order and types); its videoIDs, times, UUIDs and votes are made up, so no CC BY-NC-SA data is in the repository | FXM's own choice | 2026-10-26 |
