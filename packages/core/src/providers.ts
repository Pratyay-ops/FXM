/**
 * Provider interfaces: where metadata, recommendations, audio, lyrics and accounts come from.
 * Types only.
 *
 * Providers run on the user's own device (a browser page, the Tauri desktop app or the Android
 * app) with an injected {@link Fetch}; FXM has no servers of its own. Every call receives a
 * {@link ProviderContext} that says what the platform can reach. Failures reject with an
 * `FxmError` (see `errors.ts`).
 *
 * @module
 */

import type { EntityId, SourceId } from './ids'
import type { MatchSourceExtras, MatchVerdict } from './matching/types'
import type { CatalogMode } from './mode'
import type {
  Album,
  Artist,
  ArtistRef,
  Page,
  Playlist,
  SearchResults,
  SearchType,
  Shelf,
  Track,
  TrackKind,
} from './model'
import type {
  Codec,
  Container,
  FullLengthCheck,
  QualityPrefs,
  QualityTier,
  StreamMedia,
} from './quality'

/**
 * The parts of `RequestInit` that providers use. Only relevant where the program has no global
 * `fetch` (see {@link Fetch}).
 */
export interface MinimalRequestInit {
  /** HTTP method, `GET` when absent. */
  method?: string
  /** Request headers. */
  headers?: Record<string, string>
  /**
   * Request body. Bytes must be backed by an `ArrayBuffer` (not a `SharedArrayBuffer`), which is
   * what the platform `fetch` types accept.
   */
  body?: string | Uint8Array<ArrayBuffer>
  /** Cancels the request. */
  signal?: AbortSignalLike
}

/**
 * The parts of `Response` that providers use. Only relevant where the program has no global
 * `fetch` (see {@link Fetch}).
 */
export interface MinimalResponse {
  /** Whether the status is 200-299. */
  readonly ok: boolean
  /** HTTP status code. */
  readonly status: number
  /** HTTP status text. */
  readonly statusText: string
  /** Final URL after redirects. */
  readonly url: string
  /** Response headers. */
  readonly headers: { get(name: string): string | null }
  /** Reads the body as text. */
  text(): Promise<string>
  /** Reads the body as JSON. */
  json(): Promise<unknown>
  /** Reads the body as bytes. */
  arrayBuffer(): Promise<ArrayBuffer>
}

/** The subset of `fetch` that providers rely on. See {@link Fetch}. */
export type MinimalFetch = (input: string, init?: MinimalRequestInit) => Promise<MinimalResponse>

/**
 * The `fetch` a provider must use for every request, as `ctx.fetch`, on every platform and tier;
 * providers never touch the global one. The platform injects it: in a browser page, a `fetch`
 * built on `window.fetch` (YouTube and Spotify answer it only through the FXM Connect extension,
 * and in the `simple` YouTube tier it routes InnerTube requests through a sandboxed document,
 * see {@link YouTubeAccess}), the Tauri HTTP plugin's `fetch` on desktop, a native-HTTP wrapper
 * on Android, or Node's `fetch` in tests and scripts.
 *
 * In any program that has a global `fetch` (DOM, web worker or Node types) this is exactly
 * `typeof fetch`, so every implementation above can be passed as is. `@fxm/core` itself loads
 * only the ES library, so in its own type check it falls back to {@link MinimalFetch}, which
 * the platform `fetch` also satisfies. `type-tests/platform.ts` checks both in each program.
 */
export type Fetch = typeof globalThis extends { fetch: infer F } ? F : MinimalFetch

/** What {@link AbortSignalLike} falls back to where the program has no global `AbortSignal`. */
export interface MinimalAbortSignal {
  /** Whether the operation was cancelled. */
  readonly aborted: boolean
  /** Why it was cancelled. */
  readonly reason: unknown
}

/**
 * The platform's `AbortSignal`: exactly the global type in any program that has one (DOM, web
 * worker or Node types), {@link MinimalAbortSignal} in `@fxm/core`'s own ES-only type check.
 */
export type AbortSignalLike = typeof globalThis extends { AbortSignal: { prototype: infer S } }
  ? S
  : MinimalAbortSignal

/** The app FXM runs in. */
export type Platform = 'web' | 'desktop' | 'android'

