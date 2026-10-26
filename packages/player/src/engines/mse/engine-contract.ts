/**
 * The engine contract of stage 2.2 (`packages/player/src/engine.ts`), which the MediaSource
 * engine implements. It is re-exported here, so that the facade and this engine share one
 * `EngineError` class: the facade checks failures with `instanceof`.
 *
 * @module
 */

export {
  ENGINE_ERROR_TYPES,
  type Engine,
  EngineError,
  type EngineErrorType,
  type EngineEventMap,
  type EngineEventType,
  isEngineError,
  type PlaybackSource,
  type PlaySupport,
} from '../../engine'
