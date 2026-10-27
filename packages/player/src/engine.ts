/**
 * The engine contract: what plays one stream at a time. The player facade drives an engine and
 * owns everything above it (queue, retries, preloading). Engines: `DirectAudioEngine` on an
 * `HTMLAudioElement` (web and desktop), later a native bridge to Media3 on Android.
 *
 * @module
 */

import type { EqualizerSettings, LoudnessSettings, QueueItem, StreamOption } from '@fxm/core'

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
 * What the audio effects do to the source an engine plays (stage 8.1), as it reports them with
 * its `effects` event.
 */
export interface AudioEffectsStatus {
  /**
   * The equalizer:
   *
   * - `off`: switched off
   * - `on`: it processes the source
   * - `unavailable`: switched on, but it can't process this source. On the web and the desktop
   *   app the equalizer needs to read the audio's bytes, which a page can't for YouTube audio in
   *   the Lite tier or without FXM Connect, nor the desktop app for YouTube audio yet; or the
   *   browser has no Web Audio, or doesn't let it start
   */
  readonly equalizer: 'off' | 'on' | 'unavailable'
  /**
   * Why the equalizer is `unavailable`, where the engine knows (absent otherwise):
   *
   * - `unreadable`: the page may not read this source's bytes here (no FXM Connect for YouTube
   *   audio, a host without CORS, the desktop app's YouTube audio)
   * - `read-failed`: reading them was tried and the browser refused, although they should be
   *   readable: on googlevideo a redirect to another host with an FXM Connect older than 0.2.1,
   *   or FXM Connect's rules not applying to the answer
   * - `suspended`: the browser hasn't let Web Audio start yet; it starts with the user's next tap
   *   or click in FXM (a play, a pause)
   * - `no-web-audio`: the browser has no Web Audio, or refused to connect the source to it
   */
  readonly equalizerReason?: 'unreadable' | 'read-failed' | 'suspended' | 'no-web-audio'
  /**
   * Loudness normalization:
   *
   * - `off`: switched off
   * - `on`: the source plays at `loudnessGainDb`
   * - `no-data`: the source doesn't say how loud it is, so it plays as it is
   * - `unavailable`: the engine can't change this source's level (iOS doesn't let a page set a
   *   media element's volume)
   */
  readonly loudness: 'off' | 'on' | 'no-data' | 'unavailable'
  /** The loudness gain the source plays at, in dB: 0 when none applies. */
  readonly loudnessGainDb: number
}

/** The effects an engine applies itself ({@link Engine.setEffects}). */
export interface EngineEffects {
  /** The equalizer. */
  readonly equalizer: EqualizerSettings
  /** Loudness normalization. */
  readonly loudness: LoudnessSettings
}

/**
 * A sleep timer an engine runs itself ({@link Engine.setSleepTimer}): pause at `endsAt` (epoch
 * milliseconds), fading out over the `fadeMs` before it, or at the end of the current track.
 */
export type EngineSleepTimer =
  | { readonly endsAt: number; readonly fadeMs: number }
  | { readonly endOfTrack: true }

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
  /**
   * What the audio effects do to the source (see {@link AudioEffectsStatus}): after a load, a
   * change of the effects, and whenever it changes otherwise. Only from engines with
   * {@link Engine.setEffects}.
   */
  effects: AudioEffectsStatus
  /**
   * The engine's own sleep timer ({@link Engine.setSleepTimer}) ended: at its time, or at the end
   * of the track. It paused playback if something played, and a `pause` event comes too; the
   * player announces its own `sleep` only then.
   */
  sleep: { readonly reason: 'timer' | 'end-of-track' }
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
  /**
   * Applies the equalizer and loudness normalization to what plays from now on (stage 8.1), and
   * reports with `effects` what they do to the current source. Engines without effects leave it
   * out.
   */
  setEffects?(effects: EngineEffects): void
  /**
   * Sets the playback speed, 1 being normal, for this source and the ones after it. The pitch
   * stays. Engines that can't change the speed leave it out.
   */
  setPlaybackRate?(rate: number): void
  /**
   * Starts `source`, which {@link preload} prepared, at once and fades the current source out over
   * `durationMs` while the new one fades in: a crossfade. From then on the engine reports the new
   * source's events, as after a {@link load}: what it reports during the call (its duration, say)
   * is about the new source already, and its `play` comes once the call has returned. The old one
   * stops by itself once it has faded. Returns `false`, changing nothing, when it can't: `source`
   * isn't prepared and ready to play, nothing plays now, or the device doesn't let it fade the two
   * (see {@link canSetVolume}). Engines without crossfade leave it out.
   */
  crossfade?(source: PlaybackSource, durationMs: number): boolean
  /**
   * Whether the engine can change the level of what plays on this device: not where pages can't
   * set a media element's volume (iOS). Crossfades need it, and so do the sleep timer's fade and
   * turning loud tracks down. Engines that always can leave it out.
   */
  canSetVolume?(): boolean
  /**
   * Fades the output to `gain` (0 to 1, a factor on the volume) over `durationMs`, at once for 0,
   * whatever plays meanwhile; the sleep timer fades out with it. The volume stays what
   * {@link setVolume} set. Engines without fades leave it out.
   */
  fadeOutput?(gain: number, durationMs: number): void
  /**
   * Runs a sleep timer in the engine itself, `null` to cancel it, for engines whose playback goes
   * on while the page may not run (Android's native player): it pauses, fading out, at the time,
   * or at the end of the current track, and reports `sleep`. Others leave it out; the player then
   * runs the timer.
   */
  setSleepTimer?(timer: EngineSleepTimer | null): void
  /** Adds a listener. Returns a function that removes it again. */
  on<K extends EngineEventType>(type: K, listener: (payload: EngineEventMap[K]) => void): () => void
  /** Stops playback and releases everything. The engine is unusable afterwards. */
  destroy(): void
}
