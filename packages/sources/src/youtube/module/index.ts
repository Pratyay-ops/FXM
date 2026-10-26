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
 * The module's build and test helpers have entry points of their own:
 * `@fxm/sources/youtube/module/build` and `@fxm/sources/youtube/module/testing`.
 *
 * @module
 */

export {
  isYouTubeModule,
  type YouTubeModule,
  type YouTubeModuleAudio,
  type YouTubeModuleMusic,
  type YouTubeModuleOptions,
  type YouTubeModuleProviders,
  type YouTubeModuleVideo,
} from './api'
export { youtubeModule } from './entry'
export {
  type ActivationInfo,
  createYouTubeModuleHost,
  type FailureListener,
  type SignedVersion,
  type UpdateOrigin,
  type VersionInUse,
  type YouTubeConfigArtifactSpec,
  type YouTubeConfigDocument,
  type YouTubeConfigOrigin,
  type YouTubeModuleArtifactSpec,
  type YouTubeModuleHost,
  type YouTubeModuleHostOptions,
  type YouTubeModuleState,
} from './host'
export {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
  YOUTUBE_MODULE_API,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
  YOUTUBE_MODULE_VERSION,
} from './version'