/**
 * How far the platform reaches YouTube and YouTube Music. Each level allows everything the one
 * before it does:
 *
 * - `none`: no YouTube at all (a plain web page without the Lite tier)
 * - `simple`: the web app's experimental Lite tier, which needs no install. InnerTube calls
 *   (search, browse, `next` and `player`) work as CORS-simple POSTs from a sandboxed document
 *   with an opaque origin, but googlevideo's bytes cannot be read: no downloads, no end-of-file
 *   range probes and no equalizer, and the resolver's deciphering and PO-token rungs are
 *   unavailable, as is its SABR rung, which reads googlevideo's bytes. Audio plays through
 *   `<audio src>` directly. Providers must keep their InnerTube requests CORS-simple here: a
 *   `text/plain` POST body and no custom headers, so visitorData goes in the request body
 *   rather than in an `X-Goog-Visitor-Id` header
 * - `full`: everything, including reading media bytes: the web app with FXM Connect, the desktop
 *   app or the Android app
 */
export type YouTubeAccess = 'none' | 'simple' | 'full'

/**
 * How far the platform reaches Spotify. Each level allows everything the one before it does:
 *
 * - `unreachable`: no Spotify at all (a plain web page, the Lite tier included)
 * - `anonymous`: anonymous web-player tokens can be fetched
 * - `account`: a logged-in token source exists too: FXM Connect's session bridge once the user
 *   has turned it on, or a login window on desktop and Android. Whether the user is logged in
 *   is up to `AccountProvider.status`
 *
 * This is separate from the user's Spotify on/off switch, which lives in the app settings: FXM
 * uses Spotify only when the switch is on and Spotify is not `unreachable`.
 */
export type SpotifyAccess = 'unreachable' | 'anonymous' | 'account'

/** What {@link NetworkCapabilities} hold whatever the platform's YouTube access. */
interface CommonCapabilities {
  /**
   * How far Spotify can be reached: `unreachable`, `anonymous` or `account`, whatever the user's
   * Spotify switch says.
   */
  spotify: SpotifyAccess
  /** Can write files outside browser storage. */
  fileSystem: boolean
}

/**
 * What the platform's network stack can do, which decides the providers and pipes on offer.
 *
 * It is a union on `youtube`, so that only `full` YouTube access can claim to read media bytes:
 * with `none` or `simple`, `mediaBytes` is always `false`. A platform that works out its access
 * at run time therefore checks `youtube === 'full'` before it sets `mediaBytes` to anything but
 * `false`.
 */
export type NetworkCapabilities =
  | (CommonCapabilities & {
      /** How far YouTube and YouTube Music can be reached: not at all, or in the `simple` tier. */
      youtube: 'none' | 'simple'
      /** Always `false`: googlevideo's bytes can be read only with `full` YouTube access. */
      mediaBytes: false
    })
  | (CommonCapabilities & {
      /** How far YouTube and YouTube Music can be reached: `full`, everything. */
      youtube: 'full'
      /**
       * Can read media bytes from googlevideo.com, which downloads of YouTube audio, end-of-file
       * range probes and an equalizer on YouTube audio need. Normally `true`.
       */
      mediaBytes: boolean
    })

/** Everything a provider call needs to know about where it runs. Passed to every call. */
export interface ProviderContext {
  /** The fetch to use for every request. */
  fetch: Fetch
  /** The app FXM runs in. */
  platform: Platform
  /** What the network stack can reach. */
  capabilities: NetworkCapabilities
  /**
   * The catalog mode. Providers filter the tracks they list with `applyModeFilter`, and audio
   * sources return only candidates that pass `isPlayable`.
   */
  mode: CatalogMode
  /** Preferred language as a BCP 47 tag, e.g. `en-IN`. */
  locale?: string
  /** Content region as an ISO 3166-1 alpha-2 code, e.g. `IN`. */
  region?: string
  /** Cancels the call. */
  signal?: AbortSignalLike
}

/** Paging options. */
export interface PageOptions {
  /** Maximum number of items to return (per type, for a search). */
  limit?: number
  /** Cursor from a previous {@link Page}'s `nextCursor`. */
  cursor?: string
}

