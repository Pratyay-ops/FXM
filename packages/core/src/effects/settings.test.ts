import { describe, expect, it } from 'vitest'
import { DEFAULT_EQUALIZER, equalizerPreset } from './equalizer'
import { DEFAULT_LOUDNESS } from './loudness'
import {
  clampCrossfadeMs,
  clampPlaybackRate,
  crossfadeGains,
  DEFAULT_AUDIO_EFFECTS,
  DEFAULT_CROSSFADE,
  MAX_CROSSFADE_MS,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  PLAYBACK_RATE_PRESETS,
  sanitizeAudioEffects,
  sanitizeCrossfade,
} from './settings'

describe('the defaults', () => {
  it('start with every effect off but loudness normalization', () => {
    expect(DEFAULT_AUDIO_EFFECTS).toEqual({
      equalizer: DEFAULT_EQUALIZER,
      loudness: DEFAULT_LOUDNESS,
      crossfade: { durationMs: 0, sameAlbum: false },
      playbackRate: 1,
    })
    expect(Object.isFrozen(DEFAULT_AUDIO_EFFECTS)).toBe(true)
  })
})

describe('clampCrossfadeMs', () => {
  it('clamps to 0–12 s in whole seconds', () => {
    expect(clampCrossfadeMs(4400)).toBe(4000)
    expect(clampCrossfadeMs(4600)).toBe(5000)
    expect(clampCrossfadeMs(60_000)).toBe(MAX_CROSSFADE_MS)
    expect(clampCrossfadeMs(-5)).toBe(0)
    expect(clampCrossfadeMs('6000')).toBe(0)
  })
})

describe('sanitizeCrossfade', () => {
  it('keeps valid values and defaults the rest', () => {
    expect(sanitizeCrossfade({ durationMs: 6000, sameAlbum: true })).toEqual({
      durationMs: 6000,
      sameAlbum: true,
    })
    expect(sanitizeCrossfade({ durationMs: 'long', sameAlbum: 'yes' })).toEqual(DEFAULT_CROSSFADE)
  })
})

describe('clampPlaybackRate', () => {
  it('clamps to 0.5–2 in steps of 0.05, normal speed for anything else', () => {
    expect(clampPlaybackRate(1.27)).toBe(1.25)
    expect(clampPlaybackRate(1.1)).toBe(1.1)
    expect(clampPlaybackRate(0.1)).toBe(MIN_PLAYBACK_RATE)
    expect(clampPlaybackRate(9)).toBe(MAX_PLAYBACK_RATE)
    expect(clampPlaybackRate(Number.NaN)).toBe(1)
    expect(clampPlaybackRate(undefined)).toBe(1)
    for (const rate of PLAYBACK_RATE_PRESETS) expect(clampPlaybackRate(rate)).toBe(rate)
  })
})

describe('sanitizeAudioEffects', () => {
  it('keeps a valid value', () => {
    const value = {
      equalizer: { enabled: true, gainsDb: [...equalizerPreset('pop').gainsDb], preset: 'pop' },
      loudness: { enabled: false, targetLufs: -18, mode: 'album' },
      crossfade: { durationMs: 8000, sameAlbum: false },
      playbackRate: 1.5,
    }
    expect(sanitizeAudioEffects(value)).toEqual(value)
  })

  it('validates each part on its own', () => {
    const effects = sanitizeAudioEffects({
      equalizer: 'broken',
      loudness: { enabled: false },
      crossfade: { durationMs: 3000 },
      playbackRate: 'fast',
    })
    expect(effects.equalizer).toEqual({
      ...DEFAULT_EQUALIZER,
      gainsDb: [...DEFAULT_EQUALIZER.gainsDb],
    })
    expect(effects.loudness).toEqual({ ...DEFAULT_LOUDNESS, enabled: false })
    expect(effects.crossfade).toEqual({ durationMs: 3000, sameAlbum: false })
    expect(effects.playbackRate).toBe(1)
    expect(sanitizeAudioEffects(42)).toEqual(sanitizeAudioEffects({}))
  })
})

describe('crossfadeGains', () => {
  it('fades with equal power', () => {
    expect(crossfadeGains(0)).toEqual({ out: 1, in: 0 })
    expect(crossfadeGains(1)).toEqual({ out: 0, in: 1 })
    const middle = crossfadeGains(0.5)
    expect(middle.out).toBeCloseTo(Math.SQRT1_2, 9)
    expect(middle.in).toBeCloseTo(Math.SQRT1_2, 9)
    for (const progress of [0.1, 0.33, 0.8]) {
      const gains = crossfadeGains(progress)
      expect(gains.out ** 2 + gains.in ** 2).toBeCloseTo(1, 9)
    }
  })

  it('clamps progress outside 0–1', () => {
    expect(crossfadeGains(-1)).toEqual({ out: 1, in: 0 })
    expect(crossfadeGains(3)).toEqual({ out: 0, in: 1 })
    expect(crossfadeGains(Number.NaN)).toEqual({ out: 0, in: 1 })
  })
})
