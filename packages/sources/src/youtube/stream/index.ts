/**
 * YouTube's stream resolver, the direct rungs: VISIONOS's Opus and AAC, then the ANDROID
 * client's itag 18, with an end-of-file probe where the bytes can be read. See `README.md`.
 *
 * ```ts
 * import { createYouTubeProviders } from '@fxm/sources/youtube'
 * import { createYouTubeAudioSource } from '@fxm/sources/youtube/stream'
 *
 * const { session } = createYouTubeProviders()
 * const audio = createYouTubeAudioSource({ session })
 * const options = await audio.resolve(candidate, ctx, prefs)
 * ```
 *
 * @module
 */

export * from './advanced'
export {
  type BotCheckCause,
  type StreamBudget,
  type StreamRequestPriority,
  UNMETERED_STREAM_BUDGET,
} from './budget'
export {
  BUNDLED_STREAM_CONFIG,
  BUNDLED_YOUTUBE_CONFIGS,
  invalidStreamConfig,
  parseStreamConfig,
  pickYouTubeConfigs,
  STREAM_CLIENT_FIELDS,
  type StreamClientConfig,
  type StreamClientField,
  type StreamConfig,
  type StreamConfigOptions,
  type StreamRungConfig,
  type StreamRungKindParser,
  type StreamRungRequirements,
  type YouTubeConfigs,
  type YouTubeConfigsChoice,
} from './config'
export { isYouTubeStreamOption, type YouTubeStreamOption } from './formats'
export type {
  LadderHealth,
  RungFailure,
  RungHealth,
  RungHealthStore,
} from './health'
export { DIRECT_RUNGS, type RungTools, type StreamRungKind } from './kinds'
export {
  classifyPlayability,
  type Playability,
  UNAVAILABLE_STATES,
  type UnavailableState,
  type UnplayableDetails,
  unavailableStateOf,
  type YouTubePlayabilityVerdict,
  YouTubeUnplayableError,
} from './playability'
export type { PlayerAnswer, PlayerCallOptions } from './player'
export { PROBE_BYTES, type ProbeResult, probeEndOfFile } from './probe'
export {
  createYouTubeAudioSource,
  type PlaybackFailureReason,
  type ProbeMode,
  type YouTubeAudioSessionOptions,
  type YouTubeAudioSource,
  type YouTubeAudioSourceOptions,
  type YouTubeResolveOptions,
  type YouTubeStreamSourceOptions,
} from './resolver'
