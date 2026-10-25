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
import type { Codec, Container, QualityPrefs, QualityTier } from './quality'

/**
 * The parts of `RequestInit` that providers use. Only relevant where the program has no global
 * `fetch` (see {@link Fetch}).
 */
export interface MinimalRequestInit {
  /** HTTP method, `GET` when absent. */
  method?: string
  /** Request headers. */
  headers?: Record<string, string>
  /** Request body. */
  body?: string | Uint8Array
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
 * The `fetch` a provider must use for every request; providers never touch the global one.
 * The platform injects it: `window.fetch` in a browser page (YouTube and Spotify answer only
 * when the FXM Connect extension is installed), the Tauri HTTP plugin's `fetch` on desktop, a
 * native-HTTP wrapper on Android, or Node's `fetch` in tests and scripts.
 *
 * In any program that has a global `fetch` (DOM, web worker or Node types) this is exactly
 * `typeof fetch`, so every implementation above can be passed as is. `@fxm/core` itself loads
 * only the ES library, so in its own type check it falls back to {@link MinimalFetch}.
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

/** What the platform's network stack can do, which decides the providers and pipes on offer. */
export interface NetworkCapabilities {
  /** Can call YouTube and YouTube Music (desktop, Android, or web with FXM Connect). */
  youtube: boolean
  /** Can call Spotify (desktop, Android, or web with FXM Connect). */
  spotify: boolean
  /** Can read media bytes from googlevideo.com, which downloads of YouTube audio need. */
  mediaBytes: boolean
  /** Can write files outside browser storage. */
  fileSystem: boolean
}

/** Everything a provider call needs to know about where it runs. Passed to every call. */
export interface ProviderContext {
  /** The fetch to use for every request. */
  fetch: Fetch
  /** The app FXM runs in. */
  platform: Platform
  /** What the network stack can reach. */
  capabilities: NetworkCapabilities
  /** The catalog mode; providers filter their track results with `applyModeFilter`. */
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
   * The result types to return, one page each. To load more of one type, search again with
   * only that type and the `cursor` of its page.
   */
  types: readonly SearchType[]
}

/** "What exists": search and browse one source's catalog. */
export interface MetadataProvider {
  /** The source this provider reads. */
  readonly id: SourceId
  /** Searches the catalog. Track results respect `ctx.mode`. */
  search(query: string, options: SearchOptions, ctx: ProviderContext): Promise<SearchResults>
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

/** What a radio starts from: a track, or an artist. */
export type RadioSeed = Track | ArtistRef

/** Recommendations: radio stations and, optionally, a personal home feed. */
export interface RecommendationProvider {
  /** Provider ID, e.g. `ytm` or `spotify`. */
  readonly id: string
  /** Tracks to play after `seed`, best first, respecting `ctx.mode`. */
  radio(seed: RadioSeed, ctx: ProviderContext): Promise<Track[]>
  /** A home feed, e.g. Spotify's personal shelves when the user is logged in. */
  home?(ctx: ProviderContext): Promise<Shelf[]>
}

/**
 * One place a track's audio may be found, as returned by {@link AudioSource.match}. It still
 * has to be resolved into stream URLs.
 */
export interface AudioCandidate {
  /** The source holding the audio. */
  source: SourceId
  /** The source's native reference, e.g. a YouTube video ID. */
  ref: string
  /** What the candidate is; the catalog-mode policy applies to it like to a track. */
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
   * `duration -1.2s`.
   */
  evidence: string[]
}

/** How a stream is delivered. `sabr` is YouTube's server-driven streaming protocol. */
export type StreamProtocol = 'progressive' | 'hls' | 'dash' | 'sabr'

/** One concrete way to play a candidate. */
export interface StreamOption {
  /** Stream URL, or the manifest URL for `hls` and `dash`. */
  url: string
  /** Audio codec. */
  codec: Codec
  /** Container format. */
  container: Container
  /** Average bitrate in kbps. */
  bitrateKbps?: number
  /** Sample rate in Hz. */
  sampleRateHz?: number
  /** Bits per sample, for lossless streams. */
  bitDepth?: number
  /** Quality tier, usually from `tierOf`. */
  tier: QualityTier
  /** How the stream is delivered. */
  protocol: StreamProtocol
  /** When the URL stops working, as epoch milliseconds. */
  expiresAt?: number
  /** Whether the URL only works from the IP address that resolved it (true for YouTube). */
  ipBound: boolean
  /** Headers the request must send, e.g. a `Referer`. */
  requestHeaders?: Record<string, string>
}

/**
 * "Where the audio comes from", in two phases: {@link AudioSource.match} finds candidates for a
 * track from any source, and {@link AudioSource.resolve} turns the chosen one into streams.
 */
export interface AudioSource {
  /** The source this audio comes from. */
  readonly id: SourceId
  /** Candidates for `track`, best first. Empty when the source has nothing. */
  match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]>
  /** Stream options for a candidate, best first for `prefs`. */
  resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
  ): Promise<StreamOption[]>
}

/** One line of lyrics. */
export interface LyricLine {
  /** When the line starts, in milliseconds. Present on every line of synced lyrics. */
  timeMs?: number
  /** The line's text. */
  text: string
}

/** The lyrics of one track. */
export interface Lyrics {
  /** Whether every line carries a start time. */
  synced: boolean
  /** The lines, in order. */
  lines: LyricLine[]
  /** Where the lyrics came from, e.g. `lrclib`. */
  source: string
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
