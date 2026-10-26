import { describe, expect, it } from 'vitest'
import { applyBiquad, biquadCoefficients } from './biquad'
import {
  clampEqualizerGain,
  DEFAULT_EQUALIZER,
  EQUALIZER_BAND_COUNT,
  EQUALIZER_BANDS_HZ,
  EQUALIZER_GAIN_STEP_DB,
  EQUALIZER_MAX_GAIN_DB,
  EQUALIZER_MIN_GAIN_DB,
  EQUALIZER_PRESETS,
  equalizerFilters,
  equalizerHeadroomDb,
  equalizerPreset,
  equalizerResponseDb,
  isEqualizerPresetId,
  isFlatEqualizer,
  logFrequencies,
  presetOfGains,
  sanitizeEqualizer,
} from './equalizer'

const RATE = 48_000

function bandGains(band: number, gainDb: number): number[] {
  return EQUALIZER_BANDS_HZ.map((_, index) => (index === band ? gainDb : 0))
}

describe('the bands and presets', () => {
  it('has ten octave bands from 31 Hz to 16 kHz', () => {
    expect(EQUALIZER_BAND_COUNT).toBe(10)
    expect(EQUALIZER_BANDS_HZ[0]).toBe(31)
    expect(EQUALIZER_BANDS_HZ.at(-1)).toBe(16_000)
  })

  it('gives every preset one valid gain per band, and unique gains', () => {
    const seen = new Set<string>()
    for (const preset of EQUALIZER_PRESETS) {
      expect(preset.gainsDb).toHaveLength(EQUALIZER_BAND_COUNT)
      for (const gain of preset.gainsDb) expect(clampEqualizerGain(gain)).toBe(gain)
      expect(seen.has(preset.gainsDb.join())).toBe(false)
      seen.add(preset.gainsDb.join())
      expect(presetOfGains(preset.gainsDb)).toBe(preset.id)
      expect(isEqualizerPresetId(preset.id)).toBe(true)
    }
    expect(EQUALIZER_PRESETS[0]?.id).toBe('flat')
    expect(equalizerPreset('rock').label).toBe('Rock')
  })

  it('starts off and flat', () => {
    expect(DEFAULT_EQUALIZER.enabled).toBe(false)
    expect(isFlatEqualizer(DEFAULT_EQUALIZER.gainsDb)).toBe(true)
    expect(DEFAULT_EQUALIZER.preset).toBe('flat')
  })
})

describe('clampEqualizerGain', () => {
  it('clamps to ±12 dB and rounds to half a decibel', () => {
    expect(clampEqualizerGain(20)).toBe(EQUALIZER_MAX_GAIN_DB)
    expect(clampEqualizerGain(-20)).toBe(EQUALIZER_MIN_GAIN_DB)
    expect(clampEqualizerGain(3.3)).toBe(3.5)
    expect(clampEqualizerGain(-0.2)).toBe(0)
    expect(Object.is(clampEqualizerGain(-0.2), -0)).toBe(false)
    expect(clampEqualizerGain('6')).toBe(0)
    expect(clampEqualizerGain(Number.NaN)).toBe(0)
    expect(EQUALIZER_GAIN_STEP_DB).toBe(0.5)
  })
})

describe('sanitizeEqualizer', () => {
  it('keeps a valid setting and names its preset', () => {
    const rock = equalizerPreset('rock').gainsDb
    expect(sanitizeEqualizer({ enabled: true, gainsDb: rock, preset: 'rock' })).toEqual({
      enabled: true,
      gainsDb: [...rock],
      preset: 'rock',
    })
  })

  it('finds the preset from the gains, whatever the stored name says', () => {
    const rock = equalizerPreset('rock').gainsDb
    expect(sanitizeEqualizer({ gainsDb: rock, preset: 'jazz' }).preset).toBe('rock')
    expect(sanitizeEqualizer({ gainsDb: bandGains(3, 2), preset: 'rock' }).preset).toBe('custom')
  })

  it('falls back to the defaults for missing, broken or inherited fields', () => {
    expect(sanitizeEqualizer(undefined)).toEqual({
      ...DEFAULT_EQUALIZER,
      gainsDb: [...DEFAULT_EQUALIZER.gainsDb],
    })
    expect(sanitizeEqualizer({ enabled: 'yes', gainsDb: [1, 2, 3] })).toEqual({
      enabled: false,
      gainsDb: [...DEFAULT_EQUALIZER.gainsDb],
      preset: 'flat',
    })
    const inherited = Object.create({ enabled: true, gainsDb: bandGains(0, 6) })
    expect(sanitizeEqualizer(inherited).enabled).toBe(false)
    expect(sanitizeEqualizer([true]).enabled).toBe(false)
  })

  it('clamps and rounds each gain', () => {
    const gains = sanitizeEqualizer({ gainsDb: [99, -99, 0.3, 'x', null, 1, 1, 1, 1, 1] }).gainsDb
    expect(gains).toEqual([12, -12, 0.5, 0, 0, 1, 1, 1, 1, 1])
  })
})

