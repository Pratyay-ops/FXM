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
  parseStreamConfig,
  pickStreamConfig,
  STREAM_CLIENT_FIELDS,
  STREAM_RUNG_KINDS,
  type StreamClientConfig,
  type StreamClientField,
  type StreamConfig,
  type StreamConfigChoice,
  type StreamRungConfig,
  type StreamRungKind,
} from './config'
export { isYouTubeStreamOption, type YouTubeStreamOption } from './formats'
export type {
  LadderHealth,
  RungFailure,
  RungHealth,
  RungHealthStore,
} from './health'
export {
  classifyPlayability,
  type Playability,
  UNAVAILABLE_STATES,
  type UnavailableState,
  type UnplayableDetails,
  unavailableStateOf,
  YouTubeUnplayableError,
} from './playability'
export { PROBE_BYTES, type ProbeResult, probeEndOfFile } from './probe'
export {
  createYouTubeAudioSource,
  type YouTubeAudioSource,
  type YouTubeAudioSourceOptions,
  type YouTubeResolveOptions,
} from './resolver'
