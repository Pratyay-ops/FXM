/**
 * The contract between an FXM app and a YouTube module: what a module exports, and what crosses
 * between the two. The app's own copy and a downloaded one implement the same
 * {@link YouTubeModule}, so the app can't tell them apart.
 *
 * Only the types here cross: the provider interfaces of `@fxm/core` and the YouTube extras the
 * app calls, never youtubei.js's objects (a provider's `session`), which change with every
 * youtubei.js release. `contract-1.ts` freezes this shape for contract 1, and a type test keeps
 * the two compatible in both directions. The README lists what else must stay readable across
 * module versions: cursors, rung IDs, the stores' formats, the stream options and the errors.
 *
 * @module
 */

import type {
  AudioCandidate,
  AudioSource,
  EntityId,
  MetadataProvider,
  Page,
  PageOptions,
  ProviderContext,
  QualityPrefs,
  RadioSeed,
  RecommendationProvider,
  StreamOption,
  Track,
} from '@fxm/core'
import type { StreamBudget } from '../stream/budget'
import type { YouTubeStreamOption } from '../stream/formats'
import type { LadderHealth, RungHealthStore } from '../stream/health'
import type { YouTubeResolveOptions } from '../stream/resolver'
import type { VisitorDataStore } from '../visitor'
import { YOUTUBE_MODULE_API } from './version'

/** What the app passes to {@link YouTubeModule.create}. */
export interface YouTubeModuleOptions {
  /**
   * The YouTube config document to use (a parsed `youtube-config.json`), which the module checks
   * itself.
   */
  readonly config: unknown
  /** Where the device's visitorData is kept, so a new module instance keeps the session. */
  readonly visitorDataStore?: VisitorDataStore
  /** Where the stream ladder's health is kept. */
  readonly healthStore?: RungHealthStore
  /**
   * The request budget for the stream calls. Leave it out when `ctx.fetch` comes from
   * `@fxm/platform`, whose transports draw on the budget themselves.
   */
  readonly budget?: StreamBudget
  /** How long one request may take, in milliseconds. */
  readonly timeoutMs?: number
}

/** YouTube Music (`ytm`) as a module provides it: metadata, recommendations and suggestions. */
export interface YouTubeModuleMusic extends MetadataProvider, RecommendationProvider {
  /** Always `ytm`. */
  readonly id: 'ytm'
  /** Completions for a partial query. */
  suggest(query: string, ctx: ProviderContext): Promise<string[]>
  /** A further page of a playlist's tracks. */
  getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
  /** A radio, one page at a time. */
  radioPage(seed: RadioSeed, options: PageOptions, ctx: ProviderContext): Promise<Page<Track>>
}

/** Plain YouTube (`yt`) as a module provides it. */
export interface YouTubeModuleVideo extends MetadataProvider {
  /** Always `yt`. */
  readonly id: 'yt'
  /** Completions for a partial query. */
  suggest(query: string, ctx: ProviderContext): Promise<string[]>
  /** A further page of a playlist's tracks. */
  getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
}

/** YouTube's audio source (the stream ladder) as a module provides it. */
export interface YouTubeModuleAudio extends AudioSource {
  /** Always `ytm`. */
  readonly id: 'ytm'
  /** The candidate for a YouTube track (see `YouTubeAudioSource.match`). */
  match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]>
  /** The stream options of a `ytm` candidate, best first (see `YouTubeAudioSource.resolve`). */
  resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
    options?: YouTubeResolveOptions,
  ): Promise<YouTubeStreamOption[]>
  /** Tells the ladder that a URL it resolved failed to play. */
  reportPlaybackFailure(option: StreamOption, ctx: ProviderContext): void
  /** The rungs' health on the platform and tier of `ctx`. */
  health(ctx: ProviderContext): Promise<LadderHealth>
}

/** The providers of one module instance, on one shared session. */
export interface YouTubeModuleProviders {
  /** YouTube Music. */
  readonly music: YouTubeModuleMusic
  /** Plain YouTube. */
  readonly video: YouTubeModuleVideo
  /** The audio source: the stream ladder. */
  readonly audio: YouTubeModuleAudio
}

/**
 * A YouTube module: the YouTube glue (the client ladder, the request shapes and the parsers) as
 * one versioned unit. Every module, bundled or downloaded, exports one as `youtubeModule`.
 */
export interface YouTubeModule {
  /** The contract version ({@link YOUTUBE_MODULE_API}). */
  readonly api: typeof YOUTUBE_MODULE_API
  /** The module's version: higher is newer. */
  readonly version: number
  /** The config document the module was built with. */
  readonly config: unknown
  /**
   * Checks a config document and returns its revision.
   *
   * @throws FxmError `Parse` naming the first problem, when this module can't use it.
   */
  checkConfig(document: unknown): number
  /**
   * Creates the providers, sharing one session. Makes no request.
   *
   * @throws FxmError `Parse` for a config this module can't use.
   */
  create(options: YouTubeModuleOptions): YouTubeModuleProviders
}

/**
 * Whether `value` looks like a {@link YouTubeModule} of this app's contract: the right `api`, a
 * positive whole `version`, a config and the two functions. What it does is checked by using it.
 */
export function isYouTubeModule(value: unknown): value is YouTubeModule {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof YouTubeModule, unknown>>
  return (
    candidate.api === YOUTUBE_MODULE_API &&
    Number.isSafeInteger(candidate.version) &&
    (candidate.version as number) >= 1 &&
    candidate.config !== undefined &&
    typeof candidate.checkConfig === 'function' &&
    typeof candidate.create === 'function'
  )
}
