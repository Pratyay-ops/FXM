/**
 * An engine that plays nothing: it records what the player asks of it and lets a test drive
 * what happens (progress, the end, failures).
 *
 * @module
 */

import { loudnessGainDb, type StreamOption } from '@fxm/core'
import { Emitter } from '../emitter'
import {
  type AudioEffectsStatus,
  type Engine,
  type EngineEffects,
  EngineError,
  type EngineErrorType,
  type EngineEventMap,
  type EngineEventType,
  type PlaybackSource,
  type PlaySupport,
} from '../engine'

/** One call the player made, with its arguments. */
export interface FakeEngineCall {
  /** The engine method. */
  method:
    | 'load'
    | 'play'
    | 'pause'
    | 'seek'
    | 'setVolume'
    | 'setMuted'
    | 'preload'
    | 'unlock'
    | 'destroy'
    | 'setEffects'
    | 'setPlaybackRate'
    | 'crossfade'
    | 'fadeOutput'
  /** Its arguments. */
  args: unknown[]
}

/**
 * A scriptable {@link Engine} for tests. By default `play()` reports `play` at once; set
 * `playError` to make it fail instead (e.g. `autoplay-blocked`), or `startOnPlay` to `false` to
 * stay silent until the test calls {@link FakeEngine.emit}.
 */
export class FakeEngine implements Engine {
  /** Every call, in order. */
  readonly calls: FakeEngineCall[] = []
  /** What was loaded last. */
  source: PlaybackSource | undefined
  /** The last argument of `preload()`. */
  preloaded: PlaybackSource | null | undefined
  /** The playback position, in milliseconds. */
  positionMs = 0
  /** Whether playback is paused. */
  paused = true
  /** The volume, from 0 to 1. */
  volume = 1
  /** Whether the output is muted. */
  muted = false
  /** Whether `destroy()` was called. */
  destroyed = false
  /** When set, `play()` reports this failure instead of playing. */
  playError: EngineErrorType | undefined
  /** Whether `play()` reports `play` right away. */
  startOnPlay = true
  /** What `canPlay()` answers. Default: `probably` for every stream. */
  canPlayStream: (stream: StreamOption) => PlaySupport = () => 'probably'
  /** The effects last set. */
  effects: EngineEffects | undefined
  /** The playback speed. */
  playbackRate = 1
  /** What `crossfade()` answers: whether the crossfade starts. Default: true. */
  crossfadeResult = true
  /**
   * The duration of the source a crossfade starts, in milliseconds, which `crossfade()` reports
   * with `durationchange` during the call, as an engine may (see `Engine.crossfade`). Default:
   * none, so the player keeps the track's own duration.
   */
  crossfadeDurationMs: number | undefined
  /** Every crossfade that started: the source faded in, and over how long. */
  readonly crossfades: { source: PlaybackSource; durationMs: number }[] = []
  /** The output's fade factor, from `fadeOutput()`. */
  outputGain = 1
  readonly #events = new Emitter<EngineEventMap>()

  async load(source: PlaybackSource, startAtMs = 0): Promise<void> {
    this.#record('load', source, startAtMs)
    this.source = source
    this.positionMs = startAtMs
    this.paused = true
    if (this.effects !== undefined) this.emit('effects', this.effectsStatus())
  }

  async play(): Promise<void> {
    this.#record('play')
    if (this.source === undefined || this.destroyed) return
    if (this.playError !== undefined) {
      this.fail(this.playError)
      return
    }
    this.paused = false
    if (this.startOnPlay) this.emit('play', undefined)
  }

  pause(): void {
    this.#record('pause')
    if (this.paused) return
    this.paused = true
    this.emit('pause', undefined)
  }

  seek(positionMs: number): void {
    this.#record('seek', positionMs)
    this.positionMs = positionMs
  }

  setVolume(volume: number): void {
    this.#record('setVolume', volume)
    this.volume = volume
  }

  setMuted(muted: boolean): void {
    this.#record('setMuted', muted)
    this.muted = muted
  }

