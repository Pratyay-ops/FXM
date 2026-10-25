/**
 * The contract between an FXM app and a YouTube module: what a module exports, and what the app
 * passes in. The app's own copy and a downloaded one implement the same {@link YouTubeModule},
 * so the app can't tell them apart.
 *
 * @module
 */

import type { YouTubeProviders } from '../index'
import type { StreamBudget } from '../stream/budget'
import type { RungHealthStore } from '../stream/health'
import type { YouTubeAudioSource } from '../stream/resolver'
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

/** The providers of one module instance, on one shared session. */
export interface YouTubeModuleProviders extends YouTubeProviders {
  /** The audio source: the stream ladder. */
  readonly audio: YouTubeAudioSource
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
