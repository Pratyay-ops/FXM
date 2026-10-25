# Jamendo (`jamendo`)

Creative Commons music from [Jamendo](https://www.jamendo.com) with real FLAC streams: a `MetadataProvider` for search, tracks, albums and artists, and an `AudioSource`. It works in any browser without FXM Connect, and on every platform through the injected `ctx.fetch`.

```ts
import { createJamendoSource, JamendoQuota } from '@fxm/sources/jamendo'

const jamendo = createJamendoSource({
  publicClientId: config.jamendoClientId,       // from the app's build configuration
  userClientId: settings.jamendoClientId,       // the user's own, if any
  preferLossless: () => settings.preferLossless,
  quota: new JamendoQuota({ saved: settings.jamendoQuota }),
})
jamendo.quota.onChange(() => save({ jamendoQuota: jamendo.quota.snapshot() }))
jamendo.access() // { status: 'ready', client: 'public' }, 'not-configured', 'quota-exceeded', …
jamendo.requestPolicy // 'explicit': only for what the user asked of Jamendo
settingsField.onSubmit((id) => jamendo.setUserClientId(id)) // tests the entered ID at once
tryAgainButton.onClick(() => jamendo.tryAgain())
```

The module exports only `createJamendoSource` with its types, `JamendoQuota` with its options, snapshot and block types, `JamendoAccess`, `JamendoClientKind` and the `jamendoTrackUrl`, `jamendoAlbumUrl` and `jamendoArtistUrl` helpers.

## The client_id and the shared quota

Every request needs a `client_id`. The free, non-commercial tier allows **up to 35,000 API requests a month** per ID (developer.jamendo.com, read 2026-10-25), and every FXM user of the public ID shares that budget. So:

- **The public ID comes from configuration**, never from the code: without it, and without a user's own, Jamendo is off (`access()` returns `not-configured`, calls reject with `AuthRequired`, like an ID Jamendo refuses, so the app asks for a `client_id` in Settings).
- **The user's own ID** replaces the public one and has its own record. Pass a saved one as `userClientId` on start, which keeps its record, and call `setUserClientId()` when the user enters one in Settings: entering an ID, even the same one again, forgets its block so that the next request tests it at once (a newly registered ID that Jamendo did not know yet works as soon as it is active).
- **Jamendo is asked only when it must**, and the code says so: the source has `requestPolicy: 'explicit'` (an optional `MetadataProvider` field in `@fxm/core`). **Stage 2.4 must honour it**: call `search`, `getTrack`, `getAlbum` and `getArtist` only for explicit Jamendo searches and pages, never in a search across all sources, for suggestions or in the background. `match` asks Jamendo about another source's track only while "prefer lossless" is on (`preferLossless`), and answers a Jamendo track without a request.
- **Answers are cached** in memory, keyed without the `client_id`: searches for an hour, tracks, albums and artists for six. `resolve` and `attribution` reuse every track that a search or page already returned.
- **A refusal stops the requests for a while.** Jamendo answers code 6 ("Rate Limit Exceeded: this requester app or the requester IP have exceeded the permitted rate limit") or HTTP 429 when the quota is used up, code 5 for an unknown ID and code 11 for a suspended app. FXM then records a block for that ID and rejects without sending anything: for 15 minutes, then four times as long after each further refusal for the same reason (1 h, 4 h, 16 h), at most a day. Once the wait is over, one request tests the ID again; until it answers, the others fail at once (`RateLimited` with the request timeout as `retryAfterMs`, or `AuthRequired`). A burst of concurrent refusals counts as one, and answers to requests sent before a block was recorded never change it. Meanwhile `access()` returns `{ status: 'quota-exceeded' | 'invalid-client-id' | 'suspended', client, retryAt }`, and for a used-up public ID the app shows **"Jamendo's quota is used up: add your own client_id"**. `tryAgain()` (or `quota.forget(id)`) forgets the block on the ID in use, for a "Try again" button. A user's own ID starts clean.
- **Blocks survive restarts** if the app saves `quota.snapshot()` and passes it back as `saved`. A saved wait is cut to at most a day from now (a clock that was wrong, or a damaged store, could otherwise block an ID for months), and anything malformed is dropped.

## What it requests

| Request (`https://api.jamendo.com/v3.0/…`) | For |
|---|---|
| `tracks/?search=…&type=single albumtrack&limit=…&offset=…` | Song search, and `match` (limit 10) |
| `albums/?namesearch=…`, `artists/?namesearch=…` | Album and artist search |
| `tracks/?id=…` | `getTrack`, and `resolve` for a track no answer returned yet |
| `albums/tracks/?id=…`, `artists/tracks/?id=…` | `getAlbum`, `getArtist` |

Every request carries `client_id` and `format=json`; track requests also `audioformat=flac`, `audiodlformat=flac` and `imagesize=300`. No headers, no credentials, so no CORS preflight. Jamendo's playlists are not offered (`getPlaylist` rejects with `Unsupported`).

## CORS (measured 2026-10-25)

| URL | Answer to a request with `Origin: https://fxm-music.pages.dev` |
|---|---|
| `api.jamendo.com/v3.0/tracks/?client_id=…` | 200, `Access-Control-Allow-Origin: *`, also when Jamendo refuses the ID (code 5 in the body) |
| The same without `client_id` | 200, **no** CORS headers: a page cannot read it (FXM never sends one) |
| `prod-1.storage.jamendo.com/?trackid=…&format=flac` | 206 for a range, the request's origin echoed in `Access-Control-Allow-Origin`, `Content-Range` exposed |

## Streams

The `audio` URL Jamendo returns for `audioformat=flac` streams real FLAC: the sample track 1848357 starts with a STREAMINFO block for 44.1 kHz, 16-bit stereo. The same URL with another `format` streams the other versions, so `resolve` offers all four, best first:

| `format` | Codec, container | Tier |
|---|---|---|
| `flac` | FLAC | `lossless` |
| `mp32` ("VBR, good quality") | MP3 | `normal` (no stated bitrate) |
| `ogg` | Vorbis, `ogg` | `normal` (no stated bitrate) |
| `mp31` ("96kbs") | MP3, 96 kbps | `low` |

Options are `progressive`, `media: 'audio'`, `ipBound: false`, never expire, and are `unverified` because nothing probed their end, not because their bytes are unreadable: Jamendo's storage host echoes the page's origin, so the download manager (4.1) can run its end-of-file probe on the option it picks. The lossy versions let playback stay under a lower ceiling, such as `normal` on mobile data.

**Downloads.** When an artist allows streaming but not downloads (`audiodownload_allowed: false`), every option carries `downloadAllowed: false` (an optional `StreamOption` field added to `@fxm/core` for this), and the download manager must skip them. Answers without the flag count as allowing downloads only when they hold a download URL.

## Tracks, albums and artists

IDs are Jamendo's numbers in decimal: `jamendo:track:1848357`, `jamendo:album:368084`, `jamendo:artist:421168`. Tracks are songs, so they show and play in Music mode (the owner's decision). Artwork is the 300-pixel cover.

