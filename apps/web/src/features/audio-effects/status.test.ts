import type { AudioEffectsStatus } from '@fxm/player'
import { describe, expect, it } from 'vitest'
import {
  describeGain,
  equalizerNote,
  formatBand,
  formatCrossfade,
  formatGain,
  formatRate,
  formatRemaining,
  loudnessNote,
} from './status'

const UNAVAILABLE: AudioEffectsStatus = {
  equalizer: 'unavailable',
  loudness: 'off',
  loudnessGainDb: 0,
}

describe('equalizerNote', () => {
  it('says why the equalizer can’t process the track, by where FXM runs', () => {
    const lite = {
      platform: 'web',
      capabilities: { youtube: 'simple', mediaBytes: false },
    } as const
    expect(equalizerNote(UNAVAILABLE, lite)).toMatch(/without FXM Connect/)
    const connect = {
      platform: 'web',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote(UNAVAILABLE, connect)).toMatch(/moved to another server/)
    const desktop = {
      platform: 'desktop',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote(UNAVAILABLE, desktop)).toMatch(/desktop app/)
    const android = {
      platform: 'android',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote(UNAVAILABLE, android)).toBe('Not available for this track here.')
  })

  it('says nothing while it works or is off', () => {
    const context = {
      platform: 'web',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote({ ...UNAVAILABLE, equalizer: 'on' }, context)).toBeUndefined()
    expect(equalizerNote({ ...UNAVAILABLE, equalizer: 'off' }, context)).toBeUndefined()
  })
})

describe('loudnessNote', () => {
  it('says how loud the track plays', () => {
    expect(loudnessNote({ ...UNAVAILABLE, loudness: 'on', loudnessGainDb: -3.89 })).toBe(
      'This track plays 3.9 dB quieter.',
    )
    expect(loudnessNote({ ...UNAVAILABLE, loudness: 'on', loudnessGainDb: 2 })).toBe(
      'This track plays 2 dB louder.',
    )
    expect(loudnessNote({ ...UNAVAILABLE, loudness: 'on', loudnessGainDb: 0 })).toBe(
      'This track plays at its own level.',
    )
    expect(loudnessNote({ ...UNAVAILABLE, loudness: 'no-data' })).toMatch(/doesn’t say/)
    expect(loudnessNote({ ...UNAVAILABLE, loudness: 'unavailable' })).toMatch(/doesn’t let FXM/)
    expect(loudnessNote(UNAVAILABLE)).toBeUndefined()
  })
})

describe('formatting', () => {
  it('formats gains, speeds, lengths, bands and remaining time', () => {
    expect(describeGain(-0.04)).toBe('at its own level')
    expect(formatRate(1.25)).toBe('1.25×')
    expect(formatRate(1)).toBe('1×')
    expect(formatCrossfade(0)).toBe('Off')
    expect(formatCrossfade(6000)).toBe('6 s')
    expect(formatBand(31)).toBe('31 Hz')
    expect(formatBand(16000)).toBe('16 kHz')
    expect(formatGain(2.5)).toBe('+2.5 dB')
    expect(formatGain(-3)).toBe('−3 dB')
    expect(formatGain(0)).toBe('0 dB')
    expect(formatRemaining(61_200)).toBe('1:02')
    expect(formatRemaining(3_725_000)).toBe('1:02:05')
    expect(formatRemaining(-5)).toBe('0:00')
  })
})
