/**
 * The equalizer: ten bands an octave apart, presets, the setting and its validation, and the
 * curve a setting draws. It is a graphic equalizer of peaking filters, so each slider sets the
 * gain at its own frequency. Every platform runs the same filters ({@link equalizerFilters}): Web
 * Audio's `BiquadFilterNode` on the web and the desktop app, a Media3 audio processor on Android.
 *
 * @module
 */

import { type BiquadSpec, biquadCoefficients, biquadMagnitudeDb } from './biquad'
import { ownFields } from './fields'

/** The bands' centre frequencies, in Hz: the ISO octave bands from 31 Hz to 16 kHz. */
export const EQUALIZER_BANDS_HZ: readonly number[] = Object.freeze([
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
])

/** How many bands the equalizer has. */
export const EQUALIZER_BAND_COUNT = EQUALIZER_BANDS_HZ.length

/** The lowest gain a band takes, in dB. */
export const EQUALIZER_MIN_GAIN_DB = -12

/** The highest gain a band takes, in dB. */
export const EQUALIZER_MAX_GAIN_DB = 12

/** The step a band's gain moves in, in dB. */
export const EQUALIZER_GAIN_STEP_DB = 0.5

/** The quality factor of each band's peaking filter: √2, a bandwidth of about one octave. */
export const EQUALIZER_Q = Math.SQRT2

/** The equalizer's presets, by ID. */
export type EqualizerPresetId =
  | 'flat'
  | 'bass-boost'
  | 'bass-reducer'
  | 'treble-boost'
  | 'treble-reducer'
  | 'vocal'
  | 'rock'
  | 'pop'
  | 'jazz'
  | 'classical'
  | 'electronic'
  | 'hip-hop'
  | 'acoustic'
  | 'loudness'
  | 'spoken-word'

/** A preset: its name for people and a gain per band. */
export interface EqualizerPreset {
  readonly id: EqualizerPresetId
  readonly label: string
  /** One gain per band of {@link EQUALIZER_BANDS_HZ}, in dB. */
  readonly gainsDb: readonly number[]
}

function preset(id: EqualizerPresetId, label: string, gainsDb: number[]): EqualizerPreset {
  return Object.freeze({ id, label, gainsDb: Object.freeze(gainsDb) })
}

/** Every preset, in the order a menu lists them, Flat first. */
export const EQUALIZER_PRESETS: readonly EqualizerPreset[] = Object.freeze([
  preset('flat', 'Flat', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  preset('bass-boost', 'Bass boost', [6, 5, 4, 2, 0.5, 0, 0, 0, 0, 0]),
  preset('bass-reducer', 'Bass reducer', [-6, -5, -4, -2, -0.5, 0, 0, 0, 0, 0]),
  preset('treble-boost', 'Treble boost', [0, 0, 0, 0, 0, 0.5, 2, 4, 5, 6]),
  preset('treble-reducer', 'Treble reducer', [0, 0, 0, 0, 0, -0.5, -2, -4, -5, -6]),
  preset('vocal', 'Vocal', [-2, -2, -1, 1, 3, 4, 3, 1.5, 0, -1]),
  preset('rock', 'Rock', [4, 3, 1.5, 0, -1, -0.5, 1, 2.5, 3.5, 4]),
  preset('pop', 'Pop', [-1, 0, 1.5, 3, 3.5, 2, 0, -0.5, -1, -1]),
  preset('jazz', 'Jazz', [3, 2, 1, 1.5, -1, -1, 0, 1, 2, 3]),
  preset('classical', 'Classical', [3, 2, 1, 0, 0, 0, -1, -1.5, 1, 2]),
  preset('electronic', 'Electronic', [5, 4, 1, 0, -2, 1, 0, 1, 3, 4]),
  preset('hip-hop', 'Hip-hop', [5, 4, 2, 2.5, -1, -1, 1, 0, 1.5, 2.5]),
  preset('acoustic', 'Acoustic', [3, 2, 1, 1, 2, 2, 3, 2, 2, 1]),
  preset('loudness', 'Loudness', [5, 4, 2, 0, -1.5, -2, -0.5, 2, 4, 5]),
  preset('spoken-word', 'Spoken word', [-4, -3, -1, 1, 3, 4, 4, 2, 0, -2]),
])

/** The preset with ID `id`. */
export function equalizerPreset(id: EqualizerPresetId): EqualizerPreset {
  return (
    EQUALIZER_PRESETS.find((candidate) => candidate.id === id) ??
    (EQUALIZER_PRESETS[0] as EqualizerPreset)
  )
}

/** Whether `value` is an {@link EqualizerPresetId}. */
export function isEqualizerPresetId(value: unknown): value is EqualizerPresetId {
  return typeof value === 'string' && EQUALIZER_PRESETS.some((candidate) => candidate.id === value)
}

/** The equalizer setting. Validate stored copies with {@link sanitizeEqualizer}. */
export interface EqualizerSettings {
  /** Whether the equalizer is on. Off by default. */
  readonly enabled: boolean
  /** One gain per band of {@link EQUALIZER_BANDS_HZ}, in dB, from -12 to 12 in steps of 0.5. */
  readonly gainsDb: readonly number[]
  /** The preset the gains are, or `custom` once a band was moved away from it. */
  readonly preset: EqualizerPresetId | 'custom'
}

/** The equalizer of a fresh install: off and flat. */
export const DEFAULT_EQUALIZER: EqualizerSettings = Object.freeze({
  enabled: false,
  gainsDb: equalizerPreset('flat').gainsDb,
  preset: 'flat',
})

/** A band's gain, clamped to the range and rounded to the step; 0 for anything but a number. */
export function clampEqualizerGain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const clamped = Math.min(EQUALIZER_MAX_GAIN_DB, Math.max(EQUALIZER_MIN_GAIN_DB, value))
  // + 0 turns -0 into 0.
  return Math.round(clamped / EQUALIZER_GAIN_STEP_DB) * EQUALIZER_GAIN_STEP_DB + 0
}

