/**
 * YouTube Music and YouTube metadata providers for FXM, built on youtubei.js and the injected
 * `ctx.fetch`. Every InnerTube request takes the CORS-simple shape and carries a server-issued
 * visitorData. See the package README.
 *
 * ```ts
 * import { createYouTubeProviders } from '@fxm/sources/youtube'
 *
 * const { music, video } = createYouTubeProviders()
 * const results = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
 * ```
 *
 * @module
 */

import {
  createYouTubeMusicProvider,
  type YouTubeMusicProvider,
  type YouTubeProviderOptions,
} from './music'
import { createYouTubeSession, type YouTubeSession } from './session'
import { createYouTubeProvider, type YouTubeVideoProvider } from './video'

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
} from './config'
export type { YouTubeSource } from './ids'
export {
  createYouTubeMusicProvider,
  type YouTubeMusicProvider,
  type YouTubeProviderOptions,
} from './music'
export { kindOfMusicVideoType, MUSIC_VIDEO_TYPES } from './parse/classify'
export {
  createInnerTubeFetch,
  INNERTUBE_ENDPOINTS,
  type InnerTubeEndpoint,
  SIMPLE_CONTENT_TYPE,
  type SimpleInnerTubeRequest,
  toSimpleInnerTubeRequest,
} from './request'
export {
  assertYouTubeReachable,
  createYouTubeSession,
  innerTubeLanguage,
  innerTubeRegion,
  type YouTubeClientId,
  type YouTubeSession,
  type YouTubeSessionOptions,
} from './session'
export { createYouTubeProvider, type YouTubeVideoProvider } from './video'
export { isVisitorData, parseSwJsData, VisitorData, type VisitorDataStore } from './visitor'

/** Both YouTube providers, sharing one session. */
export interface YouTubeProviders {
  /** The shared session: one visitorData for the device. */
  readonly session: YouTubeSession
  /** YouTube Music (`ytm`). */
  readonly music: YouTubeMusicProvider
  /** Plain YouTube (`yt`). */
  readonly video: YouTubeVideoProvider
}

/** Creates the `ytm` and `yt` providers on one shared session. */
export function createYouTubeProviders(options: YouTubeProviderOptions = {}): YouTubeProviders {
  const session = options.session ?? createYouTubeSession(options)
  return {
    session,
    music: createYouTubeMusicProvider({ session }),
    video: createYouTubeProvider({ session }),
  }
}