/** Options for {@link MetadataProvider.search}. */
export interface SearchOptions extends PageOptions {
  /**
   * The result types to return, one page each. Request `video` only in `all` mode. To load more
   * of one type, search again with only that type and the `cursor` of its page.
   */
  types: readonly SearchType[]
}

/** "What exists": search and browse one source's catalog. */
export interface MetadataProvider {
  /** The source this provider reads. */
  readonly id: SourceId
  /**
   * When the app may call this provider:
   *
   * - `any` (also when absent): whenever it needs to, e.g. in a search across all sources
   * - `explicit`: only for what the user explicitly asked of this source, such as a search with
   *   this source picked or one of its pages they opened; never in a search across sources, for
   *   suggestions or in the background. For sources with a small budget that every user shares,
   *   such as Jamendo (35,000 requests a month for one `client_id`)
   */
  readonly requestPolicy?: 'any' | 'explicit'
  /**
   * Searches the catalog, one page per requested type. Songs go to `tracks` and videos to
   * `videos`, which stays empty in `music` mode (see `SearchType`).
   */
  search(query: string, options: SearchOptions, ctx: ProviderContext): Promise<SearchResults>
  /**
   * Completions for a partial query, best first, for the search box while the user types.
   * Empty when the source has none.
   */
  suggest?(query: string, ctx: ProviderContext): Promise<string[]>
  /** Loads one track. Rejects with `NotFound` when it does not exist. */
  getTrack(id: EntityId<'track'>, ctx: ProviderContext): Promise<Track>
  /** Loads an album with its tracks. */
  getAlbum(id: EntityId<'album'>, ctx: ProviderContext): Promise<Album>
  /** Loads an artist with whatever the source shows on the artist page. */
  getArtist(id: EntityId<'artist'>, ctx: ProviderContext): Promise<Artist>
  /** Loads a playlist with its first page of tracks. */
  getPlaylist(id: EntityId<'playlist'>, ctx: ProviderContext): Promise<Playlist>
  /**
   * Loads a further page of a playlist's tracks. Required when `getPlaylist` can return a
   * `nextCursor`.
   */
  getPlaylistTracks?(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
  /** Lists similar artists, for sources that have them apart from the artist page. */
  getRelatedArtists?(id: EntityId<'artist'>, ctx: ProviderContext): Promise<Artist[]>
}

/**
 * What a radio starts from: a track, or an artist (tell them apart with `isTrackSeed`).
 *
 * Seeds may come from any source: a Spotify track can seed YouTube Music radio. A provider uses
 * `seed.id` when it belongs to its own source (for YouTube, `ytm` and `yt` IDs both do), else a
 * track's `externalIds` entry for its source. Failing both, it may look the seed up, e.g. by
 * title and artist, or it rejects with an `Unsupported` `FxmError`.
 *
 * In Music mode, seed radio with a song: map an official music video to its song first (the
 * linked one from `songForVideo`, else the one the matching engine finds), because radio from a
 * video drifts into videos.
 */
export type RadioSeed = Track | ArtistRef

/** Recommendations: radio stations and, optionally, a personal home feed. */
export interface RecommendationProvider {
  /** Provider ID, e.g. `ytm` or `spotify`. */
  readonly id: string
  /**
   * When the app may ask this provider for a radio:
   *
   * - `any` (also when absent): whenever it needs to, e.g. as one of the sources of a mixed radio
   *   or of the home feed, in the background
   * - `explicit`: only when the user explicitly asked this provider for a radio, e.g. from one of
   *   its own tracks or with its source picked; never as one of several sources, for the home
   *   feed or in the background, so it never learns what the user plays elsewhere. For runtime
   *   plugins (stage 8.3)
   */
  readonly requestPolicy?: 'any' | 'explicit'
  /**
   * Tracks to play after `seed`, best first, respecting `ctx.mode`. See {@link RadioSeed} for
   * seeds from other sources.
   */
  radio(seed: RadioSeed, ctx: ProviderContext): Promise<Track[]>
  /**
   * The same radio one page at a time, for sources whose stations go on, such as YouTube Music's:
   * the first page without a cursor, then each page's `nextCursor`, with the same seed in the
   * same catalog mode. Without a `limit`, the first page holds what `radio` returns; with one, a
   * page holds at most `limit` tracks, and the pages after it go on with the rest.
   *
   * A page does not repeat the seed, nor a track that one of the recent pages returned: a cursor
   * remembers only so many (YouTube Music's the last 200), so a consumer that must never repeat
   * a track over a long session also de-duplicates with `entityKey`.
   */
  radioPage?(seed: RadioSeed, options: PageOptions, ctx: ProviderContext): Promise<Page<Track>>
  /** A home feed, e.g. Spotify's personal shelves when the user is logged in. */
  home?(ctx: ProviderContext): Promise<Shelf[]>
}

/**
 * What is known about an {@link AudioCandidate} beyond how alike its title, artists and duration
 * are to the track's: the facts the matching engine weighs before it lets a candidate play
 * without asking.
 */
export interface MatchSignals {
  /**
   * Whether the candidate is known to be the recording with the track's ISRC: its own ISRC is
   * the track's, or an ISRC search found it and it passed the matching engine's ISRC check.
   * `false` when either ISRC is unknown, they differ, or nothing was checked.
   */
  isrcVerified: boolean
  /**
   * The release (album, single or EP) the candidate comes from, as a native ID in its source's
   * canonical form, like `ref`, so `formatId(source, 'album', releaseId)` is the album's ID: for
   * YouTube Music, the album's browseId (`MPREb_…`).
   */
  releaseId?: string
  /**
   * The year that release came out, e.g. `2009` for a 2009 remaster of a 1967 recording, so
   * re-releases and re-recordings can be told apart.
   */
  releaseYear?: number
  /** The record label that issued the release, as the source spells it. */
  label?: string
  /**
   * Whether the candidate comes from the same album as the track being matched, e.g. the
   * Spotify track's album on YouTube Music. `false` when either album is unknown or they differ.
   * The matching engine relies on it, for example, before it auto-plays a classical work, whose
   * title alone fits many recordings.
   */
  sourceAlbumMatch: boolean
}

/**
 * One place a track's audio may be found, as returned by {@link AudioSource.match}. It still
 * has to be resolved into stream URLs.
 */
export interface AudioCandidate {
  /**
   * The audio source that resolves the candidate: the `id` of the {@link AudioSource} that
   * returned it. YouTube has one audio source, `ytm`, for every videoId, including videos found
   * on plain YouTube (see `entityKey` for why that is the same entity as a `yt` ID).
   */
  source: SourceId
  /**
   * The audio's native ID in its source's canonical form (see `ids.ts`), e.g. a YouTube videoId,
   * so `formatId(source, 'track', ref)` is the candidate's track ID.
   */
  ref: string
  /**
   * What the candidate is. It must be playable in the context's mode (see
   * {@link AudioSource.match}), so in Music mode it is always a `song`.
   */
  kind: TrackKind
  /** The candidate's title, as the source shows it. */
  title: string
  /** The candidate's artist names. */
  artists: string[]
  /** Duration in milliseconds. */
  durationMs?: number
  /** How sure the match is that this is the same recording, from 0 to 1. */
  confidence: number
  /**
   * Why it matched, for debugging and the source switcher, e.g. `isrc`, `title 0.97`,
   * `duration -1.2s`. Text for people: code reads `signals`.
   */
  evidence: string[]
  /**
   * The facts beyond text similarity: ISRC, release and album (see {@link MatchSignals}).
   * Providers that do not compute them leave them out, and the matching engine fills them in.
   */
  signals?: MatchSignals
  /**
   * The matching engine's verdict, on the candidate it ranked first: the band it reaches with
   * the user's Auto setting on, why it falls short of `auto`, and the matcher version. Apply the
   * setting at play time with `effectiveMatchBand`, which also refuses an `auto` from another
   * matcher version, so a stored candidate follows the setting and the engine as they change.
   * Absent on alternatives and on candidates no engine ranked: those never play without asking.
   */
  verdict?: MatchVerdict
}

/** How a stream is delivered. `sabr` is YouTube's server-driven streaming protocol. */
export type StreamProtocol = 'progressive' | 'hls' | 'dash' | 'sabr'

/** A JSON value: data that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject

/**
 * A JSON object. Declare a payload meant for it with a `type` alias: an `interface` has no
 * index signature, so TypeScript does not accept it here.
 */
export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * One concrete way to play a candidate. The codec, bitrate, sample rate, bit depth and tier
 * always describe the audio, even when the file is a video with an audio track (`media`
 * `muxed-video`).
 */
export interface StreamOption {
  /**
   * Where the player gets the audio: the media URL for `progressive`, the manifest URL for `hls`
   * and `dash`, and the server ABR streaming URL (`serverAbrStreamingUrl`) for `sabr`.
   */
  url: string
  /** Audio codec. */
  codec: Codec
  /** Container format of the file, e.g. `mp4` for a muxed video. */
  container: Container
  /**
   * Audio only, or a video file whose audio track FXM plays or extracts (see `StreamMedia`).
   * Required, so that no resolver forgets to say. A muxed video costs more data, so
   * `compareStreams` ranks it after the audio-only options of its tier.
   */
  media: StreamMedia
  /** Average bitrate of the audio in kbps. */
  bitrateKbps?: number
  /** Sample rate in Hz. */
  sampleRateHz?: number
  /** Bits per sample, for lossless streams. */
  bitDepth?: number
  /**
   * Quality tier of the audio, usually from `tierOf`. Only a lossless codec is `lossless`, so
   * YouTube audio (Opus or AAC) never is. A source whose formats are encoded to a stated
   * bitrate may tier variable-bitrate audio by that nominal (peak) bitrate rather than by the
   * average in `bitrateKbps`: YouTube's Opus 251 is `high` even when a quiet song averages
   * below 120 kbps (ARCHITECTURE.md §7.3). Read the tier from here rather than computing it
   * again from `bitrateKbps`.
   */
  tier: QualityTier
  /** How the stream is delivered. */
  protocol: StreamProtocol
  /** When the URL stops working, as epoch milliseconds. */
  expiresAt?: number
  /** Whether the URL only works from the IP address that resolved it (true for YouTube). */
  ipBound: boolean
  /**
   * Whether the URL is known to deliver the whole file (see `FullLengthCheck`): `verified` after
   * an end-of-file range probe, `unverified` when the bytes cannot be read or were not probed,
   * and `capped` when a probe showed that the URL stops early. A capped option must never be
   * played or downloaded, so `pickStream` never picks one. Required, so that no resolver forgets
   * to say.
   */
  fullLength: FullLengthCheck
  /**
   * Whether the source lets this stream be downloaded and kept: `false` when it forbids that,
   * e.g. a Jamendo track whose artist turned downloads off (`audiodownload_allowed`), which may
   * still be streamed. Absent means allowed. Downloads skip an option whose value is `false`, so
   * drop those before `pickStream(options, 'lossless')`; playback ignores the field.
   */
  downloadAllowed?: boolean
  /** Headers the request must send, e.g. a `Referer`. */
  requestHeaders?: Record<string, string>
  /**
   * Protocol-specific data the player needs besides the URL, as JSON so that it can cross a
   * worker or native bridge. For `sabr` it holds the session parameters, such as the ustreamer
   * config, a PO token, the client and the chosen formats; the resolver that produces it defines
   * the shape, and the player validates it. The other protocols usually leave it out.
   */
  playback?: JsonObject
}

/**
 * "Where the audio comes from", in two phases: {@link AudioSource.match} finds candidates for a
 * track from any source, and {@link AudioSource.resolve} turns the chosen one into streams.
 */
export interface AudioSource {
  /** The source this audio comes from, and the `source` of every candidate it returns. */
  readonly id: SourceId
  /**
   * When the app may call {@link AudioSource.match} with tracks of other sources:
   *
   * - `any` (also when absent): whenever it needs to, e.g. in the matching engine's searches for
   *   any track, imports and re-matching
   * - `explicit`: only for a track the user explicitly asked this source about, e.g. "Find the
   *   audio with …" on that track; never in the matching engine's searches across sources or in
   *   the background, so it never learns what the user plays elsewhere. {@link AudioSource.resolve}
   *   of its own candidates, and `match` of its own tracks, may run whenever they play. For
   *   runtime plugins (stage 8.3)
   */
  readonly requestPolicy?: 'any' | 'explicit'
  /**
   * Candidates for `track`, best first. Empty when the source has nothing. Every candidate is
   * playable in `ctx.mode` as it is (`isPlayable(candidate, ctx.mode)`, or `filterPlayable` on
   * the list): in Music mode a music-video track is matched to its song (the linked one when
   * `songForVideo` names it), and the video itself is never returned as a candidate.
   *
   * The track may carry what the matching engine reads beyond a `Track` (`MatchSourceExtras`:
   * the release's label and type, and where its ISRC came from), so the caller passes along what
   * an import or Spotify knows. A plain track fits too.
   */
  match(track: Track & MatchSourceExtras, ctx: ProviderContext): Promise<AudioCandidate[]>
  /**
   * Every stream option found for a candidate, best first as `compareStreams` orders them. It
   * never drops an option because of `prefs`: the same list serves playback, which applies the
   * tier ceiling of the current connection with `pickStream`, and downloads, which want the best
   * option (e.g. a real FLAC original, `pickStream(options, 'lossless')`). `prefs` is only a hint
   * for ordering options of equal quality, e.g. putting first the codec that
   * `prefs.download.format` needs no conversion for.
   *
   * Every option says whether its URL delivers the whole file (`fullLength`). Where the bytes
   * can be read (`ctx.capabilities.mediaBytes`), a resolver whose source may cap URLs, such as
   * YouTube's, probes the end of the file; where they cannot, its options are `unverified`. An
   * option found `capped` may stay in the list so that the caller can tell why nothing plays,
   * but it comes last, and `pickStream` never picks it.
   */
  resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
  ): Promise<StreamOption[]>
}