  preload(source: PlaybackSource | null): void {
    this.#record('preload', source)
    this.preloaded = source
  }

  canPlay(stream: StreamOption): PlaySupport {
    return this.canPlayStream(stream)
  }

  unlock(): void {
    this.#record('unlock')
  }

  /** Records the effects and reports what they do to the source, with a boost where it can. */
  setEffects(effects: EngineEffects): void {
    this.#record('setEffects', effects)
    this.effects = effects
    this.emit('effects', this.effectsStatus())
  }

  setPlaybackRate(rate: number): void {
    this.#record('setPlaybackRate', rate)
    this.playbackRate = rate
  }

  /**
   * Starts `source` when {@link crossfadeResult} says so: it becomes the loaded source, at 0,
   * playing. Its duration ({@link crossfadeDurationMs}) is reported during the call, its `play`
   * (like a real engine's, once the call has returned) as `play()` reports it.
   */
  crossfade(source: PlaybackSource, durationMs: number): boolean {
    this.#record('crossfade', source, durationMs)
    if (!this.crossfadeResult || this.destroyed) return false
    this.crossfades.push({ source, durationMs })
    this.source = source
    this.positionMs = 0
    this.paused = false
    const duration = this.crossfadeDurationMs
    if (duration !== undefined) this.emit('durationchange', duration)
    queueMicrotask(() => {
      if (this.source !== source || this.destroyed) return
      if (this.effects !== undefined) this.emit('effects', this.effectsStatus())
      if (this.startOnPlay) this.emit('play', undefined)
    })
    return true
  }

  fadeOutput(gain: number, durationMs: number): void {
    this.#record('fadeOutput', gain, durationMs)
    this.outputGain = gain
  }

  /** What the effects last set do to the loaded source, as a simple engine reports it. */
  effectsStatus(): AudioEffectsStatus {
    const effects = this.effects
    if (effects === undefined) return { equalizer: 'off', loudness: 'off', loudnessGainDb: 0 }
    const loudness = this.source?.stream.loudness
    return {
      equalizer: effects.equalizer.enabled ? 'on' : 'off',
      loudness: !effects.loudness.enabled ? 'off' : loudness === undefined ? 'no-data' : 'on',
      loudnessGainDb: loudnessGainDb(loudness, effects.loudness, { boost: true }),
    }
  }

  on<K extends EngineEventType>(
    type: K,
    listener: (payload: EngineEventMap[K]) => void,
  ): () => void {
    return this.#events.on(type, listener)
  }

  destroy(): void {
    this.#record('destroy')
    this.destroyed = true
    this.#events.clear()
  }

  // --- Driving the fake ----------------------------------------------------------------------

  /** Reports an event to the player, as a real engine would. */
  emit<K extends EngineEventType>(type: K, payload: EngineEventMap[K]): void {
    this.#events.emit(type, payload)
  }

  /** Moves playback to `positionMs` and reports it. */
  progress(positionMs: number): void {
    this.positionMs = positionMs
    this.emit('timeupdate', positionMs)
  }

  /** Plays to the end. */
  end(): void {
    this.paused = true
    this.emit('ended', undefined)
  }

  /** Fails with an error of `type`. */
  fail(type: EngineErrorType, message = `Fake ${type} failure`): void {
    this.emit('error', new EngineError(type, message))
  }

  /** How many times `method` was called. */
  count(method: FakeEngineCall['method']): number {
    return this.calls.filter((call) => call.method === method).length
  }

  /** The URL of every stream loaded so far, in order. */
  get loadedUrls(): string[] {
    return this.calls.flatMap((call) =>
      call.method === 'load' ? [(call.args[0] as PlaybackSource).stream.url] : [],
    )
  }

  /** Where each load asked to start, in milliseconds, in order. */
  get loadStarts(): number[] {
    return this.calls.flatMap((call) => (call.method === 'load' ? [call.args[1] as number] : []))
  }

  #record(method: FakeEngineCall['method'], ...args: unknown[]): void {
    this.calls.push({ method, args })
  }
}
