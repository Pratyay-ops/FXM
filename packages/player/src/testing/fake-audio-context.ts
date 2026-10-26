/**
 * An audio context that plays nothing: it builds the graph the effects ask for and computes, like
 * an `OfflineAudioContext` would, what reaches the speakers when connected media elements play
 * a given signal. Gains multiply, filters run `BiquadFilterNode`'s own formulas (`@fxm/core`'s
 * biquad module), and nodes add up their inputs. Parameter changes apply at once.
 *
 * @module
 */

import { applyBiquad, type BiquadType, biquadCoefficients } from '@fxm/core'
import type {
  EffectsContext,
  EffectsFilter,
  EffectsGain,
  EffectsNode,
  EffectsParam,
} from '../effects/web-audio'

/** An `AudioParam` whose changes apply at once; it records each target it was moved to. */
export class FakeParam implements EffectsParam {
  value: number
  /** Every value `setTargetAtTime` moved it to, in order. */
  readonly targets: number[] = []

  constructor(value: number) {
    this.value = value
  }

  setTargetAtTime(target: number): void {
    this.value = target
    this.targets.push(target)
  }

  cancelScheduledValues(): void {}
}

/** A node of the fake graph. */
export abstract class FakeNode implements EffectsNode {
  /** The nodes connected to this one. */
  readonly inputs: FakeNode[] = []
  /** The nodes this one is connected to. */
  readonly outputs: FakeNode[] = []

  connect(destination: EffectsNode): EffectsNode {
    const node = destination as FakeNode
    node.inputs.push(this)
    this.outputs.push(node)
    return destination
  }

  disconnect(): void {
    for (const output of this.outputs) output.inputs.splice(output.inputs.indexOf(this), 1)
    this.outputs.length = 0
  }

  /** What the node outputs over `length` samples while `signals` play. */
  abstract render(length: number, signals: RenderSignals): Float64Array

  /** The sum of what the inputs output. */
  protected mix(length: number, signals: RenderSignals): Float64Array {
    const sum = new Float64Array(length)
    for (const input of this.inputs) {
      const samples = input.render(length, signals)
      for (let index = 0; index < length; index++)
        sum[index] = (sum[index] ?? 0) + (samples[index] ?? 0)
    }
    return sum
  }
}

/** What each connected media element plays, for {@link FakeAudioContext.render}. */
export type RenderSignals = ReadonlyMap<HTMLMediaElement, ArrayLike<number>>

class FakeGainNode extends FakeNode implements EffectsGain {
  readonly gain = new FakeParam(1)

  render(length: number, signals: RenderSignals): Float64Array {
    const samples = this.mix(length, signals)
    for (let index = 0; index < length; index++)
      samples[index] = (samples[index] ?? 0) * this.gain.value
    return samples
  }
}

const SHAPES: ReadonlySet<string> = new Set(['peaking', 'lowshelf', 'highshelf'])

class FakeFilterNode extends FakeNode implements EffectsFilter {
  type: BiquadFilterType = 'lowpass'
  readonly frequency = new FakeParam(350)
  readonly Q = new FakeParam(1)
  readonly gain = new FakeParam(0)
  readonly #sampleRate: number

  constructor(sampleRate: number) {
    super()
    this.#sampleRate = sampleRate
  }

  render(length: number, signals: RenderSignals): Float64Array {
    const samples = this.mix(length, signals)
    // Only the shapes the equalizer uses are modelled; others pass the signal through.
    if (!SHAPES.has(this.type)) return samples
    const coefficients = biquadCoefficients(
      {
        type: this.type as BiquadType,
        frequencyHz: this.frequency.value,
        q: this.Q.value,
        gainDb: this.gain.value,
      },
      this.#sampleRate,
    )
    return applyBiquad(coefficients, samples)
  }
}

class FakeSourceNode extends FakeNode {
  readonly element: HTMLMediaElement

  constructor(element: HTMLMediaElement) {
    super()
    this.element = element
  }

  render(length: number, signals: RenderSignals): Float64Array {
    const signal = signals.get(this.element)
    return Float64Array.from({ length }, (_, index) => signal?.[index] ?? 0)
  }
}

class FakeDestinationNode extends FakeNode {
  render(length: number, signals: RenderSignals): Float64Array {
    return this.mix(length, signals)
  }
}

/** A scriptable {@link EffectsContext}: see the module documentation. */
export class FakeAudioContext implements EffectsContext {
  state: string
  currentTime = 0
  readonly sampleRate: number
  readonly destination = new FakeDestinationNode()
  /** The source node of each connected element. */
  readonly sources = new Map<HTMLMediaElement, FakeNode>()
  /** How many times `resume()` was called. */
  resumes = 0
  /** Whether `resume()` makes the context run. Default: true. */
  resumeWorks = true
  /** Whether `close()` was called. */
  closed = false
  readonly #listeners: (() => void)[] = []

  constructor(options: { state?: string; sampleRate?: number } = {}) {
    this.state = options.state ?? 'running'
    this.sampleRate = options.sampleRate ?? 48_000
  }

  createGain(): EffectsGain {
    return new FakeGainNode()
  }

  createBiquadFilter(): EffectsFilter {
    return new FakeFilterNode(this.sampleRate)
  }

  /** Like the real one, it refuses an element that is connected already. */
  createMediaElementSource(element: HTMLMediaElement): EffectsNode {
    if (this.sources.has(element)) {
      throw new DOMException('The element is connected already', 'InvalidStateError')
    }
    const source = new FakeSourceNode(element)
    this.sources.set(element, source)
    return source
  }

  resume(): Promise<void> {
    this.resumes += 1
    if (this.resumeWorks && this.state !== 'running') this.setState('running')
    return Promise.resolve()
  }

  async close(): Promise<void> {
    this.closed = true
    this.setState('closed')
  }

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.#listeners.push(listener)
  }

  /** Changes the state, as the browser would, and announces it. */
  setState(state: string): void {
    if (this.state === state) return
    this.state = state
    for (const listener of [...this.#listeners]) listener()
  }

  /**
   * What reaches the speakers over `length` samples while each element in `signals` plays its
   * signal (elements not in it play silence, as an opaque resource does).
   */
  render(signals: RenderSignals, length?: number): Float64Array {
    const longest = Math.max(0, ...[...signals.values()].map((signal) => signal.length))
    return this.destination.render(length ?? longest, signals)
  }
}
