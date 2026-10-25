/**
 * The engine contract of stage 2.2 (`packages/player/src/engine.ts`), which the MediaSource
 * engine implements. 2.2 is merged on `develop`, but this branch was cut from a base that
 * predates it, so this file repeats the contract's shapes exactly, for structural typing.
 *
 * This is the one touch-point with 2.2. When the branches meet, replace everything below with a
 * re-export, so that the facade and this engine share one `EngineError` class (the facade checks
 * failures with `instanceof`):
 *
 * ```ts
 * export {
 *   ENGINE_ERROR_TYPES, type Engine, EngineError, type EngineErrorType, type EngineEventMap,
 *   type EngineEventType, isEngineError, type PlaybackSource, type PlaySupport,
 * } from '../../engine'
 * ```
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'

/** Every {@link EngineErrorType}. */
export const ENGINE_ERROR_TYPES = [
  'network',
  'decode',
  'autoplay-blocked',
  'unsupported',
  'expired',
] as const

/**
 * Why playback failed: `network` (the stream stopped arriving), `decode`, `autoplay-blocked`
 * (the browser wants a user gesture), `unsupported` (the engine cannot play it, or the server
 * refused it) or `expired` (resolve it again).
 */
export type EngineErrorType = (typeof ENGINE_ERROR_TYPES)[number]

/** A playback failure with a machine-readable {@link EngineErrorType}. */
export class EngineError extends Error {
  /** Always `EngineError`. */
  override readonly name = 'EngineError'
  /** Why playback failed. */
  readonly type: EngineErrorType

  /**
   * @param type Why playback failed.
   * @param message Human-readable details, for logs.
   * @param options The underlying cause.
   */
  constructor(type: EngineErrorType, message: string, options: { cause?: unknown } = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.type = type
  }
}

/** Whether `value` is an {@link EngineError}, optionally of one `type`. */
export function isEngineError(value: unknown, type?: EngineErrorType): value is EngineError {
  return value instanceof EngineError && (type === undefined || value.type === type)
}

/** How sure an engine is that it can play a stream. */
export type PlaySupport = 'probably' | 'maybe' | 'no'

/** What {@link Engine.load} plays: one resolved stream, and the queue item it belongs to. */
export interface PlaybackSource {
  /** The stream to play. */
  stream: StreamOption
  /** The queue item (stage 2.2's `QueueItem`), for engines that show their own notification. */
  item?: unknown
}

/** The events an engine reports, with their payloads. */
export interface EngineEventMap {
  /** The playback position moved, in milliseconds. */
  timeupdate: number
  /** The duration became known or changed, in milliseconds (finite, positive). */
  durationchange: number
  /** Audio is playing. */
  play: undefined
  /** Playback paused (not at the end). */
  pause: undefined
  /** The stream played to its end. */
  ended: undefined
  /** Playback failed. */
  error: EngineError
  /** Data stopped arriving and too little is buffered to play on. */
  stalled: undefined
  /** Playback is waiting for data. */
  waiting: undefined
  /** Enough data has arrived to start playing. */
  canplay: undefined
}

/** One of the {@link EngineEventMap} event types. */
export type EngineEventType = keyof EngineEventMap

/** Plays one stream at a time; failures arrive as `error` events. */
export interface Engine {
  /** Replaces the current source with `source`, paused, starting at `startAtMs`. */
  load(source: PlaybackSource, startAtMs?: number): Promise<void>
  /** Starts or resumes playback. */
  play(): Promise<void>
  /** Pauses playback. */
  pause(): void
  /** Moves the playback position, in milliseconds. */
  seek(positionMs: number): void
  /** Sets the volume, from 0 to 1. */
  setVolume(volume: number): void
  /** Mutes or unmutes, keeping the volume. */
  setMuted(muted: boolean): void
  /** Prepares `source` to play next; engines without preloading leave it out. */
  preload?(source: PlaybackSource | null): void
  /** How sure the engine is that it can play `stream`. */
  canPlay?(stream: StreamOption): PlaySupport
  /** Called inside a user gesture, so later playback needs none. */
  unlock?(): void
  /** Adds a listener. Returns a function that removes it again. */
  on<K extends EngineEventType>(type: K, listener: (payload: EngineEventMap[K]) => void): () => void
  /** Stops playback and releases everything. */
  destroy(): void
}
