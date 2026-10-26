import {
  dbToGain,
  EQUALIZER_BANDS_HZ,
  equalizerHeadroomDb,
  equalizerPreset,
  equalizerResponseDb,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { FakeAudioContext } from '../testing/fake-audio-context'
import { EffectsGraph } from './web-audio'

const RATE = 48_000

/** Half a second of a sine at `frequency` Hz, amplitude 0.25. */
function sine(frequency: number): Float64Array {
  return Float64Array.from(
    { length: RATE / 2 },
    (_, index) => 0.25 * Math.sin((2 * Math.PI * frequency * index) / RATE),
  )
}

/** The level of `samples` over their second half, past the filters' settling, in dB. */
function levelDb(samples: ArrayLike<number>): number {
  let sum = 0
  const from = Math.floor(samples.length / 2)
  for (let index = from; index < samples.length; index++) sum += (samples[index] ?? 0) ** 2
  return 10 * Math.log10(sum / (samples.length - from))
}

function setup() {
  const context = new FakeAudioContext({ sampleRate: RATE })
  const graph = new EffectsGraph(context)
  const element = document.createElement('audio')
  const chain = graph.connect(element)
  /** How many dB the graph adds to a sine at `frequency`. */
  const gainAt = (frequency: number) => {
    const input = sine(frequency)
    return levelDb(context.render(new Map([[element, input]]))) - levelDb(input)
  }
  return { context, graph, element, chain, gainAt }
}

describe('EffectsGraph', () => {
  it('passes audio through unchanged while every effect is neutral', () => {
    const { gainAt } = setup()
    for (const frequency of [50, 1000, 12_000]) expect(gainAt(frequency)).toBeCloseTo(0, 6)
  })

  it('applies the equalizer with its headroom, as its curve says', () => {
    const { graph, gainAt } = setup()
    const gains = equalizerPreset('rock').gainsDb
    graph.setEqualizer(gains)
    const headroom = equalizerHeadroomDb(gains, RATE)
    expect(headroom).toBeLessThan(0)
    for (const frequency of [62, 1000, 8000]) {
      const [curve = 0] = equalizerResponseDb(gains, [frequency], RATE)
      expect(gainAt(frequency)).toBeCloseTo(curve + headroom, 1)
    }
    // Nothing peaks above its input: the headroom covers the largest boost.
    const peak = Math.max(...EQUALIZER_BANDS_HZ.map(gainAt))
    expect(peak).toBeLessThanOrEqual(0.05)
  })

  it('goes flat again when the equalizer is switched off', () => {
    const { graph, gainAt } = setup()
    graph.setEqualizer(equalizerPreset('bass-boost').gainsDb)
    expect(gainAt(62)).not.toBeCloseTo(0, 1)
    graph.setEqualizer(undefined)
    expect(gainAt(62)).toBeCloseTo(0, 6)
    expect(gainAt(4000)).toBeCloseTo(0, 6)
  })

  it('applies an element’s loudness gain and fade, and the master level', () => {
    const { graph, chain, gainAt } = setup()
    chain.loudness.gain.value = dbToGain(4.5)
    expect(gainAt(1000)).toBeCloseTo(4.5, 3)
    chain.fade.gain.value = 0.5
    expect(gainAt(1000)).toBeCloseTo(4.5 - 6.02, 2)
    graph.setMaster(0)
    expect(gainAt(1000)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('mixes the elements connected to it', () => {
    const { context, graph, element } = setup()
    const other = document.createElement('audio')
    graph.connect(other)
    const input = sine(440)
    const mixed = context.render(
      new Map([
        [element, input],
        [other, input],
      ]),
    )
    expect(levelDb(mixed) - levelDb(input)).toBeCloseTo(6.02, 2)
  })

  it('refuses to connect an element twice, as browsers do', () => {
    const { graph, element } = setup()
    expect(() => graph.connect(element)).toThrow(/connected already/)
  })

  it('moves parameters smoothly, from the current time', () => {
    const { context, graph } = setup()
    context.currentTime = 12
    graph.setEqualizer(equalizerPreset('vocal').gainsDb)
    graph.setMaster(0.4)
    // The fake applies targets at once; it records them in order.
    const master = [...context.destination.inputs][0] as unknown as { gain: { targets: number[] } }
    expect(master.gain.targets.at(-1)).toBe(0.4)
  })
})
