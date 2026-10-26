/**
 * Second-order ("biquad") filters, computed exactly as the Web Audio API's `BiquadFilterNode`
 * computes them (the "Filters characteristics" section of the specification, which follows
 * Robert Bristow-Johnson's Audio EQ Cookbook). The equalizer uses them to draw its curve, to work
 * out how much headroom a setting needs, and in tests to check what an equalizer setting does to
 * a signal, without a browser. The Android app's equalizer computes the same coefficients
 * (`fxm-player`'s `Biquad.kt`), so a setting sounds the same everywhere.
 *
 * @module
 */

/** The filter shapes the equalizer uses, named as `BiquadFilterNode.type` names them. */
export type BiquadType = 'peaking' | 'lowshelf' | 'highshelf'

/** One filter of an equalizer: what a `BiquadFilterNode` is set to. */
export interface BiquadSpec {
  /** The filter's shape. */
  readonly type: BiquadType
  /** Its centre (peaking) or midpoint (shelves) frequency, in Hz. */
  readonly frequencyHz: number
  /** Its quality factor; the shelves ignore it, as `BiquadFilterNode` does. */
  readonly q: number
  /** Its gain, in dB: a boost when positive, a cut when negative. */
  readonly gainDb: number
}

/**
 * A biquad's coefficients, normalized so that `a0` is 1: the filter computes
 * `y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2] − a1·y[n−1] − a2·y[n−2]`.
 */
export interface BiquadCoefficients {
  readonly b0: number
  readonly b1: number
  readonly b2: number
  readonly a1: number
  readonly a2: number
}

/** The coefficients that let a signal through unchanged. */
export const IDENTITY_BIQUAD: BiquadCoefficients = Object.freeze({
  b0: 1,
  b1: 0,
  b2: 0,
  a1: 0,
  a2: 0,
})

/**
 * The coefficients of `spec` at `sampleRate`, as `BiquadFilterNode` computes them: `A =
 * 10^(gain/40)`, `ω0 = 2π·f0/Fs`, `α = sin ω0 / 2Q` for the peaking filter, and for the shelves
 * `α = sin ω0 / 2 · √2` (a shelf slope of 1). A frequency at or above the Nyquist frequency, or
 * a value that isn't finite, gives {@link IDENTITY_BIQUAD}, as a filter that can't act.
 */
export function biquadCoefficients(spec: BiquadSpec, sampleRate: number): BiquadCoefficients {
  const { type, frequencyHz, q, gainDb } = spec
  if (
    !Number.isFinite(frequencyHz) ||
    !Number.isFinite(q) ||
    !Number.isFinite(gainDb) ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    frequencyHz <= 0 ||
    frequencyHz >= sampleRate / 2 ||
    q <= 0
  ) {
    return IDENTITY_BIQUAD
  }
  const a = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * frequencyHz) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  let b0: number
  let b1: number
  let b2: number
  let a0: number
  let a1: number
  let a2: number
  if (type === 'peaking') {
    const alpha = sin / (2 * q)
    b0 = 1 + alpha * a
    b1 = -2 * cos
    b2 = 1 - alpha * a
    a0 = 1 + alpha / a
    a1 = -2 * cos
    a2 = 1 - alpha / a
  } else {
    // A shelf slope S of 1: α = sin ω0 / 2 · √((A + 1/A)(1/S − 1) + 2).
    const alpha = (sin / 2) * Math.SQRT2
    const twoSqrtAAlpha = 2 * Math.sqrt(a) * alpha
    if (type === 'lowshelf') {
      b0 = a * (a + 1 - (a - 1) * cos + twoSqrtAAlpha)
      b1 = 2 * a * (a - 1 - (a + 1) * cos)
      b2 = a * (a + 1 - (a - 1) * cos - twoSqrtAAlpha)
      a0 = a + 1 + (a - 1) * cos + twoSqrtAAlpha
      a1 = -2 * (a - 1 + (a + 1) * cos)
      a2 = a + 1 + (a - 1) * cos - twoSqrtAAlpha
    } else {
      b0 = a * (a + 1 + (a - 1) * cos + twoSqrtAAlpha)
      b1 = -2 * a * (a - 1 + (a + 1) * cos)
      b2 = a * (a + 1 + (a - 1) * cos - twoSqrtAAlpha)
      a0 = a + 1 - (a - 1) * cos + twoSqrtAAlpha
      a1 = 2 * (a - 1 - (a + 1) * cos)
      a2 = a + 1 - (a - 1) * cos - twoSqrtAAlpha
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/**
 * How much the filter `coefficients` amplifies a sine at `frequencyHz`, in dB: the magnitude of
 * its transfer function at `e^(jω)`, `ω = 2π·f/Fs`, as `BiquadFilterNode.getFrequencyResponse`
 * reports it (there as a linear value).
 */
export function biquadMagnitudeDb(
  coefficients: BiquadCoefficients,
  frequencyHz: number,
  sampleRate: number,
): number {
  const { b0, b1, b2, a1, a2 } = coefficients
  const w = (2 * Math.PI * frequencyHz) / sampleRate
  const cos1 = Math.cos(w)
  const sin1 = Math.sin(w)
  const cos2 = Math.cos(2 * w)
  const sin2 = Math.sin(2 * w)
  // H(e^jω) = (b0 + b1·e^−jω + b2·e^−2jω) / (1 + a1·e^−jω + a2·e^−2jω)
  const numRe = b0 + b1 * cos1 + b2 * cos2
  const numIm = -(b1 * sin1 + b2 * sin2)
  const denRe = 1 + a1 * cos1 + a2 * cos2
  const denIm = -(a1 * sin1 + a2 * sin2)
  const power = (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm)
  return 10 * Math.log10(power)
}

/** What a running biquad remembers between blocks of samples (transposed direct form II). */
export interface BiquadState {
  z1: number
  z2: number
}

/** A fresh {@link BiquadState}: silence so far. */
export function biquadState(): BiquadState {
  return { z1: 0, z2: 0 }
}

/**
 * Runs `input` through the filter, in transposed direct form II, and returns the filtered
 * samples. Pass the same `state` to filter a signal block by block. For tests and offline
 * checks: in the app, `BiquadFilterNode` (web) and the native equalizer (Android) do the work.
 */
export function applyBiquad(
  coefficients: BiquadCoefficients,
  input: ArrayLike<number>,
  state: BiquadState = biquadState(),
): Float64Array {
  const { b0, b1, b2, a1, a2 } = coefficients
  const output = new Float64Array(input.length)
  let { z1, z2 } = state
  for (let index = 0; index < input.length; index++) {
    const x = input[index] ?? 0
    const y = b0 * x + z1
    z1 = b1 * x - a1 * y + z2
    z2 = b2 * x - a2 * y
    output[index] = y
  }
  state.z1 = z1
  state.z2 = z2
  return output
}
