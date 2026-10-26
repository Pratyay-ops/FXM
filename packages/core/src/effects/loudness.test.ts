import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOUDNESS,
  dbToGain,
  gainToDb,
  LOUDNESS_TARGETS,
  type LoudnessSettings,
  loudnessFromR128,
  loudnessFromReplayGain,
  loudnessFromYouTube,
  loudnessGainDb,
  MAX_LOUDNESS_BOOST_DB,
  MAX_LOUDNESS_CUT_DB,
  parseR128GainDb,
  parseReplayGainDb,
  sanitizeLoudness,
  sanitizeStreamLoudness,
} from './loudness'

const ON: LoudnessSettings = { enabled: true, targetLufs: -14, mode: 'track' }
const BOOST = { boost: true }
const NO_BOOST = { boost: false }

describe('loudnessFromReplayGain', () => {
  it('turns gains to the -18 LUFS reference into loudness', () => {
    expect(
      loudnessFromReplayGain({
        trackGainDb: -7.89,
        trackPeak: 0.988525,
        albumGainDb: -8.5,
        albumPeak: 1.0,
      }),
    ).toEqual({
      trackLufs: -10.11,
      trackPeak: 0.988525,
      albumLufs: -9.5,
      albumPeak: 1,
      source: 'replaygain',
    })
  })

  it('needs a track gain, and drops implausible values', () => {
    expect(loudnessFromReplayGain({ albumGainDb: -3 })).toBeUndefined()
    expect(loudnessFromReplayGain({ trackGainDb: Number.NaN })).toBeUndefined()
    expect(loudnessFromReplayGain({ trackGainDb: 99 })).toBeUndefined()
    expect(loudnessFromReplayGain({ trackGainDb: 2, trackPeak: -1, albumPeak: 0.5 })).toEqual({
      trackLufs: -20,
      source: 'replaygain',
    })
  })
})

describe('parseReplayGainDb', () => {
  it('reads the values taggers write', () => {
    expect(parseReplayGainDb('-7.89 dB')).toBe(-7.89)
    expect(parseReplayGainDb('+1.20 dB')).toBe(1.2)
    expect(parseReplayGainDb('-3,5 db')).toBe(-3.5)
    expect(parseReplayGainDb(' 4 ')).toBe(4)
  })

  it('refuses anything else', () => {
    for (const value of ['', 'loud', '1e3 dB', '-7.89 LUFS', 12, null]) {
      expect(parseReplayGainDb(value)).toBeUndefined()
    }
  })
})

describe('R128 gains', () => {
  it('reads Q7.8 values', () => {
    expect(parseR128GainDb('-1280')).toBe(-5)
    expect(parseR128GainDb('+256')).toBe(1)
    expect(parseR128GainDb('0')).toBe(0)
    expect(parseR128GainDb('40000')).toBeUndefined()
    expect(parseR128GainDb('-5 dB')).toBeUndefined()
    expect(parseR128GainDb(-1280)).toBeUndefined()
  })

  it('turns gains to -23 LUFS into loudness, without a peak', () => {
    expect(loudnessFromR128({ trackGainDb: -5, albumGainDb: -4 })).toEqual({
      trackLufs: -18,
      albumLufs: -19,
      source: 'r128',
    })
    expect(loudnessFromR128({ albumGainDb: -4 })).toBeUndefined()
  })
})