/** The preset whose gains are exactly `gainsDb`, or `custom`. */
export function presetOfGains(gainsDb: readonly number[]): EqualizerPresetId | 'custom' {
  const match = EQUALIZER_PRESETS.find((candidate) =>
    candidate.gainsDb.every((gain, index) => gain === gainsDb[index]),
  )
  return match?.id ?? 'custom'
}

/**
 * A valid {@link EqualizerSettings} from an untrusted value, such as a setting read from storage:
 * a missing or invalid field gets its default, each gain is clamped and rounded, a list of the
 * wrong length is flat, and the preset is checked against the gains. Never throws, never reads
 * inherited fields.
 */
export function sanitizeEqualizer(value: unknown): EqualizerSettings {
  const stored = ownFields(value)
  const enabled = stored('enabled')
  const gains = stored('gainsDb')
  const gainsDb =
    Array.isArray(gains) && gains.length === EQUALIZER_BAND_COUNT
      ? gains.map(clampEqualizerGain)
      : [...DEFAULT_EQUALIZER.gainsDb]
  const named = stored('preset')
  const matches = presetOfGains(gainsDb)
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_EQUALIZER.enabled,
    gainsDb,
    // A stored preset name counts only while the gains are that preset's.
    preset: isEqualizerPresetId(named) && named === matches ? named : matches,
  }
}

/** Whether every band of `gainsDb` is at 0 dB: the equalizer then changes nothing. */
export function isFlatEqualizer(gainsDb: readonly number[]): boolean {
  return gainsDb.every((gain) => gain === 0)
}

/**
 * The filters an equalizer setting runs, one peaking filter per band (Q √2), whatever its
 * `enabled` says: the caller decides whether they run.
 */
export function equalizerFilters(gainsDb: readonly number[]): BiquadSpec[] {
  return EQUALIZER_BANDS_HZ.map((frequencyHz, index) => ({
    type: 'peaking',
    frequencyHz,
    q: EQUALIZER_Q,
    gainDb: clampEqualizerGain(gainsDb[index] ?? 0),
  }))
}

/** The sample rate the curve and the headroom are worked out at, unless the caller says. */
export const EQUALIZER_REFERENCE_RATE = 48_000

/**
 * `count` frequencies spaced evenly on a logarithmic scale from `fromHz` to `toHz`, for drawing a
 * curve: the default is 128 points from 20 Hz to 20 kHz.
 */
export function logFrequencies(count = 128, fromHz = 20, toHz = 20_000): number[] {
  if (count < 2) return [fromHz]
  const ratio = Math.log(toHz / fromHz)
  return Array.from(
    { length: count },
    (_, index) => fromHz * Math.exp((ratio * index) / (count - 1)),
  )
}

/**
 * What the equalizer does at each of `frequencies`, in dB: the sum of every band's response, as
 * the cascade of filters plays it. For the curve in Settings, and for {@link equalizerHeadroomDb}.
 */
export function equalizerResponseDb(
  gainsDb: readonly number[],
  frequencies: readonly number[] = logFrequencies(),
  sampleRate = EQUALIZER_REFERENCE_RATE,
): number[] {
  const filters = equalizerFilters(gainsDb)
    .filter((filter) => filter.gainDb !== 0)
    .map((filter) => biquadCoefficients(filter, sampleRate))
  return frequencies.map((frequency) =>
    filters.reduce((sum, filter) => sum + biquadMagnitudeDb(filter, frequency, sampleRate), 0),
  )
}

/**
 * How far to lower the level before the equalizer so that its boosts can't push audio that
 * peaks at full scale past it, in dB (0 or negative): minus the highest point of the curve
 * between 20 Hz and 20 kHz, or 0 when nothing is boosted. Every platform applies it, so a bass
 * boost makes the rest quieter rather than distorting a loud master.
 */
export function equalizerHeadroomDb(
  gainsDb: readonly number[],
  sampleRate = EQUALIZER_REFERENCE_RATE,
): number {
  if (!gainsDb.some((gain) => gain > 0)) return 0
  // The band centres (where the peaks are) plus a fine grid in between.
  const frequencies = [...EQUALIZER_BANDS_HZ, ...logFrequencies(256)]
  const peak = Math.max(0, ...equalizerResponseDb(gainsDb, frequencies, sampleRate))
  // Rounded to a hundredth of a dB, so the same setting always gives the same number.
  return -Math.round(peak * 100) / 100 + 0
}
