/**
 * YouTube Music and YouTube metadata providers for FXM, built on youtubei.js and the injected
 * `ctx.fetch`. Every InnerTube request takes the CORS-simple shape, and the only visitorData it
 * ever carries is one YouTube issued: in the `simple` tier the session's first request goes
 * without one, so that YouTube issues it. See the package README.
 *
 * ```ts
 * import { createYouTubeProviders } from '@fxm/sources/youtube'
 *
 * const { music, video } = createYouTubeProviders()
 * const results = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
 * ```
 *
 * This entry point is the consumer API. The request plumbing (`request.ts`, `visitor.ts`) stays
 * inside the folder, where other YouTube code imports it directly.
 *
 * @module
 */

import { createYouTubeMusicProvider, type YouTubeMusicProvider } from './music'
import { createYouTubeSession, type YouTubeProviderOptions, type YouTubeSession } from './session'
import { createYouTubeVideoProvider, type YouTubeVideoProvider } from './video'

export {
  BUNDLED_YOUTUBE_CONFIG,
  type ConfigChoice,
  INNERTUBE_HOSTS,
  type InnerTubeHost,
  type MusicSearchFilter,
  parseYouTubeConfig,
  pickYouTubeConfig,
  type WebSearchFilter,
  YOUTUBE_CONFIG_SCHEMA,
  type YouTubeClientConfig,
  type YouTubeConfig,
  type YouTubeKillSwitches,
  type YouTubeLabels,
} from './config'
export type { YouTubeSource } from './ids'
export { createYouTubeMusicProvider, type YouTubeMusicProvider } from './music'
export { kindOfMusicVideoType, MUSIC_VIDEO_TYPES } from './parse/classify'
export type { InnerTubeEndpoint } from './request'
export {
  createYouTubeSession,
  type YouTubeClientId,
  type YouTubeProviderOptions,
  type YouTubeSession,
  type YouTubeSessionOptions,
} from './session'
export { createYouTubeVideoProvider, type YouTubeVideoProvider } from './video'
export type { VisitorDataStore, YouTubeVisitorData } from './visitor'

/** Both YouTube providers, sharing one session. */
export interface YouTubeProviders {
  /** The shared session: one visitorData for the device. */
  readonly session: YouTubeSession
  /** YouTube Music (`ytm`). */
  readonly music: YouTubeMusicProvider
  /** Plain YouTube (`yt`). */
  readonly video: YouTubeVideoProvider
}

/**
 * Creates the `ytm` and `yt` providers on one shared session: the device's `session`, or a new
 * one made from the other options.
 */
export function createYouTubeProviders(options: YouTubeProviderOptions = {}): YouTubeProviders {
  const session = options.session ?? createYouTubeSession(options)
  return {
    session,
    music: createYouTubeMusicProvider({ session }),
    video: createYouTubeVideoProvider({ session }),
  }
}
