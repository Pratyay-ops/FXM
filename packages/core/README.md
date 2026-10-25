# @fxm/core

The vocabulary every FXM app shares: the domain model, the provider interfaces, the catalog-mode policy, the quality policy, text helpers for matching, and typed errors. Later stages add the queue, the matching engine, the playback policy and the recommendation engine here.

## Rules

- **Pure TypeScript.** No DOM, no Node APIs and no network, so the same code runs in a browser page, the Tauri desktop app, the Android app and Node. `tsconfig.json` enforces this by loading only the ES library.
- **Runtime-agnostic providers.** Core defines the interfaces; implementations live in `@fxm/sources` and receive the platform's `fetch` through a `ProviderContext`. They never use the global `fetch`.
- **Zero runtime dependencies** unless one is small, pure and justified.
- **Documented and tested.** Every export has TSDoc, and logic has offline unit tests (at least 90 % line coverage for `ids`, `mode`, `quality` and `text`). The type tests in `type-tests/` check the platform types under the DOM, web-worker and Node libraries.
- **Optional means absent.** Optional fields are `field?: T` under `exactOptionalPropertyTypes`: leave a field out when it is unknown, never set it to `undefined`.
- **Fail closed on bad data.** Values read from storage or imports go through the guards (`isEntityId`, `isCatalogMode`, `sanitizeQualityPrefs` and the like). The policies never trust names inherited from `Object.prototype`, such as `toString`.

## Modules

Everything is re-exported from `src/index.ts`, so import from `@fxm/core`.

| Module | What it holds |
|---|---|
| `ids.ts` | `SourceId`: a built-in source (`BuiltInSourceId`: `ytm`, `yt`, `spotify`, `archive`, `jamendo`, `local`) or a runtime plugin's (`PluginSourceId`, `plugin.<name>`, checked by `isPluginSourceId`). `EntityKind`, and the branded `EntityId<K>` = `<source>:<kind>:<nativeId>`. `formatId` builds one. `parseId` splits one: it never returns `null` for a branded ID and never throws for anything else. `isEntityId` checks untrusted values. `entityKey` and `sameEntity` de-duplicate, and `normalizeIsrc` gives the canonical ISRC. Native IDs may contain `:`. |
| `model.ts` | `Track` (with `kind`: `song`, `music-video`, `video`, `episode`), `Album`, `Artist`, `Playlist`, `Artwork`, `ArtistRef`, `AlbumRef`, `Page<T>`, home-feed `Shelf`s, and `SearchResults`, where songs (`tracks`) and videos (`videos`) are paged separately. Also the `isTrackSeed` guard. |
| `mode.ts` | `CatalogMode` (`music` = "Music", `all` = "Music + Video") and the one policy every feature goes through: `modePolicy` (`playable`, `needs-song-match`, `hidden`). `applyModeFilter` filters lists to show; `isPlayable` and `filterPlayable` filter what is about to play, such as audio candidates. In Music mode an official music video must be mapped to its song first, and other videos are hidden. |
| `quality.ts` | `Codec`, `Container`, `QualityTier` with `tierOf` (documented per-codec thresholds), and `compareStreams` and `pickStream` to rank streams and apply a tier ceiling. `DownloadFormat` with `DOWNLOAD_FORMATS` and `describeConversion` (honest labels such as "FLAC (converted from Opus, same quality as the source)"). `QualityPrefs` with `DEFAULT_QUALITY_PREFS` (read-only), `DEFAULT_MP3_KBPS`, `sanitizeQualityPrefs` and the value guards. |
| `providers.ts` | `MetadataProvider` (search, an optional `suggest` and the entity pages), `RecommendationProvider`, the two-phase `AudioSource` (`match` returns ranked `AudioCandidate`s with confidence and evidence; `resolve` returns `StreamOption`s), `LyricsProvider`, `AccountProvider`, and `ProviderContext` with the injected `Fetch`, `Platform` and `NetworkCapabilities` (how far YouTube and Spotify can be reached, see below). Types only. |
| `text.ts` | Matching helpers: `normalizeText`, `splitTitle` (core, qualifiers, featured artists), `stripPresentationNoise` and `extractVersionTags` (strong, medium and soft version tags). |
| `errors.ts` | `FxmError` with a `code` (`NotFound`, `RateLimited`, `AuthRequired`, `Unavailable`, `GeoBlocked`, `Expired`, `BotCheck`, `Unsupported`, `Network`, `Parse`), an optional `cause` and `retryAfterMs`, plus the `isFxmError` guard. |

### Canonical native IDs

Likes, follows, history, playlists and the caches are keyed by IDs that several providers create independently, so each source spells its native IDs one way only:

| Source | Native ID |
|---|---|
| `ytm`, `yt` | YouTube's own ID, bare: the videoId for tracks, the browseId (`MPREb_…`) for albums, the channelId (`UC…`) for artists, and the playlistId without the `VL` browse prefix for playlists |
| `spotify` | The 22-character base62 ID, never a `spotify:track:…` URI or an open.spotify.com URL |
| `archive` | The item identifier for albums, and `<identifier>/<file path>` for tracks |
| `jamendo` | Jamendo's numeric ID, in decimal |
| `local` | An ID that the local-files feature chooses, stable across rescans of the same file |
| `plugin.<name>` | Whatever the plugin chooses, opaque to FXM: it is never parsed, normalized or merged with another source's IDs, so the plugin itself must spell each entity's ID one way only |

