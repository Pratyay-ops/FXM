# @fxm/core

The vocabulary every FXM app shares: the domain model, the provider interfaces, the catalog-mode policy, the quality policy, text helpers for matching, and typed errors. Later stages add the queue, the matching engine, the playback policy and the recommendation engine here.

## Rules

- **Pure TypeScript.** No DOM, no Node APIs and no network, so the same code runs in a browser page, the Tauri desktop app, the Android app and Node. `tsconfig.json` enforces this by loading only the ES library.
- **Runtime-agnostic providers.** Core defines the interfaces; implementations live in `@fxm/sources` and receive the platform's `fetch` through a `ProviderContext`. They never use the global `fetch`.
- **Zero runtime dependencies** unless one is small, pure and justified.
- **Documented and tested.** Every export has TSDoc, and logic has offline unit tests (at least 90 % line coverage for `ids`, `mode`, `quality` and `text`).
- **Optional means absent.** Optional fields are `field?: T` under `exactOptionalPropertyTypes`: leave a field out when it is unknown, never set it to `undefined`.

## Modules

Everything is re-exported from `src/index.ts`, so import from `@fxm/core`.

| Module | What it holds |
|---|---|
| `ids.ts` | `SourceId` (`ytm`, `yt`, `spotify`, `archive`, `jamendo`, `local`, `jiosaavn`), `EntityKind`, and the branded `EntityId<K>` = `<source>:<kind>:<nativeId>` with `formatId`, `parseId` (returns `null`, never throws) and `isEntityId`. Native IDs may contain `:`. |
| `model.ts` | `Track` (with `kind`: `song`, `music-video`, `video`, `episode`), `Album`, `Artist`, `Playlist`, `Artwork`, `ArtistRef`, `AlbumRef`, `Page<T>`, `SearchResults` and home-feed `Shelf`s. Types only. |
| `mode.ts` | `CatalogMode` (`music` = "Music", `all` = "Music + Video") and the one policy every feature goes through: `modePolicy` (`playable`, `needs-song-match`, `hidden`) and `applyModeFilter`. In Music mode an official music video must be mapped to its song first, and other videos are hidden. |
| `quality.ts` | `Codec`, `Container`, `QualityTier` with `tierOf` (documented per-codec thresholds), `DownloadFormat` with `DOWNLOAD_FORMATS` and `describeConversion` (honest labels such as "FLAC (converted from Opus, same quality as the source)"), and `QualityPrefs` with `DEFAULT_QUALITY_PREFS`. |
| `providers.ts` | `MetadataProvider`, `RecommendationProvider`, two-phase `AudioSource` (`match` returns ranked `AudioCandidate`s with confidence and evidence; `resolve` returns `StreamOption`s), `LyricsProvider`, `AccountProvider`, and `ProviderContext` with the injected `Fetch`, `Platform` and `NetworkCapabilities`. Types only. |
| `text.ts` | Matching helpers: `normalizeText`, `splitTitle` (core, qualifiers, featured artists), `stripPresentationNoise` and `extractVersionTags` (strong, medium and soft version tags). |
| `errors.ts` | `FxmError` with a `code` (`NotFound`, `RateLimited`, `AuthRequired`, `Unavailable`, `GeoBlocked`, `Expired`, `BotCheck`, `Unsupported`, `Network`, `Parse`), an optional `cause` and `retryAfterMs`, plus the `isFxmError` guard. |

### The injected `Fetch`

`Fetch` is exactly `typeof fetch` in any program that has a global `fetch` (DOM, web worker or Node types), so `window.fetch`, the Tauri HTTP plugin's `fetch`, a Capacitor wrapper or Node's `fetch` can be passed as is. Core's own ES-only type check has no global `fetch`, so there it falls back to `MinimalFetch`, the subset providers rely on. `AbortSignalLike` works the same way for `AbortSignal`.

### Matching text, step by step

The text helpers are heuristics, so they work best in this order:

1. `stripPresentationNoise`: drop "(Official Music Video)", "[Lyrics]", "HD" and similar.
2. Remove a leading "Artist - " when the artist is known (the matching engine knows it).
3. `splitTitle`: separate the core title from qualifiers such as "(Live)" or " - 2013 Remaster" and from featured artists.
4. `extractVersionTags` on the qualifiers, so a live, remixed or sped-up version never passes for the studio recording.
5. `normalizeText` on the core before comparing.

See [ARCHITECTURE.md §7](../../docs/ARCHITECTURE.md#7-core-concepts).