/**
 * One timed word, or syllable, of a line of lyrics: enhanced LRC's `<mm:ss.xx>word`. A word lasts
 * until its `endMs`, or else until the next word (or line) starts.
 */
export interface LyricWord {
  /** When the word starts, in milliseconds. */
  timeMs: number
  /**
   * The word as written, plus one space when a space separates it from the next word, so the
   * words of a line joined together spell its text. Scripts written without spaces, such as
   * Japanese, have none.
   */
  text: string
  /**
   * When the word ends, in milliseconds, when the source marks it: before a pause, or at the end
   * of the line.
   */
  endMs?: number
}

/** One line of lyrics. */
export interface LyricLine {
  /** When the line starts, in milliseconds. Present on every line of synced lyrics. */
  timeMs?: number
  /** The line's text. */
  text: string
  /**
   * Word-by-word timing for karaoke-style highlighting, when the source has it (enhanced LRC).
   * Joined together, the words' texts make up `text`.
   */
  words?: LyricWord[]
}

/** What lyrics say about the recording they were written for, e.g. in LRC ID tags. */
export interface LyricsMetadata {
  /** Song title (LRC `[ti:]`). */
  title?: string
  /** Artist (LRC `[ar:]`). */
  artist?: string
  /** Album (LRC `[al:]`). */
  album?: string
  /** The recording's length in milliseconds (LRC `[length:]`). */
  lengthMs?: number
}

/** The lyrics of one track. */
export interface Lyrics {
  /** Whether every line carries a start time. */
  synced: boolean
  /** The lines, in order. */
  lines: LyricLine[]
  /** Where the lyrics came from, e.g. `lrclib`. */
  source: string
  /**
   * The title, artist, album and length of the recording the lyrics were written for, when known,
   * so the app can tell whether they fit the track that plays.
   */
  metadata?: LyricsMetadata
}

/** Finds lyrics for a track. */
export interface LyricsProvider {
  /** Provider ID, e.g. `lrclib`. */
  readonly id: string
  /** The lyrics of `track`, or `null` when the provider has none. */
  getLyrics(track: Track, ctx: ProviderContext): Promise<Lyrics | null>
}

/** Whether the user is logged in to a service. */
export interface AccountStatus {
  /** Whether a login is active. */
  connected: boolean
  /** The account's display name, when connected. */
  displayName?: string
}

/** A service the user can log in to, e.g. Spotify for personal recommendations and playlists. */
export interface AccountProvider {
  /** Provider ID, e.g. `spotify`. */
  readonly id: string
  /** The current login status. */
  status(ctx: ProviderContext): Promise<AccountStatus>
}
