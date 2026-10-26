# Cover Art Archive clean-room log

Every fact FXM's Cover Art Archive code relies on, with its source and the date it was seen, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) requires. The archive documents its API; add a fact here before code relies on it.

The own requests ran from one residential connection in India on 2026-10-26 (IST; the evening of 2026-10-25 UTC), with the FXM web app's address as `Origin`; the archive answers any origin alike.

| Fact | Source | Date |
|---|---|---|
| `GET /release/{mbid}/` (also `HEAD`) answers `307`, a redirect to an `index.json` file, when the release exists; `400` when `{mbid}` is not a valid UUID; `404` when there is no release with this MBID; `405` for other methods; `406` when it cannot answer the `Accept` header; `503` when the client has exceeded its rate limit. Thumbnails come in 250, 500 and 1200 pixels, also named `small` (250) and `large` (500); `/release-group/{mbid}/` exists too | Cover Art Archive API documentation, <https://musicbrainz.org/doc/Cover_Art_Archive/API> | 2026-10-26 |
| `GET https://coverartarchive.org/release/07aab296-9a40-42a9-8d1f-6b06aa032e8a` (Radiohead, "Pablo Honey") answers `307` to `https://archive.org/download/mbid-<mbid>/index.json`, which answers `302` to `https://<node>.ca.archive.org/0/items/mbid-<mbid>/index.json`, which answers `200 application/json`. Every hop sends `Access-Control-Allow-Origin: *`; the last one also `Access-Control-Allow-Credentials: true` (FXM sends no credentials) | Own requests, hop by hop; `live.test.ts` checks each hop again | 2026-10-26 |
| The listing is `{"images": [...], "release": "https://musicbrainz.org/release/<mbid>"}`; each image has `approved`, `back`, `comment`, `edit`, `front`, `id`, `image`, `thumbnails` (`"250"`, `"500"`, `"1200"`, `"small"`, `"large"`) and `types` (e.g. `["Front"]`, `["Back", "Spine"]`, `["Booklet"]`). Image and thumbnail URLs are written `http://coverartarchive.org/release/<mbid>/<id>-250.jpg` | Own request; `fixtures/release-pablo-honey.json` | 2026-10-26 |
| The same thumbnail URL on `https:` answers `307` to `https://archive.org/download/…_thumb250.jpg`, then `302` to `https://<node>.ca.archive.org/…`, then the image (`206 image/jpeg` for `Range: bytes=0-0`), with `Access-Control-Allow-Origin: *` on each hop | Own request | 2026-10-26 |
| A release without art (a made-up MBID) answers `404 text/html` "No cover art found for release <mbid>", with `Access-Control-Allow-Origin: *` | Own request | 2026-10-26 |