**Credit.** `attribution(trackId, ctx)` returns what the API terms (§4.1) and the track's Creative Commons licence ask for: its title and artist, `provider: 'Jamendo'`, the track's page on Jamendo (`pageUrl`) and the licence's URL. For a candidate, pass `formatId('jamendo', 'track', candidate.ref)`. It costs no request for a track that a search, page or `resolve` already returned. `jamendoTrackUrl()`, `jamendoAlbumUrl()` and `jamendoArtistUrl()` give the other Jamendo pages.

`match` scores another source's track the way the Internet Archive source does: a provisional 0.40 title / 0.35 artist / 0.25 duration score with the engine's penalties, version tags read from the title's qualifiers and both albums, nothing below 0.60 returned. Jamendo has no ISRCs, so its candidates are never ISRC-verified: they are at most 0.79, a suggestion. The playback policy (2.3) must not play them without asking, and nothing re-scores them on the way (the matching engine, 1.7, reads YouTube Music pages only), so "prefer lossless" can pick a Jamendo match only once the user confirms it.

## The API terms and one shared client_id

Checked on 2026-10-25 against Jamendo's API Terms of Use (devportal.jamendo.com/api_terms_of_use, last modified 2013-09-17):

- **§2** requires each application to be registered "with a unique Client ID", and calls credentials, API keys included, "strictly personal", not to be shared with or disclosed to third parties.
- **§3.3** makes the API free for non-commercial use, lets Jamendo limit "the number and frequency of requests" (which apps must not circumvent), allows caching only "to the extent reasonably necessary", and says "Applications must not be specifically designed to cache the content nor offering an offline access to the content."
- **§4.1** asks apps to credit the artists, credit Jamendo as the provider and link to each track's page.

The terms do not say whether one application's `client_id` may be embedded in a client-side app that all its users run. FXM is one application, which §2's "unique Client ID" per application fits, and a `client_id` is a public identifier that every browser request shows; the secret OAuth credentials, which FXM never needs, are what must stay private. But "not disclosed to third parties" read strictly is at odds with any public web app, and §3.3's offline clause sits uneasily with FXM's downloads, even when the artist allows them. **So the owner should confirm with Jamendo before shipping a public ID** (developer contact via devportal.jamendo.com, or the jamendo-dev group). This source embeds no ID: the app passes the public one from its configuration, and until it has one, Jamendo works with a user's own ID only. FXM respects the request limits (no workaround), caches only in memory, never downloads a track whose artist disallows it, and links each track to its Jamendo page.

## Errors

| Situation | `FxmError` code |
|---|---|
| No `client_id` set | `AuthRequired` |
| Quota used up (code 6 or HTTP 429), now or recorded earlier | `RateLimited`, with the time until FXM tries again |
| Unknown or malformed `client_id` (code 5), suspended app (code 11), now or recorded earlier | `AuthRequired` |
| Unknown track, album or artist; malformed ID | `NotFound` |
| A track without a stream URL | `Unavailable` |
| Any other code, HTTP error | `Unavailable` |
| Unreachable, timed out (15 s by default) | `Network` |
| An answer that is not what the API documents | `Parse` |

## Tests

No `client_id` was available when this source was written, so most fixtures follow Jamendo's documentation instead of a recording, and the live test below has not run yet. **Open item:** run it and re-record the fixtures before the app turns Jamendo on. `error-invalid-client-id.json` is a real answer, recorded on 2026-10-25. `tracks-docs-sample.json` is the sample answer published on developer.jamendo.com/v3.0/tracks (its pretty-printing undone and the waveform shortened). `tracks-flac.json` is that answer as FXM requests it (`audioformat=flac`, `audiodlformat=flac`); its FLAC URLs were checked live against the storage host. `error-rate-limit.json`, `albums-tracks.json`, `artists-tracks.json`, `albums-search.json` and `artists-search.json` are built from the documented fields of those endpoints and the response-code table. Re-record them from real answers once a `client_id` exists, removing the `client_id` from anything kept.

The live smoke test needs a `client_id` of your own (register one at devportal.jamendo.com; never commit it), and makes four requests:

```sh
FXM_LIVE=1 FXM_JAMENDO_CLIENT_ID=<your client_id> \
  scripts/run.sh pnpm exec vitest run packages/sources/src/jamendo/live.test.ts
```
