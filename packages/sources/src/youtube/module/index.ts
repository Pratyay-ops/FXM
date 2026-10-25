/**
 * The YouTube resolver module (stage 1.13): the YouTube glue as one versioned ES module that the
 * desktop and Android apps can replace with a newer signed copy from FXM's site, without an app
 * update. See `README.md` in this folder.
 *
 * ```ts
 * import { createYouTubeModuleHost } from '@fxm/sources/youtube/module'
 *
 * const youtube = createYouTubeModuleHost({ visitorDataStore, healthStore })
 * const { tracks } = await youtube.music.search('Creep', { types: ['track'] }, ctx)
 * const options = await youtube.audio.resolve(candidate, ctx, prefs)
 * ```
 *
 * @module
 */

export {
  isYouTubeModule,
  type YouTubeModule,
  type YouTubeModuleOptions,
  type YouTubeModuleProviders,
} from './api'
export { youtubeModule } from './entry'
export {
  createYouTubeModuleHost,
  type SignedVersion,
  type UpdateActivation,
  type YouTubeConfigDocument,
  type YouTubeConfigOrigin,
  type YouTubeConfigUpdate,
  type YouTubeModuleHost,
  type YouTubeModuleHostOptions,
  type YouTubeModuleOrigin,
  type YouTubeModuleState,
  type YouTubeModuleUpdate,
} from './host'
export {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_MODULE_API,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
  YOUTUBE_MODULE_VERSION,
} from './version'