describe('equalizerFilters', () => {
  it('is one peaking filter per band with a Q of √2', () => {
    const filters = equalizerFilters(bandGains(5, 4))
    expect(filters).toHaveLength(10)
    expect(filters.every((filter) => filter.type === 'peaking' && filter.q === Math.SQRT2)).toBe(
      true,
    )
    expect(filters.map((filter) => filter.frequencyHz)).toEqual([...EQUALIZER_BANDS_HZ])
    expect(filters[5]?.gainDb).toBe(4)
  })
})

describe('equalizerResponseDb', () => {
  it('gives one moved band its gain at its own frequency', () => {
    for (const [band, frequency] of EQUALIZER_BANDS_HZ.entries()) {
      const [response] = equalizerResponseDb(bandGains(band, 6), [frequency], RATE)
      expect(response).toBeCloseTo(6, 6)
    }
  })

  it('is flat for a flat setting', () => {
    expect(equalizerResponseDb(DEFAULT_EQUALIZER.gainsDb).every((value) => value === 0)).toBe(true)
  })

  it('matches what the filters do to a sine', () => {
    const gains = equalizerPreset('rock').gainsDb
    const [expected = 0] = equalizerResponseDb(gains, [3000], RATE)
    let signal: ArrayLike<number> = Float64Array.from({ length: RATE / 2 }, (_, index) =>
      Math.sin((2 * Math.PI * 3000 * index) / RATE),
    )
    const before = rms(signal)
    for (const filter of equalizerFilters(gains)) {
      signal = applyBiquad(biquadCoefficients(filter, RATE), signal)
    }
    expect(20 * Math.log10(rms(signal) / before)).toBeCloseTo(expected, 1)
  })
})

function rms(samples: ArrayLike<number>): number {
  let sum = 0
  const from = Math.floor(samples.length / 2)
  for (let index = from; index < samples.length; index++) sum += (samples[index] ?? 0) ** 2
  return Math.sqrt(sum / (samples.length - from))
}

describe('equalizerHeadroomDb', () => {
  it('is 0 when nothing is boosted', () => {
    expect(equalizerHeadroomDb(DEFAULT_EQUALIZER.gainsDb)).toBe(0)
    expect(equalizerHeadroomDb(equalizerPreset('bass-reducer').gainsDb)).toBe(0)
  })

  it('lowers the level by the highest point of the curve', () => {
    expect(equalizerHeadroomDb(bandGains(4, 6))).toBeCloseTo(-6, 1)
    // Neighbouring boosts add up between and around their bands.
    const bass = equalizerPreset('bass-boost').gainsDb
    const peak = Math.max(...equalizerResponseDb(bass, logFrequencies(512)))
    expect(peak).toBeGreaterThan(6)
    expect(equalizerHeadroomDb(bass)).toBeCloseTo(-peak, 1)
  })
})

describe('logFrequencies', () => {
  it('spaces frequencies evenly on a log scale', () => {
    const frequencies = logFrequencies(3, 20, 20_000)
    expect(frequencies[0]).toBeCloseTo(20, 9)
    expect(frequencies[1]).toBeCloseTo(632.46, 1)
    expect(frequencies[2]).toBeCloseTo(20_000, 6)
    expect(logFrequencies(1)).toEqual([20])
  })
})