YouTube Music and plain YouTube share one ID space. An item gets `ytm` when it came from YouTube Music, whatever its kind (a song, an official video, or an upload found there), and `yt` only when it came from plain YouTube. The same video can therefore have both IDs, and `entityKey` gives them one key (`youtube:track:<videoId>`) for storage and de-duplication.

Audio follows the same rules. An `AudioCandidate`'s `source` is the audio source that resolves it, and `formatId(source, 'track', ref)` is its track ID. YouTube has a single audio source, `ytm`, for every videoId.

ISRCs are stored in their canonical form, 12 upper-case characters without separators (`GBARL9300135`), through `normalizeIsrc`.

### Plugin sources

Runtime plugins (a later stage) add sources of their own. A plugin source ID is `plugin.` and the plugin's name, such as `plugin.radio-garden`. The name follows the rule for a DNS label: 1 to 63 lower-case ASCII letters, digits and hyphens, neither starting nor ending with a hyphen. So it has one spelling only, never contains the `:` that separates the parts of an ID, and can never take the ID of a built-in source, present or future.

`isSourceId`, `formatId`, `parseId` and `isEntityId` accept the six built-in sources, spelled exactly, and any plugin source whose name is well formed. A plugin's native IDs are opaque (see the table above), so `entityKey` keys every plugin ID by itself and never merges it with another source's.

### Choosing a stream

`AudioSource.resolve` returns every usable `StreamOption`, best first, and never drops one because of the preferences, because the same list serves playback and downloads. The caller decides:

- **Playback** removes the options the player cannot decode, then calls `pickStream(options, prefs.streaming.wifi)` (or `.cellular`). The tier is a ceiling: it plays the best option at or below it, and the lowest option above it when nothing is at or below it.
- **Downloads** take the best option, such as a real FLAC original, and label any conversion with `describeConversion`.

For SABR streams, `url` holds the server ABR streaming URL, and `playback` carries the session parameters as JSON.

### What the platform can reach

`ProviderContext.capabilities` grades YouTube and Spotify instead of answering yes or no. Each level allows everything the one before it does.

| `youtube` | Where | What works |
|---|---|---|
| `none` | A plain web page | No YouTube at all |
| `simple` | The web app's experimental Lite tier, which needs no install | InnerTube calls (search, browse, `next`, `player`) as CORS-simple POSTs from a sandboxed document with an opaque origin, and playback through `<audio src>`. googlevideo's bytes can't be read: no downloads, no end-of-file range probes, no equalizer, and no deciphering or PO-token rungs |
| `full` | FXM Connect, the desktop app, the Android app | Everything, including reading media bytes |

| `spotify` | Where | What works |
|---|---|---|
| `unreachable` | A plain web page | No Spotify at all |
| `anonymous` | FXM Connect without its session bridge | Anonymous web-player tokens |
| `account` | FXM Connect with the session bridge the user turned on, the desktop and Android login windows | A logged-in token source as well. Whether the user is logged in is up to `AccountProvider.status` |

The user's Spotify on/off switch is an app setting, not a capability: FXM uses Spotify only when the switch is on and `spotify` is not `unreachable`. `mediaBytes` is always `false` when `youtube` is `simple` or `none`.

### The injected `Fetch`

`Fetch` is exactly `typeof fetch` in any program that has a global `fetch` (DOM, web worker or Node types), so `window.fetch`, the Tauri HTTP plugin's `fetch`, a Capacitor wrapper or Node's `fetch` can be passed as is. Core's own ES-only type check has no global `fetch`, so there it falls back to `MinimalFetch`, the subset providers rely on, which every platform `fetch` also satisfies. `AbortSignalLike` works the same way for `AbortSignal`.

`pnpm --filter @fxm/core typecheck` proves this. It checks core once with only the ES library, then once each under the DOM, web-worker and Node libraries (`type-tests/`). So core code that type-checks only without a platform library fails here, not later in an app.

### Matching text, step by step

The text helpers are heuristics, so they work best in this order:

1. `stripPresentationNoise`: drop "(Official Music Video)", "[Lyrics]", "in HD" and similar.
2. Remove a leading "Artist - " when the artist is known (the matching engine knows it). Otherwise a title that is a version word ("Depeche Mode - Stripped") or starts like a version ("The Rolling Stones - Live With Me") reads as a suffix.
3. `splitTitle`: separate the core title from qualifiers such as "(Live)" or " - 2013 Remaster" and from featured artists. It recognizes dash suffixes with the same vocabulary as `extractVersionTags`.
4. `extractVersionTags` on the qualifiers, so a live, remixed, sped-up or dubbed version never passes for the studio recording.
5. `normalizeText` on the core before comparing.

See [ARCHITECTURE.md §7](../../docs/ARCHITECTURE.md#7-core-concepts).
