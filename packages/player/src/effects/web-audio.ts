/**
 * The audio effects on Web Audio, for the direct audio engine (web and desktop): the equalizer,
 * loudness gains above unity, crossfades and fades, on media elements whose bytes the page can
 * read.
 *
 * ```
 * element ─ MediaElementAudioSourceNode ─ loudness gain ─ fade gain ─┐
 * element ─ MediaElementAudioSourceNode ─ loudness gain ─ fade gain ─┴─ headroom gain
 *   ─ 10 peaking filters (31 Hz … 16 kHz) ─ master gain (volume, mute, output fade) ─ speakers
 * ```
 *
 * **Readable bytes only.** A `MediaElementAudioSourceNode` outputs silence for a media element
 * whose resource is CORS-cross-origin (Web Audio specification, "MediaElementAudioSourceNode"),
 * and an element stays routed through Web Audio for good once connected. So only elements that
 * play CORS-readable media are connected, and they ask for it with `crossorigin="anonymous"`:
 * local files and downloads (`blob:` URLs), Internet Archive and Jamendo (CORS for any page),
 * and googlevideo through FXM Connect, which adds CORS for the FXM origin (unless a redirect
 * moved the stream to another host: the engine then plays it without effects).
 *
 * @module
 */

import {
  dbToGain,
  EQUALIZER_BANDS_HZ,
  EQUALIZER_Q,
  equalizerHeadroomDb,
  isFlatEqualizer,
} from '@fxm/core'

/** An `AudioParam`, as far as the effects use it. */
export interface EffectsParam {
  value: number
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown
  cancelScheduledValues(cancelTime: number): unknown
}

/** An `AudioNode`, as far as the effects use it. */
export interface EffectsNode {
  connect(destination: EffectsNode): unknown
  disconnect(): void
}

/** A `GainNode`. */
export interface EffectsGain extends EffectsNode {
  readonly gain: EffectsParam
}

/** A `BiquadFilterNode`. */
export interface EffectsFilter extends EffectsNode {
  type: BiquadFilterType
  readonly frequency: EffectsParam
  readonly Q: EffectsParam
  readonly gain: EffectsParam
}

/**
 * The parts of an `AudioContext` the effects use, so tests can pass a fake (`@fxm/player/testing`
 * has one that computes what the graph does to a signal).
 */
export interface EffectsContext {
  /** `running` while audio flows; `suspended` (or Safari's `interrupted`) otherwise. */
  readonly state: string
  readonly currentTime: number
  readonly sampleRate: number
  readonly destination: EffectsNode
  createGain(): EffectsGain
  createBiquadFilter(): EffectsFilter
  createMediaElementSource(element: HTMLMediaElement): EffectsNode
  resume(): Promise<void>
  close?(): Promise<void>
  addEventListener(type: 'statechange', listener: () => void): void
}

/**
 * How fast parameters move to a new value, in seconds (the time constant of `setTargetAtTime`):
 * fast enough to follow a fade step, slow enough not to click.
 */
const PARAM_TIME_CONSTANT = 0.012

/** Moves `param` smoothly to `value`. */
export function setParam(context: EffectsContext, param: EffectsParam, value: number): void {
  if (!Number.isFinite(value)) return
  const now = context.currentTime
  param.cancelScheduledValues(now)
  param.setTargetAtTime(value, now, PARAM_TIME_CONSTANT)
}

/** One media element's way into the graph. */
export interface ElementChain {
  /** The element's source node. */
  readonly source: EffectsNode
  /** Its track's loudness gain (above unity where the track is quiet). */
  readonly loudness: EffectsGain
  /** Its crossfade factor. */
  readonly fade: EffectsGain
}

/** The effects graph on one audio context: see the module documentation. */
export class EffectsGraph {
  readonly context: EffectsContext
  readonly #headroom: EffectsGain
  readonly #filters: readonly EffectsFilter[]
  readonly #master: EffectsGain

  constructor(context: EffectsContext) {
    this.context = context
    this.#headroom = context.createGain()
    this.#filters = EQUALIZER_BANDS_HZ.map((frequencyHz) => {
      const filter = context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = frequencyHz
      filter.Q.value = EQUALIZER_Q
      filter.gain.value = 0
      return filter
    })
    this.#master = context.createGain()
    let previous: EffectsNode = this.#headroom
    for (const filter of this.#filters) {
      previous.connect(filter)
      previous = filter
    }
    previous.connect(this.#master)
    this.#master.connect(context.destination)
  }

  /** Connects `element` to the graph, for good. Throws where the browser refuses. */
  connect(element: HTMLMediaElement): ElementChain {
    const { context } = this
    const source = context.createMediaElementSource(element)
    const loudness = context.createGain()
    const fade = context.createGain()
    source.connect(loudness)
    loudness.connect(fade)
    fade.connect(this.#headroom)
    return { source, loudness, fade }
  }

  /**
   * Sets the equalizer's gains, or flat (`undefined`: the equalizer is off), with the headroom
   * that keeps its boosts from clipping (`equalizerHeadroomDb`).
   */
  setEqualizer(gainsDb: readonly number[] | undefined): void {
    const { context } = this
    const on = gainsDb !== undefined && !isFlatEqualizer(gainsDb)
    for (const [index, filter] of this.#filters.entries()) {
      setParam(context, filter.gain, on ? (gainsDb[index] ?? 0) : 0)
    }
    const headroomDb = on ? equalizerHeadroomDb(gainsDb, context.sampleRate) : 0
    setParam(context, this.#headroom.gain, dbToGain(headroomDb))
  }

  /** Sets the output level: the volume, 0 while muted, times the output fade. */
  setMaster(gain: number): void {
    setParam(this.context, this.#master.gain, gain)
  }
}
