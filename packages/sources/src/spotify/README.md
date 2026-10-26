# Spotify provider

`@fxm/sources/spotify` reads Spotify's metadata and recommendations for FXM: search, tracks, albums, artists, related artists, playlists, track and artist radio, the home feed, the ISRC of a track, and (with the user's account connected) the user's library. Spotify supplies metadata only, never audio: FXM plays a Spotify track by matching it to a song from another source.

It is **built into FXM and on by default** wherever the platform can reach Spotify, and the user can switch it off in Settings (owner's decision, 2026-10-25). It talks to Spotify's own web-player APIs from the user's device. FXM has no server in between.

```ts
import { createSpotifyProvider, sanitizeSpotifySettings } from '@fxm/sources/spotify'

// One instance per app: it holds the tokens, the caches and the pause state.
const settings = () => sanitizeSpotifySettings(stored.spotify)
const spotify = createSpotifyProvider({
  isEnabled: () => settings().enabled,         // the switch, on by default
  isAccountEnabled: () => settings().account,  // "Connect your account", off by default
  session: fxmConnectSessionBridge,            // optional: the user's own login (see below)
  onHealthChange: (health) => showSpotifyBanner(health),
})

if (spotify.isAvailable(ctx)) {
  const { tracks } = await spotify.search('radiohead creep', { types: ['track', 'artist'] }, ctx)
  const radio = await spotify.radio(tracks.items[0], ctx)
  const details = await spotify.getTrackDetails(tracks.items[0].id, ctx) // ISRC, label, date
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

1. **The TOTP secret.** A versioned secret behind the token endpoint's one-time code. FXM never ships it. The default secret provider fetches it at run time from the community-maintained JSON URLs in `spotify-config.json` (see [Runtime config](#runtime-config)) or from a source the user entered, and keeps it in memory for 6 hours.
   - Three JSON shapes are accepted: `{ "<version>": [numbers] }`, `[{ "version": n, "secret": [numbers] | "text" }]` and one such entry. The newest version wins. Its numbers become the HMAC key: each number is XORed with `(index % 33) + 9`, the results are written in decimal and joined, and the UTF-8 bytes of that text are the key.
   - A source is third-party data, so it is bounded: at most 64 KiB of JSON (an oversized `Content-Length` is refused before reading), secrets of at most 256 numbers, versions from 1 to 9999 (FXM Connect's bridge forwards at most four digits), a 5 s timeout including the body, no credentials.
   - When the 6 hours are up and the reload fails, the last good secret is kept (it works until Spotify refuses it) and the sources are asked again after 5 minutes, not on every call.
2. **The anonymous token.** `GET https://open.spotify.com/api/token?reason=init&productType=web-player&totp=…&totpServer=…&totpVer=…`. `totp` is the RFC 6238 code (HMAC-SHA1, 6 digits, 30 s, computed with WebCrypto) over the local clock, `totpServer` the same over Spotify's clock from `GET /api/server-time` (the local clock when that fails), and `totpVer` the secret's version. The answer is `{ accessToken, accessTokenExpirationTimestampMs, isAnonymous, clientId }`.
3. **The logged-in token.** The same request with `reason=transport`, sent with the user's own Spotify session cookies by a pluggable `SessionTokenSource`. On the web that is FXM Connect's opt-in session bridge (its `fxm-connect:spotify-token` message takes exactly these query parameters and returns `{ status, json }`). On desktop and Android it is the login window of later stages (7.4, 6.5). FXM's code never sees the cookies.

Tokens live in memory only and are never logged. A token is refreshed lazily when a call finds less than 60 s left, and only one refresh runs at a time. Spotify hands out the same anonymous token until it expires, so a fresh token that already has less than a minute left is used until it expires instead of being refreshed on every call. Expiry is measured on the device clock, corrected by Spotify's server time.

**An early refresh never pauses Spotify.** While the old token still works, the refresh is sent once, without retries. If it fails (a 429, a 5xx, a network error), the old token is used and the refresh is tried again after 15 s. Only a token that has expired is minted with retries, which pause the provider when the token endpoint keeps failing (see [Errors and resilience](#errors-and-resilience)). An account token is never used past a refusal: when the login source says the login is off, the cached token is dropped at once.

**When the secret fails, minting pauses and says so:**

- If the token endpoint refuses the TOTP (HTTP 400, also with `totpVerExpired` when the version is retired), the secret is fetched again, skipping a source that still serves the refused secret. If no source has another secret, or Spotify refuses the second one too, minting pauses for 5 minutes with `secret-rejected` ("Spotify is paused: its secret stopped working").
- If no source can be read at all (a takedown, GitHub down, offline), minting pauses with `secret-unavailable` after one round over the sources: 1 minute, doubling with each further failure up to 5 minutes. Calls during the pause fail at once without contacting the source.
- `health().secretPaused` says which, and until when. Offer "Try again" (`resume()`) and another secret source (`setSecretSources`), which ends the secret pause.

### Calls

| Need | Call |
|---|---|
| Search, several types | GraphQL `searchDesktop`, one call. The typed searches instead when `searchDesktop` breaks or is missing from the config |
| Search, one type or a later page | `searchTracks`, `searchAlbums`, `searchArtists`, `searchPlaylists` |
| Track | `getTrack` |
| Album with all its tracks | `getAlbum`, pages of 50 (up to 10 pages) |
| Artist page: top tracks, releases, 20 related artists | `queryArtistOverview` |
| Related artists (40) | `queryArtistRelated` |
| Playlist and its pages | `fetchPlaylist` (offset 0, limit 50 for the first page) |
| Radio for a track or an artist | spclient `GET /inspiredby-mix/v2/seed_to_playlist/<uri>?response-format=json` → `mediaItems[0].uri` → `fetchPlaylist` |
| ISRC, label, release date, album type, popularity | spclient `GET /metadata/4/track/<32-hex gid>?market=from_token` (the base62 ID converted with `spotifyIdToGid`) |
| Home feed and "show all" sections | `home`, `homeSection`. Generic for the market when anonymous, personal when the account is connected and logged in |
| Login status and display name | the token source, then `profileAttributes` |
| Liked songs, saved playlists (account, experimental) | `fetchLibraryTracks`, `libraryV3` |

GraphQL calls are `POST https://api-partner.spotify.com/pathfinder/v2/query` with `Authorization: Bearer …`, `Content-Type: application/json;charset=UTF-8`, `Accept: application/json` and the body `{ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash } } }`. FXM never calls the official Web API (`api.spotify.com/v1`), never writes to Spotify and does not use `clienttoken`.

### Mapping

Every Spotify track is a catalog song (`kind: 'song'`) with `externalIds.spotify` set to its base62 ID, `explicit` from its content rating, artwork, `durationMs`, track and disc numbers, and its album's release date. IDs are canonical: `spotify:<kind>:<22-character base62 ID>`. Spotify has no videos for FXM, so the `video` search type is always an empty page.

**Track details.** `getTrackDetails(id)` returns the ISRC (a property of the recording) and the label, release date and album type (`album`, `single`, `ep`, `compilation`) of the release Spotify lists the track on, plus its popularity. Look details up only for tracks being played, prefetched or imported. `getTrack` includes the ISRC once `getTrackDetails` has found it.

- `enrichTrack(track)` adds what a track lacks. A Spotify track gets the ISRC, release date and popularity. **A track of another source**, found through its `externalIds.spotify`, **gets only the ISRC**: Spotify's release date and popularity describe Spotify's release, which may not be the compilation or remaster the other source lists, and a wrong year would reach download tags and the matching engine's re-recording guard.
- The matching engine (1.7) builds its source from the track and its details, not from `enrichTrack`, because core's `Track` has no label or album type: `{ ...track, ...(await spotify.getTrackDetails(track.id, ctx)) }`.

**Links and IDs.** `parseSpotifyLink` reads pasted links and URIs, including the older playlist forms `open.spotify.com/user/<user>/playlist/<id>` and `spotify:user:<user>:playlist:<id>`. `spotifyEntityIdFromLink(text, kind?)` turns one straight into an FXM ID for imports and the search box. Every reader returns `null` for anything that is not a Spotify reference.

**Radio from another source's track.** A seed uses its `externalIds.spotify` when it has one. Otherwise (unless `lookupForeignSeeds: false`) one track search for "artist title" finds it, accepting only a result whose title core and artist match exactly. A leading "Artist - " and presentation noise such as "(Official Music Video)" are ignored. An artist seed without a Spotify ID is looked up by its exact name. The seed track itself is left out of the radio.

## The switch, reachability and the account

The settings are stored by the app; `sanitizeSpotifySettings(stored)` reads them safely and `DEFAULT_SPOTIFY_SETTINGS` is `{ enabled: true, account: false }`.

- **The switch** (`enabled`) is on unless `false` was stored explicitly. Wire it into the provider as `isEnabled`: the default, always on, ignores a stored `false`.
- **Reachability** is `ctx.capabilities.spotify`: `anonymous` or `account`, else unreachable.
- **`spotify.isAvailable(ctx)`** combines the provider's own `isEnabled` with reachability. Use it, or `isSpotifyAvailable(ctx, settings)` with the stored settings, to show Spotify results, radio and the source switch. The provider makes the same check on every call: `disabled` and `unreachable` both fail with `Unsupported` before any request.
- **The account** is a second, explicit opt-in (`account`, off by default), wired as `isAccountEnabled`. Offer "Connect your account" only when `isAvailable(ctx)` and `hasSpotifyLoginSource(ctx)` (`capabilities.spotify === 'account'`) are true. The account is used only while all of these hold, checked on every call, also when a token is cached: a `SessionTokenSource` was given, the capability is `account`, `isAccountEnabled()` is true, and `disconnect()` was not called. Otherwise account calls fail before any request with `account-unsupported` (no login source) or `account-disabled` (not connected), `home()` uses the generic feed, and `status()` answers "not connected" without asking anything.
- **`disconnect()`** (Settings → Disconnect) stops using the account at once: it forgets the account token, the remembered login state and the personal answers, and refuses account calls until **`connect()`**. Store `account: false` as well. Call `connect()` when the user turns the account on again, and right after they logged in to Spotify: it also forgets a remembered logged-out answer, which otherwise spares the login source for a minute.
- The personal answers (home feed, sections, profile name) are dropped whenever the account token changes, so a different Spotify account never sees the previous one's.

A `SessionTokenSource` should reject with `FxmError`s. The provider turns them into typed errors and keeps the original as `cause`:

| The source rejects with | The provider reports |
|---|---|
| `AuthRequired` (the bridge's `login-disabled`) | `login-required`, remembered for a minute |
| `Unsupported` (`private-tab`, `bad-request`, `unsupported`) | `account-unsupported`, remembered for a minute |
| `RateLimited` (`rate-limited`) | `rate-limited`, with its `retryAfterMs` |
| `Parse` (`too-large`) | `bad-response` |
| `Network`, or anything that is not an `FxmError` | `network` |

## Errors and resilience

Every failure of a provider call is a `SpotifyError`: an `FxmError` whose `reason` decides its `code` (`SPOTIFY_REASON_CODES`), so `isFxmError` works as for any provider and `isSpotifyError(error, reason)` tells the cases apart. Only a caller's own abort rejects with the signal's reason. Invalid arguments to the setters (a secret source that is not https, an invalid config) throw a `TypeError` at once, before anything changes.

| Spotify answers | What happens |
|---|---|
| 401 | The token is dropped and the call repeated once with a fresh token. A second 401 is `AuthRequired` (`token-rejected`) |
| `403 Client/request not allowed` | `Unsupported` (`client-rejected`): the transport's User-Agent is refused. Not retried; `health().clientRejected` is set |
| Other 403 | `Unavailable` (`forbidden`) |
| 412 `Invalid query hash` | The operation is marked broken: `Unavailable` (`operation-broken`), with no further requests for it until a config with a new hash (`setConfig`) or `resetOperations()` |
| 400 with GraphQL validation errors | The same: Spotify no longer accepts the variables |
| GraphQL `errors` and no data | `Unavailable` (`graphql`) |
| `__typename: NotFound`, 404, or a malformed ID | `NotFound` (`not-found`) |
| Another error typename, e.g. `GenericError` | `Unavailable` (`graphql`) |
| 429 or 5xx | Retried after `Retry-After`, or with exponential backoff and jitter (waits of up to 0.5 s, 1 s and 2 s), at most 3 times. Then the whole provider pauses for 5 minutes (longer if `Retry-After` asks), and every call fails at once with `RateLimited` (`paused`, `retryAfterMs`). The optional server-time call and an early token refresh are never retried |
| A `Retry-After` beyond 10 s | Pauses at once instead of keeping the call waiting. Only native transports see the header: a web page cannot read `Retry-After` until FXM Connect's Spotify rules expose it (`Access-Control-Expose-Headers`), so on the web the exponential backoff applies |
| Network failure or timeout (15 s) | `Network` (`network`), with URLs and bearer tokens redacted from the message |
| An operation without a hash in the config | `Unsupported` (`operation-unsupported`) |
| A page cursor the provider did not make | `Unsupported` (`bad-cursor`): load the first page again |

**Health.** `health()` returns `{ pausedUntil?, secretPaused?: { until, reason }, clientRejected?, brokenOperations }` for the UI ("Spotify is paused: …"), and `onHealthChange` announces every change. `resume()` ends both pauses early and forgets a refused client; `setSecretSources()` ends a secret pause but keeps a rate-limit pause; `setConfig()` clears the broken marks of the operations whose hash it changes and forgets a refused client. Error messages never contain a token, a TOTP code, the secret or a token-request URL, and the provider logs nothing.

## Caching

In memory, with an injectable clock. Concurrent identical calls share one request, and failures are never cached. **Every caller gets its own copy** of a cached answer, so sorting a list in place or appending "load more" items to a page cannot change what other callers see.

| Data | Lifetime |
|---|---|
| Search | 10 minutes |
| Tracks, albums, artists, related artists, playlists and their pages | 6 hours |
| ISRC, label, release date, album type (spclient `metadata/4`) | 24 hours |
| Home feed and its sections (anonymous and personal kept apart) | 30 minutes |
| Radio | 30 minutes |

Change them with the `cacheTtls` option (milliseconds). The library is not cached.

## Runtime config

`spotify-config.json` is versioned (`version`, `updated`) and holds:

- **`endpoints`**: the token, server-time, pathfinder and spclient URLs. Each must be `https:` on a `spotify.com` host, because the bearer token goes there, and none may be the official Web API (`api.spotify.com`).
- **`operations`**: the persisted-query hash of each operation, with the Spotify file it was found in. An operation without a hash stays disabled.
- **`secretSources`**: where the TOTP secret is fetched from by default, tried in order. These are URLs of community-maintained JSON files, found with a web search on 2026-10-25: `xyloflake/spot-secrets-go` (the replacement other projects switched to after the original `spotify-secrets` repository was taken down in October 2025) and `CycloneAddons/spotify-token-generator`. Both are served by `raw.githubusercontent.com` with `Access-Control-Allow-Origin: *`. A config may only name sources on GitHub's raw-file hosts (`SPOTIFY_SECRET_SOURCE_HOSTS`). **Only the URLs are in git, never a secret.**
- **`userAgent`**: the browser User-Agent for native transports, 1 to 512 printable ASCII characters.

No URL may carry a user name or password. `loadSpotifyConfig(candidate)` accepts a newer config, for example one fetched from FXM's static site, when it is valid and at least as new as the bundled one. Otherwise it keeps the bundled one, and it never throws. Apply the result to the running provider with `setConfig(config)`, which keeps tokens, caches and pauses, so a Spotify hash or User-Agent change ships as a config change. **The checks bound what a config can do but cannot tell a forged config from a genuine one:** the web app loads it from its own origin, like its code, and the desktop and Android apps must verify its signature (stage 1.13) before passing it in.

**Secret sources from Settings** ("the default, another URL, or pasted JSON"): `parseSpotifySecretSource(text)` turns what the user typed into a source, refusing anything but an `https:` URL on a public host (no `localhost`, no IP address, no user name or password) or JSON of at most 64 KiB that holds a usable secret, with a message Settings can show. Save it, then pass it to `setSecretSources([source])`; `setSecretSources()` without sources goes back to the config's. The web app passes `secretFetch`, which fetches through its sandboxed `userhost.html` document (GET only, size-capped), so the secret host never enters the main app's CSP.

## Privacy

Spotify is on by default wherever the platform can reach it, so the privacy page must name what it sends where:

| Host | What FXM sends | When |
|---|---|---|
| `open.spotify.com` | The TOTP and secret version (token); nothing else (server time) | When a token is minted, about once an hour. The account token request carries the user's Spotify cookies, but only through FXM Connect's bridge or the native login, never FXM's code |
| `api-partner.spotify.com` | Search terms; the IDs of tracks, albums, artists and playlists the user opens; for radio seeds from another source without a Spotify ID, the seed's "artist title" (`lookupForeignSeeds`, on by default); the device's time zone (home feed) | On each such action, minus cache hits |
| `spclient.wg.spotify.com` | Radio seeds (track or artist IDs); the IDs of tracks whose ISRC is looked up: tracks being played, prefetched or imported | On each such action, minus cache hits |
| `raw.githubusercontent.com` (GitHub; the default secret sources) | A GET without credentials, from the user's IP address | Once per 6 hours per app session (the secret is kept in memory only), again when Spotify refuses the secret, and after a failed load only once the pause ends; never when the user set their own source |
| A secret source the user entered | The same GET | The same |

Spotify sees the user's IP address and, with the account connected, the account. Nothing goes to FXM, which has no server.

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
- **Response field paths** come from FXM's own anonymous calls on 2026-10-25 (`data.searchV2.tracksV2.items[].item.data`, `data.trackUnion`, `data.albumUnion.tracksV2`, `data.artistUnion.relatedContent.relatedArtists`, `data.playlistV2.content.items[].itemV2.data`, `data.home.sectionContainer.sections`, spclient's `external_id[]`, `album.label` and `album.type`, and so on).
- **The library and profile** paths (`me.library.tracks`, a `UserLibraryTrackPage` of `{ addedAt: { isoString }, track: { _uri, data } }`; `me.libraryV3`, a `LibraryPage` of `{ item: { _uri, data } }`; `me.profile.name`) come from the web player's own response readers. They are not yet confirmed against a logged-in session, so `getLibraryTracks`, `getLibraryPlaylists` and the display name are tested on fixtures shaped after those readers only, and the two library calls are marked **experimental**: stage 3.5 confirms them and may change their shape. `getLibraryTracks` already returns `{ track, addedAt }` per liked song, so a sync can import only the songs liked since the last one.
- **The token flow, spclient radio and `metadata/4`** follow the protocol facts measured for the research memo of 2026-10-25, and were confirmed by FXM's own calls the same day. The TOTP key derivation is the community-documented transform (for example, the derived values discussed in `librespot-org/librespot#1475`, MIT). It was confirmed by minting an anonymous token with it.
- **The legacy playlist links** (`open.spotify.com/user/<user>/playlist/<id>`, `spotify:user:<user>:playlist:<id>`) are the forms older Spotify clients shared and exports still contain; they name the playlist by the same base62 ID.
- **Charts, editorial playlists, Spotify Singles and the data export**, which the matching evaluation's recorder (stage 1.12, [`../eval/`](../eval/README.md)) relies on, from FXM's own anonymous requests during its proof run on 2026-10-25 and Spotify's support pages on 2026-10-26:
  - Spotify's chart and editorial playlists are public playlists with base62 IDs (`37i9dQZEVXb…` for the Top 50 charts, `37i9dQZF1D…` for editorial ones) that `fetchPlaylist` reads with an anonymous token; Top 50 Global, Japan and India and Classical Essentials answered with 50 tracks each.
  - Spotify names its own recordings "<title> - Spotify Singles", on a single of the same name, and a track search for "Spotify Singles" finds them (its first hit was "Challa - Spotify Singles").
  - `metadata/4` answered the ISRC, label, release date, album type and popularity of all 8 chart and search tracks anonymously.
  - The "Download your data" export names one artist per stream in its streaming histories ("Name of the artist, band or podcast"; the "creator" of each stream), as Spotify's [Understanding my data](https://support.spotify.com/us/article/understanding-my-data/) describes it.

### Fixtures

`fixtures/*.json` are FXM's own anonymous responses of 2026-10-25, trimmed to a few items each and sanitized:

- Share IDs, request and decision IDs, traces, colours, rights lines and the artist biography text are removed or replaced.
- The owners of user-made playlists, and their descriptions, are replaced with placeholders.
- Catalog facts (IDs, titles, artists, durations, dates, the ISRC) are kept.

The token answers and the TOTP secret in the tests are fake. No token, cookie or secret was ever recorded.

### Cover images (stage 4.2)

| Fact | Source | Date |
|---|---|---|
| Spotify's image host (`i.scdn.co`) answers with `Access-Control-Allow-Origin: *`, so a page can read a cover's bytes with `fetch` and embed it in a saved file (`fetchCover` in `packages/convert`) | FXM's own `curl` request with `Origin: https://fxmusic.pages.dev`, the answer read and not kept | 2026-10-26 |

## Risks

- **Unofficial API.** These are Spotify's internal web-player APIs, not a public API. The token endpoint itself answers that "usage of this endpoint is not permitted under the Spotify Developer Terms and Developer Policy, and applicable law". Spotify sent cease-and-desist letters to similar projects in 2025 and 2026. The owner accepted this risk for a mostly personal-use project.
- **It may break at any time.** Spotify can rotate the TOTP secret, change persisted-query hashes, change response shapes, tighten the User-Agent check or rate-limit. The provider fails soft: each failure is typed, a broken operation stops being called, and repeated errors pause Spotify. FXM keeps working without Spotify, using YouTube Music radio and its other sources. Hash, endpoint and User-Agent changes ship as a config change (`setConfig`), and secret rotations through the community sources or a user-supplied source.
- **The secret source is a third party.** The default secret URLs are community projects that could vanish, as the original one did in October 2025, or serve a wrong secret. FXM never mirrors the secret, bounds what it reads, skips a source whose secret Spotify refused, and pauses instead of polling a dead source. Users can point FXM at another source.
- **Account use.** Spotify's User Guidelines forbid automated access and circumventing its technology, with suspension or termination as the remedy. There is no public report of an account actioned for metadata use. Account features are a second opt-in (`isAccountEnabled`, off by default; stage 3.5 shows the notice).
- **Anonymous tokens are shared and cached by Spotify.** Three mints within half an hour returned the same token, so users behind one IP probably share a rate budget (inference). An early refresh is therefore never retried.

## Testing

- `scripts/run.sh pnpm vitest run packages/sources/src/spotify` runs the offline tests. They cover the RFC 4226 and RFC 6238 vectors, base62 and gids, links and URIs, the secret shapes, limits and failures (missing secret, malformed JSON, oversized bodies, HTTP errors, unreachable URLs, timeouts, a refused secret, the stale secret after a failed reload, invalid sources), the token manager (expiry, single flight, early refreshes, refresh after 401, the secret pauses, logged-in tokens, the account checks, wrapped session errors, aborts), the operation registry and config validation, the mapping of every fixture, the 401, 403 User-Agent, 412, 429 and 5xx paths, gating, the account opt-in, radio seeds, copies and every cache lifetime. A fake Spotify behind the injected `fetch` refuses any unknown URL, so no test can reach the network.
- `FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/spotify/live.test.ts` runs the live smoke test from Node with the browser User-Agent. It covers the anonymous token, search, artist, album, related artists, track radio, artist radio and the ISRC lookup in 12 requests to Spotify plus one to the secret source, and asserts fewer than 30. It prints nothing.
