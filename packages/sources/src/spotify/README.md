# Spotify provider

`@fxm/sources/spotify` reads Spotify's metadata and recommendations for FXM: search, tracks, albums, artists, related artists, playlists, track and artist radio, the home feed, the ISRC of a track, and (logged in) the user's library. Spotify supplies metadata only, never audio: FXM plays a Spotify track by matching it to a song from another source.

It is **built into FXM and on by default** wherever the platform can reach Spotify, and the user can switch it off in Settings (owner's decision, 2026-10-25). It talks to Spotify's own web-player APIs from the user's device. FXM has no server in between.

```ts
import { createSpotifyProvider, isSpotifyAvailable } from '@fxm/sources/spotify'

// One instance per app: it holds the tokens, the caches and the pause state.
const spotify = createSpotifyProvider({
  isEnabled: () => settings.spotify.enabled,  // the switch, on by default
  session: fxmConnectSessionBridge,           // optional: the user's own login (see below)
})

if (isSpotifyAvailable(ctx, settings.spotify)) {
  const { tracks, artists } = await spotify.search('radiohead creep', { types: ['track', 'artist'] }, ctx)
  const radio = await spotify.radio(tracks.items[0], ctx)
  const details = await spotify.getTrackDetails(tracks.items[0].id, ctx) // ISRC, label, release date
}
```

## How it works

Every request goes through the injected `ctx.fetch`, with `credentials: 'omit'`:

| Platform | Transport | Notes |
|---|---|---|
| Web app with FXM Connect | The page's `fetch` | Connect's rules give the token endpoints Spotify's Origin and add CORS for the FXM origin. Requests send only `Authorization`, `Content-Type` and `Accept`, which Connect allows |
| Web app without Connect (also the Lite tier) | — | Spotify is unreachable: `capabilities.spotify` is `unreachable` and every call fails with `Unsupported` |
| Desktop (Tauri) and Android | Native HTTP | Sends a browser `User-Agent`: Spotify answers non-browser clients (curl, okhttp, Dalvik, `tauri-plugin-http`) with `403 Client/request not allowed` |
| Node (tests) | Node's `fetch` | Treated as native: use `platform: 'desktop'` |

The User-Agent is sent when `ctx.platform` is not `web` (override with the `sendUserAgent` option). A web page must not send one: it would trigger a CORS preflight that Connect does not allow.

### Tokens

1. **The TOTP secret.** A versioned secret behind the token endpoint's one-time code. FXM never ships it. The default secret provider fetches it at run time from the community-maintained JSON URLs in `spotify-config.json` (see [Runtime config](#runtime-config)) and keeps it in memory for 6 hours. Three JSON shapes are accepted: `{ "<version>": [numbers] }`, `[{ "version": n, "secret": [numbers] | "text" }]` and one such entry. The newest version wins. Its numbers become the HMAC key: each number is XORed with `(index % 33) + 9`, the results are written in decimal and joined, and the UTF-8 bytes of that text are the key.
2. **The anonymous token.** `GET https://open.spotify.com/api/token?reason=init&productType=web-player&totp=…&totpServer=…&totpVer=…`. `totp` is the RFC 6238 code (HMAC-SHA1, 6 digits, 30 s, computed with WebCrypto) over the local clock, `totpServer` the same over Spotify's clock from `GET /api/server-time` (the local clock when that fails), and `totpVer` the secret's version. The answer is `{ accessToken, accessTokenExpirationTimestampMs, isAnonymous, clientId }`.
3. **The logged-in token.** The same request with `reason=transport`, sent with the user's own Spotify session cookies by a pluggable `SessionTokenSource`. On the web that is FXM Connect's opt-in session bridge (its `fxm-connect:spotify-token` message takes exactly these query parameters and returns `{ status, json }`). On desktop and Android it is the login window of later stages (7.4, 6.5). FXM's code never sees the cookies.

Tokens live in memory only and are never logged. A token is refreshed lazily when a call finds less than 60 s left, and only one refresh runs at a time. Spotify hands out the same anonymous token until it expires, so a fresh token that already has less than a minute left is used until it expires instead of being refreshed on every call. Expiry is measured on the device clock, corrected by Spotify's server time. If a refresh fails while the old token is still valid, the old token is used.

If the token endpoint refuses the TOTP (HTTP 400, also with `totpVerExpired` when the version is retired), the secret is fetched again once. If that is refused too, minting pauses for 5 minutes with `secret-rejected`, so the UI can say "Spotify is paused: its secret stopped working" and offer another secret source.

### Calls

| Need | Call |
|---|---|
| Search, several types | GraphQL `searchDesktop`, one call |
| Search, one type or a later page | `searchTracks`, `searchAlbums`, `searchArtists`, `searchPlaylists` |
| Track | `getTrack` |
| Album with all its tracks | `getAlbum`, pages of 50 (up to 10 pages) |
| Artist page: top tracks, releases, 20 related artists | `queryArtistOverview` |
| Related artists (40) | `queryArtistRelated` |
| Playlist and its pages | `fetchPlaylist` (offset 0, limit 50 for the first page) |
| Radio for a track or an artist | spclient `GET /inspiredby-mix/v2/seed_to_playlist/<uri>?response-format=json` → `mediaItems[0].uri` → `fetchPlaylist` |
| ISRC, label, release date, popularity | spclient `GET /metadata/4/track/<32-hex gid>?market=from_token` (the base62 ID converted to hex) |
| Home feed and "show all" sections | `home`, `homeSection`. Generic for the market when anonymous, personal when logged in |
| Login status and display name | the token source, then `profileAttributes` |
| Liked songs, saved playlists (logged in) | `fetchLibraryTracks`, `libraryV3` |

GraphQL calls are `POST https://api-partner.spotify.com/pathfinder/v2/query` with `Authorization: Bearer …`, `Content-Type: application/json;charset=UTF-8`, `Accept: application/json` and the body `{ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash } } }`. FXM never calls the official Web API (`api.spotify.com/v1`), never writes to Spotify and does not use `clienttoken`.

Mapping to FXM's types: every Spotify track is a catalog song (`kind: 'song'`) with `externalIds.spotify` set to its base62 ID, `explicit` from its content rating, artwork, `durationMs`, track and disc numbers, and its album's release date. IDs are canonical: `spotify:<kind>:<22-character base62 ID>`. `getTrack` includes the ISRC once `getTrackDetails` has found it; `enrichTrack` adds the ISRC, release date and popularity to any track with a Spotify ID, including another source's track through its `externalIds.spotify`. Look details up only for tracks being played, prefetched or imported. Spotify has no videos for FXM, so the `video` search type is always an empty page.

**Radio from another source's track.** A seed uses its `externalIds.spotify` when it has one. Otherwise (unless `lookupForeignSeeds: false`) one track search for "artist title" finds it, accepting only a result whose title core and artist match exactly. A leading "Artist - " and presentation noise such as "(Official Music Video)" are ignored. An artist seed without a Spotify ID is looked up by its exact name. The seed track itself is left out of the radio.

## The switch, reachability and the account

- `DEFAULT_SPOTIFY_SETTINGS` is `{ enabled: true }`, and `sanitizeSpotifySettings` keeps it on unless `false` was stored explicitly.
- `isSpotifyAvailable(ctx, settings)` is true when the switch is on and `ctx.capabilities.spotify` is `anonymous` or `account`. Use it to show Spotify results, radio and the source switch.
- The provider checks both on every call: `isEnabled()` (the switch, `disabled`) and the capability (`unreachable`). Both fail with `Unsupported` before any request.
- `status(ctx)` answers "not connected" without a request unless the platform has a login (`capabilities.spotify === 'account'`) and a `SessionTokenSource` was given. A logged-out answer is remembered for a minute, so the bridge is not asked on every call. `disconnect()` forgets the account token and the personal caches.

A `SessionTokenSource` should reject with `FxmError`s: `AuthRequired` when the login is off or unusable (the bridge's `login-disabled` and `private-tab`), `RateLimited` for its rate limit, `Network` for failures and timeouts.

## Errors and resilience

Every failure is a `SpotifyError`: an `FxmError` with a `reason`.

| Spotify answers | What happens |
|---|---|
| 401 | The token is dropped and the call repeated once with a fresh token. A second 401 is `AuthRequired` (`token-rejected`) |
| `403 Client/request not allowed` | `Unsupported` (`client-rejected`): the transport's User-Agent is refused. Not retried |
| Other 403 | `Unavailable` (`forbidden`) |
| 412 `Invalid query hash` | The operation is marked broken for the session: `Unavailable` (`operation-broken`), with no further requests for it |
| 400 with GraphQL validation errors | The same: Spotify no longer accepts the variables |
| GraphQL `errors` and no data | `Unavailable` (`graphql`) |
| `__typename: NotFound`, or 404 | `NotFound` (`not-found`) |
| Another error typename, e.g. `GenericError` | `Unavailable` (`graphql`) |
| 429 or 5xx | Retried after `Retry-After`, or with exponential backoff and jitter (waits of up to 0.5 s, 1 s and 2 s), at most 3 times. Then the whole provider pauses for 5 minutes (longer if `Retry-After` asks), and every call fails at once with `RateLimited` (`paused`, `retryAfterMs`). The optional server-time call is never retried: the local clock replaces it |
| A `Retry-After` beyond 10 s | Pauses at once instead of keeping the call waiting |
| Network failure or timeout (15 s) | `Network` (`network`), with URLs and bearer tokens redacted from the message |
| An operation without a hash in the config | `Unsupported` (`operation-unavailable`) |

`health()` reports the pauses and the broken operations for the UI, `onHealthChange` announces changes, and `resume()` ends the pauses early. Error messages never contain a token, a TOTP code, the secret or a token-request URL, and the provider logs nothing.

## Caching

In memory, with an injectable clock. Concurrent identical calls share one request, and failures are never cached.

| Data | Lifetime |
|---|---|
| Search | 10 minutes |
| Tracks, albums, artists, related artists, playlists and their pages | 6 hours |
| ISRC, label, release date (spclient `metadata/4`) | 24 hours |
| Home feed and its sections (anonymous and personal kept apart) | 30 minutes |
| Radio | 30 minutes |

Change them with the `cacheTtlMs` option. The library is not cached.

## Runtime config

`spotify-config.json` is versioned (`version`, `updated`) and holds:

- **`endpoints`**: the token, server-time, pathfinder and spclient URLs. Each must be `https:` on a `spotify.com` host, because the bearer token goes there, and none may be the official Web API (`api.spotify.com`).
- **`operations`**: the persisted-query hash of each operation, with the Spotify file it was found in. An operation without a hash stays disabled.
- **`secretSources`**: where the TOTP secret is fetched from by default, tried in order. These are URLs of community-maintained JSON files, found with a web search on 2026-10-25: `xyloflake/spot-secrets-go` (the replacement other projects switched to after the original `spotify-secrets` repository was taken down in October 2025) and `CycloneAddons/spotify-token-generator`. Both are served by `raw.githubusercontent.com` with `Access-Control-Allow-Origin: *`. **Only the URLs are in git, never a secret.** Users can pass other sources, a URL or pasted JSON, with `setSecretSources` or the `secretSources` option, and the web app can route the fetch through its own document with `secretFetch`.
- **`userAgent`**: the browser User-Agent for native transports.

`loadSpotifyConfig(candidate)` accepts a newer config, for example one fetched from FXM's static site, when it is valid and at least as new as the bundled one. Otherwise it keeps the bundled one, and it never throws. A Spotify hash change therefore ships as a config change. Pass the config to `createSpotifyProvider({ config })`.

## Clean-room log

This section is the Spotify clean-room log that the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks for (`CLEAN-ROOM.md` in this folder points here). The provider was written from protocol facts only: endpoints, operation names, persisted-query hashes, variables and field paths, recorded from Spotify's own web player and from FXM's own requests. **Nobody opened the AGPL plugin `sonic-liberation/spotube-plugin-spotify`, or any GPL project, while writing it, and no code or fixtures were copied from anywhere.**

### Persisted-query hashes

Each hash was found as a persisted-query definition, `("<operation>","query","<sha256Hash>")`, in Spotify's own web-player JavaScript, fetched from `https://open.spotifycdn.com/cdn/build/web-player/` on **2026-10-25 at 18:09 UTC**. The main bundle was named in `https://open.spotify.com/`, and the route chunks in the bundle's webpack chunk map. Each hash was then confirmed by a successful anonymous call the same day, except where noted.

| Operation | sha256Hash | Found in | Confirmed live |
|---|---|---|---|
| `searchDesktop` | `eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchTracks` | `b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchAlbums` | `202cb3305e31e5a0767ba7925f28bd728cf8f8b0217e6da43909056071cd70e9` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchArtists` | `7bf95d754fdbe32c8b161fbbe54d1ae50974900df4dce4c8f1afcbcad153224d` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchPlaylists` | `d520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1` | `xpui-routes-search.2aa27db9.js` | Yes |
| `getTrack` | `fe16b8083eec2305854db612ca75589bcb71e009dc7a4d014f29bd534a4c01f5` | `web-player.f954508a.js` | Yes |
| `getAlbum` | `0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f` | `web-player.f954508a.js` | Yes |
| `queryArtistOverview` | `9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6` | `web-player.f954508a.js` | Yes |
| `queryArtistRelated` | `3d031d6cb22a2aa7c8d203d49b49df731f58b1e2799cc38d9876d58771aa66f3` | `xpui-routes-artist.2459ba1a.js` | Yes |
| `fetchPlaylist` | `21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf` | `web-player.f954508a.js` | Yes |
| `home` | `5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1` | `web-player.f954508a.js` | Yes (anonymous) |
| `homeSection` | `5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1` (one document holds `home`, `homeSection` and `homePinnedSections`) | `web-player.f954508a.js` | Yes (anonymous) |
| `libraryV3` | `390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455` | `web-player.f954508a.js` | No: needs a login |
| `fetchLibraryTracks` | `087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240` | `web-player.f954508a.js` | No: needs a login |
| `profileAttributes` | `08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0` | `web-player.f954508a.js` | No: needs a login |

### Variables and field paths

- **Variables** come from the call sites of each operation in the same files. Examples: `searchDesktop` takes `{ searchTerm, offset, limit, numberOfTopResults, includeAudiobooks, includeArtistHasConcertsField, includePreReleases, includeAlbumPreReleases, includeAuthors, includeEpisodeContentRatingsV2, isPrefix, sectionFilters: ['GENERIC'] }`. `getAlbum` takes `{ uri, locale, offset, limit }`, `queryArtistOverview` `{ uri, locale, preReleaseV2 }`, `fetchPlaylist` `{ uri, offset, limit, enableWatchFeedEntrypoint, includeEpisodeContentRatingsV2 }`, and `home` `{ includeHomeChapterVideoCards, homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER', timeZone, sp_t, facet, sectionItemsLimit, includeEpisodeContentRatingsV2 }`. FXM sends the same shapes, with audiobooks, authors and pre-releases turned off.
- **Response field paths** come from FXM's own anonymous calls on 2026-10-25 (`data.searchV2.tracksV2.items[].item.data`, `data.trackUnion`, `data.albumUnion.tracksV2`, `data.artistUnion.relatedContent.relatedArtists`, `data.playlistV2.content.items[].itemV2.data`, `data.home.sectionContainer.sections`, spclient's `external_id[]` and `album.label`, and so on).
- **The library and profile** paths (`me.library.tracks`, a `UserLibraryTrackPage` of `{ addedAt, track: { _uri, data } }`; `me.libraryV3`, a `LibraryPage` of `{ item: { _uri, data } }`; `me.profile.name`) come from the web player's own response readers. They are not yet confirmed against a logged-in session, so `getLibraryTracks`, `getLibraryPlaylists` and the display name are tested on fixtures shaped after those readers only. Stage 3.5 confirms them.
- **The token flow, spclient radio and `metadata/4`** follow the protocol facts measured for the research memo of 2026-10-25, and were confirmed by FXM's own calls the same day. The TOTP key derivation is the community-documented transform (for example, the derived values discussed in `librespot-org/librespot#1475`, MIT). It was confirmed by minting an anonymous token with it.

### Fixtures

`fixtures/*.json` are FXM's own anonymous responses of 2026-10-25, trimmed to a few items each and sanitized:

- Share IDs, request and decision IDs, traces, colours, rights lines and the artist biography text are removed or replaced.
- The owners of user-made playlists, and their descriptions, are replaced with placeholders.
- Catalog facts (IDs, titles, artists, durations, dates, the ISRC) are kept.

The token answers and the TOTP secret in the tests are fake. No token, cookie or secret was ever recorded.

## Risks

- **Unofficial API.** These are Spotify's internal web-player APIs, not a public API. The token endpoint itself answers that "usage of this endpoint is not permitted under the Spotify Developer Terms and Developer Policy, and applicable law". Spotify sent cease-and-desist letters to similar projects in 2025 and 2026. The owner accepted this risk for a mostly personal-use project.
- **It may break at any time.** Spotify can rotate the TOTP secret, change persisted-query hashes, change response shapes, tighten the User-Agent check or rate-limit. The provider fails soft: each failure is typed, a broken operation stops being called, and repeated errors pause Spotify. FXM keeps working without Spotify, using YouTube Music radio and its other sources. Hash and endpoint changes ship as a config change, and secret rotations through the community sources or a user-supplied source.
- **The secret source is a third party.** The default secret URLs are community projects that could vanish, as the original one did in October 2025. FXM never mirrors the secret. Users can point FXM at another source.
- **Account use.** Spotify's User Guidelines forbid automated access and circumventing its technology, with suspension or termination as the remedy. There is no public report of an account actioned for metadata use. Account features are opt-in (stage 3.5 shows the notice).
- **Anonymous tokens are shared and cached by Spotify.** Three mints within half an hour returned the same token, so users behind one IP probably share a rate budget (inference).

## Testing

- `scripts/run.sh pnpm vitest run packages/sources/src/spotify` runs the offline tests. They cover the RFC 4226 and RFC 6238 vectors, base62 and hex, the secret shapes and failures (missing secret, malformed JSON, HTTP errors, unreachable URL, timeouts), the token manager (expiry, single flight, refresh after 401, the secret refetch and pause, logged-in tokens), the operation registry and config validation, the mapping of every fixture, the 401, 403 User-Agent, 412, 429 and 5xx paths, gating, radio seeds and every cache lifetime. A fake Spotify behind the injected `fetch` refuses any unknown URL, so no test can reach the network.
- `FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/spotify/live.test.ts` runs the live smoke test from Node with the browser User-Agent. It covers the anonymous token, search, artist, album, related artists, track radio, artist radio and the ISRC lookup in 12 requests to Spotify plus one to the secret source, and asserts fewer than 30. It prints nothing.
