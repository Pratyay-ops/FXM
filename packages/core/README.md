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
| `ids.ts` | `SourceId`: a built-in source (`BuiltInSourceId`: `ytm`, `yt`, `spotify`, `archive`, `jamendo`, `local`, checked exactly by `isBuiltInSourceId`) or a runtime plugin's (`PluginSourceId`, `plugin.<name>`, whose name `isPluginSourceId` checks). `EntityKind`, and the branded `EntityId<K>` = `<source>:<kind>:<nativeId>`. `formatId` builds one. `parseId` splits one: it never returns `null` for a branded ID and never throws for anything else. `isEntityId` checks untrusted values. `entityKey` and `sameEntity` de-duplicate, and `normalizeIsrc` gives the canonical ISRC. Native IDs may contain `:`. |
| `model.ts` | `Track` (with `kind`: `song`, `music-video`, `video`, `episode`, and for a music video an optional `songId` linking its song), `Album`, `Artist`, `Playlist`, `Artwork`, `ArtistRef`, `AlbumRef`, `Page<T>`, home-feed `Shelf`s, and `SearchResults`, where songs (`tracks`) and videos (`videos`) are paged separately. Also the `isTrackSeed` guard. |
| `mode.ts` | `CatalogMode` (`music` = "Music", `all` = "Music + Video") and the one policy every feature goes through: `modePolicy` (`playable`, `plays-linked-song`, `needs-song-match`, `hidden`). `applyModeFilter` filters lists to show; `isPlayable` and `filterPlayable` filter what is about to play, such as audio candidates. In Music mode an official music video plays only as its song (see below), and other videos are hidden. `songForVideo` gives the song a music video links to. Each reads a `ModeInput`: the item's `kind` and, for a music video, its `songId` and own `id`. |
| `quality.ts` | `Codec`, `Container`, `QualityTier` with `tierOf` (documented per-codec thresholds; only FLAC, ALAC and PCM are ever `lossless`, so YouTube's Opus and AAC never are, at any bitrate), and `compareStreams` and `pickStream` to rank streams and apply a tier ceiling, never choosing a stream whose `FullLengthCheck` is `capped`, and preferring audio only to a muxed video (`StreamMedia`) of the same tier. `DownloadFormat` with `DOWNLOAD_FORMATS` and `describeConversion` (honest labels such as "FLAC (converted from Opus, same quality as the source)"). `QualityPrefs` with `DEFAULT_QUALITY_PREFS` (read-only), `DEFAULT_MP3_KBPS`, `sanitizeQualityPrefs` and the value guards. |
| `providers.ts` | `MetadataProvider` (search, an optional `suggest` and the entity pages), `RecommendationProvider` (`radio`, an optional `radioPage` for stations that go on, and an optional `home`), the two-phase `AudioSource` (`match` returns ranked `AudioCandidate`s with confidence, evidence and, once computed, `MatchSignals`: ISRC verified, release, year, label and album match; `resolve` returns `StreamOption`s, each saying whether its URL delivers the whole file and whether it is audio or a muxed video), `LyricsProvider`, `AccountProvider`, and `ProviderContext` with the injected `Fetch`, `Platform` and `NetworkCapabilities` (how far YouTube and Spotify can be reached, see below). Types only. |
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

Audio follows the same rules. An `AudioCandidate`'s `source` is the audio source that resolves it, and `formatId(source, 'track', ref)` is its track ID. YouTube has a single audio source, `ytm`, for every videoId. The optional `signals.releaseId` is a native ID of the same source, so `formatId(source, 'album', releaseId)` is the candidate's album, e.g. `ytm:album:MPREb_…`. Providers that don't compute the signals leave them out, and the matching engine fills them in; `evidence` stays as text for people.

ISRCs are stored in their canonical form, 12 upper-case characters without separators (`GBARL9300135`), through `normalizeIsrc`.

### Plugin sources

Runtime plugins (a later stage) add sources of their own. A plugin source ID is `plugin.` and the plugin's name, such as `plugin.radio-garden`. The name follows the rule for a DNS label: 1 to 63 lower-case ASCII letters, digits and hyphens, neither starting nor ending with a hyphen. So it has one spelling only, never contains the `:` that separates the parts of an ID, and can never take the ID of a built-in source, present or future.

`isSourceId`, `formatId`, `parseId` and `isEntityId` accept the six built-in sources, spelled exactly, and any plugin source whose name is well formed. A plugin's native IDs are opaque (see the table above), so `entityKey` keys every plugin ID by itself and never merges it with another source's.

To branch on a source, use `isBuiltInSourceId`. It is exact, so for a `SourceId`, `false` means a plugin source. `isPluginSourceId` checks a name from untrusted input, such as a plugin's manifest; don't branch on it. The `PluginSourceId` type accepts any `plugin.` string, so a malformed one such as `plugin.Radio`, which untyped plugin code can hand over, fails the check, and TypeScript would then take it for a built-in source.

### Music videos in Music mode

Music mode plays songs only, so an official music video never plays as itself there. What happens depends on whether its source links it to its song:

| A music video… | `modePolicy` in Music mode | What plays |
|---|---|---|
| with a song link (`Track.songId`) | `plays-linked-song` | The song from `songForVideo(track)`, handled like any other song: a YouTube Music song plays with no matching needed, while one from a source without audio of its own, such as Spotify, is matched to audio first |
| without one | `needs-song-match` | The song the matching engine maps it to; hidden when there is no confident match |

YouTube Music's album pages link official videos to their songs, so the YouTube provider sets `songId` from them. Anonymous search and `next` results carry no such link, so the matching engine still covers those. Music + Video mode plays every music video as it is (`playable`), linked or not. Neither verdict passes `isPlayable`, so the video itself is never an audio candidate in Music mode, and `applyModeFilter` keeps both in lists to show.

The linked song is a track like any other: load it and check it with `isPlayable`, which in Music mode only a song passes. If it doesn't pass, treat the video as `needs-song-match`, and never follow a second link. A `songId` counts as no link when it isn't a valid track ID, when it is on a track of another kind, and when it names the video itself: its own `id`, or its videoId under the other YouTube prefix (`yt:track:x` on the video `ytm:track:x`). A provider could copy such a link from an album page that lists the video itself, and following it would play the video in Music mode. A video whose own `id` isn't a valid track ID, which only bad data holds, has no link either.

### What the platform can reach

`ProviderContext.capabilities` grades YouTube and Spotify instead of answering yes or no. Each level allows everything the one before it does.

| `youtube` | Where | What works |
|---|---|---|
| `none` | A plain web page without the Lite tier | No YouTube at all |
| `simple` | The web app's experimental Lite tier, which needs no install | InnerTube calls (search, browse, `next`, `player`) as CORS-simple POSTs from a sandboxed document with an opaque origin, and playback through `<audio src>`. googlevideo's bytes can't be read: no downloads, no end-of-file range probes, no equalizer, and no deciphering, PO-token or SABR rungs (SABR reads those bytes) |
| `full` | FXM Connect, the desktop app, the Android app | Everything, including reading media bytes |

Providers call `ctx.fetch` on every tier. In the `simple` tier, the web app's `fetch` routes InnerTube requests through the sandboxed document, and providers must keep those requests CORS-simple: a `text/plain` POST body and no custom headers, so visitorData goes in the request body rather than in an `X-Goog-Visitor-Id` header.

| `spotify` | Where | What works |
|---|---|---|
| `unreachable` | A plain web page, the Lite tier included | No Spotify at all |
| `anonymous` | FXM Connect without its session bridge | Anonymous web-player tokens |
| `account` | FXM Connect with the session bridge the user turned on, the desktop and Android login windows | A logged-in token source as well. Whether the user is logged in is up to `AccountProvider.status` |

The user's Spotify on/off switch is an app setting, not a capability: FXM uses Spotify only when the switch is on and `spotify` is not `unreachable`. `mediaBytes` is always `false` when `youtube` is `simple` or `none`, and the type enforces it: `NetworkCapabilities` is a union on `youtube`, in which only `full` lets `mediaBytes` be `true`.

### Choosing a stream

`AudioSource.resolve` returns every `StreamOption` it found, best first, and never drops one because of the preferences, because the same list serves playback and downloads. The caller decides:

- **Playback** removes the options the player cannot decode, then calls `pickStream(options, prefs.streaming.wifi)` (or `.cellular`). The tier is a ceiling: it plays the best option at or below it, and when nothing is at or below it, the option that exceeds it least.
- **Downloads** take the best option, such as a real FLAC original, with `pickStream(options, 'lossless')`, and label any conversion with `describeConversion`.

"Best" is the order of `compareStreams`: a `capped` option comes last (see below), and the others go by tier, then audio only before a muxed video, then by bitrate.

**Capped URLs.** YouTube caps the stream URLs of most of its clients: they answer 403 after roughly 0.4–2 MiB, and only some are served in full. So wherever the bytes can be read (`capabilities.mediaBytes`), the resolver probes the last 64 KB of the file, and every option records the outcome in the required `fullLength` field:

| `fullLength` | Meaning |
|---|---|
| `verified` | The end-of-file range probe succeeded |
| `unverified` | No probe: the bytes can't be read (the `simple` YouTube tier) or the resolver didn't probe. Sources that never cap their URLs, such as Internet Archive, are `unverified` too unless probed |
| `capped` | A probe showed that the URL stops early. It must never be played or downloaded: `compareStreams` ranks it after every other option, and `pickStream` never picks it, so playback and downloads both skip it |

**Muxed video.** The required `media` field is `audio` or `muxed-video`. YouTube's last-resort rung is itag 18, a 360p MP4 whose AAC track FXM plays, or extracts for a download. Its `codec`, `bitrateKbps` and `tier` describe that audio track (AAC at about 96 kbps is `normal`), and its `container` is the video file's.

A muxed video costs more data than audio of the same quality, so `compareStreams` ranks it after the audio-only options of its tier, whatever its bitrate, and `pickStream` takes it only when its tier has no usable audio-only option. Under the default mobile-data ceiling (`normal`), Opus 250 at about 70 kbps plays, not itag 18; itag 18 plays when, for example, probes found every audio-only URL capped. The tier still comes first, so itag 18 beats an audio-only option of a lower tier. Trading that quality for data, e.g. on mobile data, is up to the playback policy, which can pick from the audio-only options first and fall back to all of them.

For SABR streams, `url` holds the server ABR streaming URL, and `playback` carries the session parameters as JSON.

### The injected `Fetch`

`Fetch` is exactly `typeof fetch` in any program that has a global `fetch` (DOM, web worker or Node types), so `window.fetch` (or the web app's `fetch` built on it, which in the `simple` YouTube tier routes InnerTube requests through a sandboxed document), the Tauri HTTP plugin's `fetch`, a Capacitor wrapper or Node's `fetch` can be passed as is. Core's own ES-only type check has no global `fetch`, so there it falls back to `MinimalFetch`, the subset providers rely on, which every platform `fetch` also satisfies. `AbortSignalLike` works the same way for `AbortSignal`.

`pnpm --filter @fxm/core typecheck` proves this. It checks core once with only the ES library, then once each under the DOM, web-worker and Node libraries (`type-tests/`). So core code that type-checks only without a platform library fails here, not later in an app.

### Matching text, step by step

The text helpers are heuristics, so they work best in this order:

1. `stripPresentationNoise`: drop "(Official Music Video)", "[Lyrics]", "in HD" and similar.
2. Remove a leading "Artist - " when the artist is known (the matching engine knows it). Otherwise a title that is a version word ("Depeche Mode - Stripped") or starts like a version ("The Rolling Stones - Live With Me") reads as a suffix.
3. `splitTitle`: separate the core title from qualifiers such as "(Live)" or " - 2013 Remaster" and from featured artists. It recognizes dash suffixes with the same vocabulary as `extractVersionTags`.
4. `extractVersionTags` on the qualifiers, so a live, remixed, sped-up or dubbed version never passes for the studio recording.
5. `normalizeText` on the core before comparing.

See [ARCHITECTURE.md §7](../../docs/ARCHITECTURE.md#7-core-concepts).
