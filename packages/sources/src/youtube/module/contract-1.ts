/**
 * Contract 1 between FXM apps and YouTube modules, frozen: everything that crosses between an
 * app and a module of `YOUTUBE_MODULE_API` 1, written out in full instead of imported, so that a
 * change to the YouTube code can't change it unnoticed. `contract.test.ts` checks that the
 * current `api.ts` stays compatible with it in both directions: apps built against contract 1
 * can use a newer module, and a newer app can use a module built against contract 1. Only the
 * entities and provider interfaces of `@fxm/core` are imported: core changes are additive.
 *
 * **Never edit this file once a module of contract 1 is published.** A change that breaks it
 * needs `YOUTUBE_MODULE_API` 2, a new file name and a `contract-2.ts`. Until the first module is
 * signed (none is yet), it follows `api.ts`.
 *
 * @module
 */

import type {
  Album,
  Artist,
  AudioCandidate,
  AudioSource,
  EntityId,
  MetadataProvider,
  Page,
  PageOptions,
  Playlist,
  ProviderContext,
  QualityPrefs,
  RadioSeed,
  RecommendationProvider,
  StreamOption,
  Track,
} from '@fxm/core'

/** What an InnerTube call is for, highest priority first. */
export type StreamRequestPriority = 'current-track' | 'prefetch' | 'interactive' | 'bulk'

/** Why YouTube seems to have flagged the IP address. */
export type BotCheckCause = 'login-required' | 'rate-limited'

/** The request budget, as the module calls it. */
export interface StreamBudget {
  acquire(priority: StreamRequestPriority, options?: { signal?: AbortSignal }): Promise<void>
  reportBotCheck(cause: BotCheckCause): void
}

/** Where the app keeps the device's visitorData for the module. */
export interface VisitorDataStore {
  load(): string | undefined | Promise<string | undefined>
  save(visitorData: string): void | Promise<void>
  clear(): void | Promise<void>
}

/** Where the app keeps the ladder's health for the module. */
export interface RungHealthStore {
  load(): unknown | Promise<unknown>
  save(state: unknown): void | Promise<void>
}

/** Why a rung failed. */
export type RungFailure = 'bot-check' | 'capped' | 'no-formats' | 'mismatch' | 'error' | 'playback'

/** One rung's health on one platform. */
export interface RungHealth {
  readonly rung: string
  readonly successes: number
  readonly failures: number
  readonly consecutiveFailures: number
  readonly lastSuccessAt?: number
  readonly lastFailureAt?: number
  readonly lastFailure?: RungFailure
  readonly coolingUntil?: number
}

/** The ladder's health on one platform. */
export interface LadderHealth {
  readonly scope: string
  readonly lastWorking?: string
  readonly lastWorkingAt?: number
  readonly rungs: readonly RungHealth[]
}

/** A stream option from the YouTube ladder. */
export interface YouTubeStreamOption extends StreamOption {
  readonly videoId: string
  readonly rung: string
  readonly itag: number
  readonly label: string
  readonly contentLength?: number
  readonly peakBitrateKbps?: number
}

/** Which URLs `resolve` probes at the end of their file. */
export type ProbeMode = 'best' | 'all' | 'none'

/** Options for one `resolve` call. */
export interface YouTubeResolveOptions {
  priority?: StreamRequestPriority
  rungs?: 'all' | 'fallback'
  probe?: ProbeMode
}

/** Why a URL from the ladder failed to play. */
export type PlaybackFailureReason =
  | 'probe-failed'
  | 'fallback-failed'
  | 'forbidden-again'
  | 'forbidden'
  | 'ip-changed'
  | 'expired'
  | 'unauthorized'
  | 'first-request'
  | 'mid-play'
  | 'decode'

/** The top result of an unfiltered YouTube Music search. */
export type TopResult =
  | { readonly type: 'track'; readonly track: Track }
  | { readonly type: 'album'; readonly album: Album }
  | { readonly type: 'artist'; readonly artist: Artist }
  | { readonly type: 'playlist'; readonly playlist: Playlist }

/** What the app passes to `create`. */
export interface YouTubeModuleOptions {
  readonly config: unknown
  readonly visitorDataStore?: VisitorDataStore
  readonly healthStore?: RungHealthStore
  readonly budget?: StreamBudget
  readonly timeoutMs?: number
}

/** YouTube Music. */
export interface YouTubeModuleMusic extends MetadataProvider, RecommendationProvider {
  readonly id: 'ytm'
  suggest(query: string, ctx: ProviderContext): Promise<string[]>
  getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
  radioPage(seed: RadioSeed, options: PageOptions, ctx: ProviderContext): Promise<Page<Track>>
  topResult(query: string, ctx: ProviderContext): Promise<TopResult | undefined>
  getDescription(id: EntityId<'track'>, ctx: ProviderContext): Promise<string | undefined>
}

/** Plain YouTube. */
export interface YouTubeModuleVideo extends MetadataProvider {
  readonly id: 'yt'
  suggest(query: string, ctx: ProviderContext): Promise<string[]>
  getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
  getDescription(id: EntityId<'track'>, ctx: ProviderContext): Promise<string | undefined>
}

/** The audio source. */
export interface YouTubeModuleAudio extends AudioSource {
  readonly id: 'ytm'
  readonly hasFallback: boolean
  match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]>
  resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
    options?: YouTubeResolveOptions,
  ): Promise<YouTubeStreamOption[]>
  reportPlaybackSuccess(option: StreamOption, ctx: ProviderContext): void
  reportPlaybackFailure(
    option: StreamOption,
    ctx: ProviderContext,
    reason: PlaybackFailureReason,
  ): void
  checkStatus(option: StreamOption, ctx: ProviderContext): Promise<number | undefined>
  health(ctx: ProviderContext): Promise<LadderHealth>
}

/** The providers of one module instance. */
export interface YouTubeModuleProviders {
  readonly music: YouTubeModuleMusic
  readonly video: YouTubeModuleVideo
  readonly audio: YouTubeModuleAudio
}

/** What a module exports as `youtubeModule`. */
export interface YouTubeModule {
  readonly api: 1
  readonly version: number
  readonly config: unknown
  checkConfig(document: unknown): number
  create(options: YouTubeModuleOptions): YouTubeModuleProviders
}
