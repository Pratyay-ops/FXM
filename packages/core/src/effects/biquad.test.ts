import { describe, expect, it } from 'vitest'
import {
  applyBiquad,
  type BiquadSpec,
  biquadCoefficients,
  biquadMagnitudeDb,
  biquadState,
  IDENTITY_BIQUAD,
} from './biquad'

const RATE = 48_000

/** A sine of `frequency` Hz at amplitude 0.5, `seconds` long. */
function sine(frequency: number, seconds = 0.5, rate = RATE): Float64Array {
  const samples = new Float64Array(Math.round(seconds * rate))
  for (let index = 0; index < samples.length; index++) {
    samples[index] = 0.5 * Math.sin((2 * Math.PI * frequency * index) / rate)
  }
  return samples
}

/** The RMS level of the second half of `samples` (past the filter's settling), in dB. */
function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0
  const from = Math.floor(samples.length / 2)
  for (let index = from; index < samples.length; index++) sum += (samples[index] ?? 0) ** 2
  return 10 * Math.log10(sum / (samples.length - from))
}

const peaking = (frequencyHz: number, gainDb: number, q = Math.SQRT2): BiquadSpec => ({
  type: 'peaking',
  frequencyHz,
  q,
  gainDb,
})

describe('biquadCoefficients', () => {
  it('computes the Web Audio peaking filter (Audio EQ Cookbook)', () => {
    // Worked by hand from the specification's formulas: f0 = 1 kHz, Q = 1, +6 dB at 48 kHz.
    const c = biquadCoefficients(peaking(1000, 6, 1), RATE)
    const a = 10 ** (6 / 40)
    const w0 = (2 * Math.PI * 1000) / RATE
    const alpha = Math.sin(w0) / 2
    const a0 = 1 + alpha / a
    expect(c.b0).toBeCloseTo((1 + alpha * a) / a0, 12)
    expect(c.b1).toBeCloseTo((-2 * Math.cos(w0)) / a0, 12)
    expect(c.b2).toBeCloseTo((1 - alpha * a) / a0, 12)
    expect(c.a1).toBeCloseTo((-2 * Math.cos(w0)) / a0, 12)
    expect(c.a2).toBeCloseTo((1 - alpha / a) / a0, 12)
  })

  it('lets everything through at 0 dB', () => {
    for (const type of ['peaking', 'lowshelf', 'highshelf'] as const) {
      const c = biquadCoefficients({ type, frequencyHz: 500, q: 1.4, gainDb: 0 }, RATE)
      for (const frequency of [30, 500, 5000, 18000]) {
        expect(biquadMagnitudeDb(c, frequency, RATE)).toBeCloseTo(0, 9)
      }
    }
  })

  it('is the identity for a filter that cannot act', () => {
    expect(biquadCoefficients(peaking(30_000, 6), RATE)).toBe(IDENTITY_BIQUAD)
    expect(biquadCoefficients(peaking(Number.NaN, 6), RATE)).toBe(IDENTITY_BIQUAD)
    expect(biquadCoefficients(peaking(1000, 6, 0), RATE)).toBe(IDENTITY_BIQUAD)
    expect(biquadCoefficients(peaking(1000, Number.POSITIVE_INFINITY), RATE)).toBe(IDENTITY_BIQUAD)
    expect(biquadCoefficients(peaking(1000, 6), 0)).toBe(IDENTITY_BIQUAD)
  })
})

describe('biquadMagnitudeDb', () => {
  it('gives a peaking filter its gain at its centre and little an octave or more away', () => {
    const c = biquadCoefficients(peaking(1000, 9), RATE)
    expect(biquadMagnitudeDb(c, 1000, RATE)).toBeCloseTo(9, 6)
    expect(biquadMagnitudeDb(c, 4000, RATE)).toBeLessThan(2)
    expect(biquadMagnitudeDb(c, 250, RATE)).toBeLessThan(2)
    const cut = biquadCoefficients(peaking(1000, -9), RATE)
    expect(biquadMagnitudeDb(cut, 1000, RATE)).toBeCloseTo(-9, 6)
  })

  it('gives a shelf its full gain past it and half at its midpoint', () => {
    const low = biquadCoefficients({ type: 'lowshelf', frequencyHz: 200, q: 1, gainDb: 8 }, RATE)
    expect(biquadMagnitudeDb(low, 20, RATE)).toBeCloseTo(8, 1)
    expect(biquadMagnitudeDb(low, 200, RATE)).toBeCloseTo(4, 6)
    expect(biquadMagnitudeDb(low, 10_000, RATE)).toBeCloseTo(0, 1)
    const high = biquadCoefficients(
      { type: 'highshelf', frequencyHz: 4000, q: 1, gainDb: -8 },
      RATE,
    )
    expect(biquadMagnitudeDb(high, 20_000, RATE)).toBeLessThan(-7)
    expect(biquadMagnitudeDb(high, 4000, RATE)).toBeCloseTo(-4, 6)
    expect(biquadMagnitudeDb(high, 100, RATE)).toBeCloseTo(0, 1)
  })
})

describe('applyBiquad', () => {
  it('amplifies a sine at the centre by the gain, as the magnitude says', () => {
    const c = biquadCoefficients(peaking(1000, 6), RATE)
    const input = sine(1000)
    expect(rmsDb(applyBiquad(c, input)) - rmsDb(input)).toBeCloseTo(6, 1)
    const far = sine(8000)
    const measured = rmsDb(applyBiquad(c, far)) - rmsDb(far)
    expect(measured).toBeCloseTo(biquadMagnitudeDb(c, 8000, RATE), 1)
  })

  it('continues a signal across blocks with the same state', () => {
    const c = biquadCoefficients(peaking(2000, -6), RATE)
    const input = sine(2000, 0.1)
    const whole = applyBiquad(c, input)
    const state = biquadState()
    const first = applyBiquad(c, input.subarray(0, 1000), state)
    const second = applyBiquad(c, input.subarray(1000), state)
    const joined = [...first, ...second]
    for (let index = 0; index < whole.length; index += 97) {
      expect(joined[index]).toBeCloseTo(whole[index] as number, 12)
    }
  })

  it('passes a signal through unchanged with the identity', () => {
    const input = sine(440, 0.01)
    expect([...applyBiquad(IDENTITY_BIQUAD, input)]).toEqual([...input])
  })
})
