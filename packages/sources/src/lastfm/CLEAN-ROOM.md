# Last.fm clean-room log

Every protocol fact FXM's Last.fm code relies on, with its source and the date it was seen, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) requires. Add a fact here before code relies on it.

All checks ran from one residential connection in India on 2026-10-26 (IST; the evening of 2026-10-25 UTC). The station JSON is not part of Last.fm's documented API.

**Where the station idea came from.** The research memo's line that the station JSON "is keyless, returns YouTube IDs and has no CORS" came from a report about Bloomee (GPL-2.0, 2026-10-25). Bloomee's code was not opened for this work, and every fact below was confirmed from Last.fm itself.

## Station JSON (`www.last.fm/player/station/…`)

| Fact | Source | Date |
|---|---|---|
| Last.fm's artist page has play buttons whose `data-station-url` attributes are `/player/station/music/<artist>` (the artist), `/player/station/music/<artist>/+similar` (similar artists) and `/player/station/music/<artist>/<album>` (one per album). Tag pages have `/player/station/tag/<tag>` | `https://www.last.fm/music/Radiohead` and `https://www.last.fm/tag/shoegaze`, loaded in headless Chromium (Playwright 1.64); attributes read from the page | 2026-10-26 |
| A `GET` of such a path, with no query string and no special headers, answers `200` with `Content-Type: application/json` and a body `{"playlist": [...]}` | Own requests (curl) to `/player/station/music/Radiohead` and `…/Radiohead/+similar` | 2026-10-26 |
| Each playlist entry has `name` (and `_name`), `url` (a catalogue path such as `/music/Muse/_/Stockholm+Syndrome`), `duration` in seconds or `null`, `artists` (each with `name`, `_name` and `url`) and `playlinks` (and `_playlinks`), each `{"affiliate": "youtube", "id": "<11-character videoId>", "url": "https://www.youtube.com/watch?v=…", "source": "global_suggestion"}` (`"ingested"` once). Most other fields are `null` | Own requests; trimmed into `fixtures/station-*.json` | 2026-10-26 |
| The artist station returned 30 entries, all by the artist. The similar station returned 24 entries by about 20 artists, the seed artist included, and a different mix on a second request | Own requests | 2026-10-26 |
| Station answers send no `Access-Control-Allow-Origin`, also not for the FXM web app's `Origin` | Own request with that `Origin`; `live.test.ts` checks it again with `https://fxmusic.pages.dev` | 2026-10-26 |
| Station answers set cookies (`sessionid`, `lfmanon`, `not_first_visit`). FXM sends `credentials: 'omit'`, and FXM Connect's rules strip cookies | Own requests | 2026-10-26 |
| Last.fm's HTML pages (artist and track pages) answer clients that run no JavaScript with `200 text/html`, a page titled "Client Challenge". The tag station `/player/station/tag/shoegaze` got that page twice, 3½ minutes apart, while the artist and similar stations kept answering JSON | Own requests (curl with a Chrome `User-Agent`); trimmed into `fixtures/client-challenge.ts` | 2026-10-26 |
| Names in station paths are percent-encoded UTF-8 with `+` for spaces and `%27` for an apostrophe: `/music/my+bloody+valentine/m+b+v`, `/music/Hum/You%27d+Prefer+an+Astronaut`, `/music/Bj%C3%B6rk/…`, `/music/Pixies/_/Where+Is+My+Mind%3F`; parentheses, `&` and `.` stay as they are | The `data-station-url` attributes and `url` fields above | 2026-10-26 |
| FXM Connect's `lastfm-station` rule adds `Access-Control-Allow-Origin` (the FXM origin) to `|https://www.last.fm/player/station/` for `xmlhttprequest` and `other` requests, and allows no extra request headers, so FXM's requests must stay CORS-simple: a `GET` without headers | `apps/extension/src/rules.ts` in this repository (stage 1.9) | 2026-10-26 |

## API (`ws.audioscrobbler.com/2.0/`)

| Fact | Source | Date |
|---|---|---|
| `artist.getSimilar` takes `artist` (required unless `mbid`), `mbid`, `limit`, `autocorrect` (`0` or `1`) and `api_key` (required); `format=json` gives JSON; `match` runs from 0 (not similar) to 1 (very similar). Errors: 6 invalid parameters, 10 invalid API key, 11 service offline, 16 temporary error, 26 suspended API key, 29 rate limit exceeded, among others. Example URL: `/2.0/?method=artist.getsimilar&artist=cher&api_key=YOUR_API_KEY&format=json` | Last.fm API documentation, <https://www.last.fm/api/show/artist.getSimilar> | 2026-10-26 |
| The answer's JSON shape, `{"similarartists": {"artist": [{"name", "mbid", "match", "url", "image": [...], "streamable"}], "@attr": {"artist": …}}}`, follows the documented XML sample. **Not recorded:** FXM has no API key. `fixtures/api-similar-artists-synthetic.json` follows this shape; `live.test.ts` checks the real answer when `FXM_LASTFM_API_KEY` is set | The documentation above | 2026-10-26 |
| Without `api_key`: HTTP 400 with `{"message":"Invalid parameters - Your request is missing a required parameter","error":6}`, and `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, GET, OPTIONS`, `Access-Control-Max-Age: 86400` | Own request with the FXM web app's `Origin`; `fixtures/api-error-missing-parameter.json`; `live.test.ts` | 2026-10-26 |
| The API terms: use for non-commercial purposes; credit Last.fm and link to its catalogue pages (`/music/<artist>`, `/music/<artist>/_/<track>`); cache as the HTTP headers say; rate limits at Last.fm's discretion (4.4); "You must not gather any other data from Last.fm in any other way" (2.6); no use "in conjunction with the unauthorised exploitation of intellectual property" (4.7) | Last.fm API Terms of Service, <https://www.last.fm/api/tos> | 2026-10-26 |

A list of one may come as the object itself instead of an array in some of Last.fm's JSON answers. The parser accepts both; this was not observed for `artist.getSimilar`.
