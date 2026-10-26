/**
 * The engine contract: what plays one stream at a time. The player facade drives an engine and
 * owns everything above it (queue, retries, preloading). Engines: `DirectAudioEngine` on an
 * `HTMLAudioElement` (web and desktop), later a native bridge to Media3 on Android.
 *
 * @module
 */

import type { QueueItem, StreamOption } from '@fxm/core'

/** Every {@link EngineErrorType}. */
export const ENGINE_ERROR_TYPES = [
  'network',
  'decode',
  'autoplay-blocked',
  'unsupported',
  'expired',
] as const

/**
 * Why playback failed:
 *
 * - `network`: the stream could not be fetched, or stopped arriving
 * - `decode`: the bytes arrived but could not be decoded
 * - `autoplay-blocked`: the browser wants a user gesture before playback starts. Not a stream
 *   problem: the same stream plays once the user presses play
 * - `unsupported`: the engine cannot play this stream (format, protocol), or the server refused
 *   it, which browsers report the same way
 * - `expired`: the stream URL is past its `expiresAt`; resolve it again
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
   * @param options The underlying cause, e.g. a `MediaError` or a `DOMException`.
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

/**
 * How sure an engine is that it can play a stream, like `canPlayType` in a browser:
 *
 * - `probably`: the format is known to play, e.g. `canPlayType` says "probably"
 * - `maybe`: it may play; only trying tells (an unknown format, or `canPlayType` says "maybe")
 * - `no`: it cannot play: a format, protocol or delivery the engine does not support
 *
 * The playback policy prefers `probably` streams (Opus 251 only when the engine says
 * `probably`, otherwise AAC 140), tries `maybe` ones, and never picks `no`.
 */
export type PlaySupport = 'probably' | 'maybe' | 'no'

/** What {@link Engine.load} plays: one resolved stream, and the queue item it belongs to. */
export interface PlaybackSource {
  /** The stream to play. */
  stream: StreamOption
  /** The queue item, for engines that show their own media notification (Android). */
  item?: QueueItem
}

/**
 * The events an engine reports, with their payloads. They describe the source loaded last;
 * an engine never reports events of a source it has replaced.
 */
export interface EngineEventMap {
  /**
   * The playback position moved, in milliseconds. While a load waits to start at a later
   * position, the engine reports nothing rather than the 0 it has not left yet.
   */
  timeupdate: number
  /** The duration became known or changed, in milliseconds. Only finite, positive values. */
  durationchange: number
  /** Audio is playing: playback started, resumed or recovered from waiting for data. */
  play: undefined
  /** Playback paused, by {@link Engine.pause} or by the system. Not reported at the end. */
  pause: undefined
  /** The stream played to its end. */
  ended: undefined
  /** Playback failed. */
  error: EngineError
  /**
   * Data stopped arriving and too little is buffered to play on (in a browser: `stalled` while
   * `readyState` is below `HAVE_FUTURE_DATA`). Not reported while buffered audio still plays.
   */
  stalled: undefined
  /** Playback is waiting for data. */
  waiting: undefined
  /** Enough data has arrived to start playing. */
  canplay: undefined
}

/** One of the {@link EngineEventMap} event types. */
export type EngineEventType = keyof EngineEventMap

/**
 * Plays one stream at a time. Failures, including a refused `play()`, arrive as `error`
 * events, never as rejected promises, so callers handle them in one place.
 */
export interface Engine {
  /**
   * Replaces the current source with `source`, paused, starting at `startAtMs`. Resolves when
   * the engine has taken the source; whether it plays is reported through events.
   */
  load(source: PlaybackSource, startAtMs?: number): Promise<void>
  /** Starts or resumes playback. Resolves once the engine has acted on the request. */
  play(): Promise<void>
  /** Pauses playback. */
  pause(): void
  /** Moves the playback position, in milliseconds. */
  seek(positionMs: number): void
  /** Sets the volume, from 0 to 1. */
  setVolume(volume: number): void
  /** Mutes or unmutes, keeping the volume. */
  setMuted(muted: boolean): void
  /**
   * Prepares `source` to play next, so a later {@link load} of the same stream starts at once;
   * `null` drops what was prepared. Engines without preloading leave it out.
   */
  preload?(source: PlaybackSource | null): void
  /**
   * How sure the engine is that it can play `stream` (see {@link PlaySupport}). Engines that
   * cannot tell leave it out, which counts as `maybe`.
   */
  canPlay?(stream: StreamOption): PlaySupport
  /**
   * Called synchronously inside a user gesture (a tap or a media key), before anything is
   * awaited, so the engine can let playback start later without one. Some browsers allow
   * `play()` only on media elements that were once played in a gesture (WebKit, Android
   * WebView). Engines without such a rule leave it out.
   */
  unlock?(): void
  /** Adds a listener. Returns a function that removes it again. */
  on<K extends EngineEventType>(type: K, listener: (payload: EngineEventMap[K]) => void): () => void
  /** Stops playback and releases everything. The engine is unusable afterwards. */
  destroy(): void
}
