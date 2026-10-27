/**
 * Audio effects on the web and in the desktop app (stage 8.1): the Web Audio graph the direct
 * audio engine routes readable media through, and the rule for which media a page can read. The
 * pure parts (equalizer, loudness, crossfade curves, settings) are in `@fxm/core`.
 *
 * @module
 */

export {
  checkMediaRead,
  isLocalMediaUrl,
  isMediaReadable,
  MEDIA_READ_TIMEOUT_MS,
  type MediaReadabilityContext,
  type MediaReadCheck,
  type MediaReadOptions,
  type MediaReadVerdict,
} from './readable'
export {
  type EffectsContext,
  type EffectsFilter,
  type EffectsGain,
  EffectsGraph,
  type EffectsNode,
  type EffectsParam,
  type ElementChain,
  setParam,
} from './web-audio'