describe('loudnessFromYouTube', () => {
  it('measures loudnessDb from -14 LUFS', () => {
    expect(loudnessFromYouTube(3.8900003)).toEqual({ trackLufs: -10.11, source: 'youtube' })
    expect(loudnessFromYouTube(-2.5)).toEqual({ trackLufs: -16.5, source: 'youtube' })
    expect(loudnessFromYouTube('3.9')).toBeUndefined()
    expect(loudnessFromYouTube(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('sanitizeStreamLoudness', () => {
  it('keeps known, plausible fields only', () => {
    expect(
      sanitizeStreamLoudness({
        trackLufs: -9.5,
        trackPeak: 0.9,
        albumLufs: -10,
        albumPeak: 'x',
        source: 'replaygain',
        extra: 1,
      }),
    ).toEqual({ trackLufs: -9.5, trackPeak: 0.9, albumLufs: -10, source: 'replaygain' })
  })

  it('refuses values without a source or a loudness', () => {
    expect(sanitizeStreamLoudness({ trackLufs: -9 })).toBeUndefined()
    expect(sanitizeStreamLoudness({ trackLufs: -900, source: 'youtube' })).toBeUndefined()
    expect(sanitizeStreamLoudness({ trackLufs: -9, source: 'loud' })).toBeUndefined()
    expect(sanitizeStreamLoudness(Object.create({ trackLufs: -9, source: 'youtube' }))).toBe(
      undefined,
    )
    expect(sanitizeStreamLoudness(null)).toBeUndefined()
  })
})

describe('sanitizeLoudness', () => {
  it('keeps a valid setting', () => {
    expect(sanitizeLoudness({ enabled: false, targetLufs: -18, mode: 'album' })).toEqual({
      enabled: false,
      targetLufs: -18,
      mode: 'album',
    })
  })

  it('takes only the offered targets, and defaults the rest', () => {
    expect(sanitizeLoudness({ targetLufs: -15, mode: 'loud', enabled: 1 })).toEqual(
      DEFAULT_LOUDNESS,
    )
    expect(LOUDNESS_TARGETS.map((target) => target.lufs)).toEqual([-14, -18, -23])
    expect(DEFAULT_LOUDNESS).toEqual({ enabled: true, targetLufs: -14, mode: 'track' })
  })
})

describe('loudnessGainDb', () => {
  const youtube = loudnessFromYouTube(3.89)

  it('turns a loud YouTube song down as YouTube does', () => {
    expect(loudnessGainDb(youtube, ON, NO_BOOST)).toBe(-3.89)
    expect(loudnessGainDb(youtube, ON, BOOST)).toBe(-3.89)
    expect(loudnessGainDb(youtube, { ...ON, targetLufs: -18 }, NO_BOOST)).toBe(-7.89)
  })

  it('never turns up a track without a peak', () => {
    const quiet = loudnessFromYouTube(-6)
    expect(loudnessGainDb(quiet, ON, BOOST)).toBe(0)
    expect(loudnessGainDb(loudnessFromR128({ trackGainDb: 5 }), ON, BOOST)).toBe(0)
  })

  it('turns up a quiet track only where it can boost, as far as its peak allows', () => {
    const quiet = loudnessFromReplayGain({ trackGainDb: 6, trackPeak: 0.5 })
    // At -24 LUFS it needs +10 dB, but its peak allows only 6.02 dB.
    expect(loudnessGainDb(quiet, ON, BOOST)).toBe(6.02)
    expect(loudnessGainDb(quiet, ON, NO_BOOST)).toBe(0)
    const roomy = loudnessFromReplayGain({ trackGainDb: 6, trackPeak: 0.1 })
    expect(loudnessGainDb(roomy, ON, BOOST)).toBe(10)
    const veryQuiet = loudnessFromReplayGain({ trackGainDb: 30, trackPeak: 0.01 })
    expect(loudnessGainDb(veryQuiet, ON, BOOST)).toBe(MAX_LOUDNESS_BOOST_DB)
    const clipping = loudnessFromReplayGain({ trackGainDb: 6, trackPeak: 1.2 })
    expect(loudnessGainDb(clipping, ON, BOOST)).toBe(0)
  })

  it('uses the album gain in album mode where known', () => {
    // The track at -10 LUFS, its album at -7.
    const tagged = loudnessFromReplayGain({
      trackGainDb: -8,
      trackPeak: 0.9,
      albumGainDb: -11,
      albumPeak: 1,
    })
    expect(loudnessGainDb(tagged, ON, BOOST)).toBe(-4)
    expect(loudnessGainDb(tagged, { ...ON, mode: 'album' }, BOOST)).toBe(-7)
    // Without an album gain, album mode uses the track's.
    expect(loudnessGainDb(youtube, { ...ON, mode: 'album' }, BOOST)).toBe(-3.89)
  })

  it('caps the cut, and is 0 when off or unknown', () => {
    const wild = loudnessFromYouTube(5.9)
    expect(loudnessGainDb(wild, { ...ON, targetLufs: -23 }, BOOST)).toBe(-14.9)
    expect(
      loudnessGainDb({ trackLufs: 6, source: 'replaygain' }, { ...ON, targetLufs: -23 }, BOOST),
    ).toBe(-29)
    expect(MAX_LOUDNESS_CUT_DB).toBe(30)
    expect(loudnessGainDb(youtube, { ...ON, enabled: false }, BOOST)).toBe(0)
    expect(loudnessGainDb(undefined, ON, BOOST)).toBe(0)
  })
})

describe('dbToGain and gainToDb', () => {
  it('convert between decibels and factors', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3)
    expect(dbToGain(20)).toBeCloseTo(10, 9)
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2)
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY)
  })
})
