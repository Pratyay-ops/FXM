import type { AudioEffectsStatus } from '@fxm/player'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeGain,
  equalizerNote,
  formatBand,
  formatCrossfade,
  formatGain,
  formatRate,
  formatRemaining,
  loudnessNote,
  soundLabel,
} from './status'

const UNAVAILABLE: AudioEffectsStatus = {
  equalizer: 'unavailable',
  loudness: 'off',
  loudnessGainDb: 0,
}

afterEach(() => {
  vi.unstubAllEnvs()
})

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
    expect(equalizerNote(UNAVAILABLE, connect)).toBe(
      'Not available for this track: FXM can’t read audio from its source. It works on YouTube, local files, downloads and Internet Archive.',
    )
    const desktop = {
      platform: 'desktop',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote(UNAVAILABLE, desktop)).toMatch(/desktop app/)
    const android = {
      platform: 'android',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote(UNAVAILABLE, android)).toMatch(/Android app can’t read YouTube audio/)
  })

  it('tells an older FXM Connect to update when the read failed, as after a googlevideo redirect', () => {
    const failed: AudioEffectsStatus = { ...UNAVAILABLE, equalizerReason: 'read-failed' }
    const connect = {
      platform: 'web',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote(failed, { ...connect, connectVersion: '0.2.0' })).toBe(
      'Not available for this track: FXM Connect 0.2.0 couldn’t read its audio, which happens when YouTube moves a song to another server. Update FXM Connect to 0.2.1.',
    )
    // From 0.2.1 on (or a version that can't be read), the browser itself refused.
    for (const connectVersion of ['0.2.1', undefined]) {
      expect(
        equalizerNote(failed, {
          ...connect,
          ...(connectVersion === undefined ? {} : { connectVersion }),
        }),
      ).toBe(
        'Not available for this track: this browser didn’t let FXM Connect read its audio. It works on local files, downloads and Internet Archive.',
      )
    }
    const desktop = { ...connect, platform: 'desktop' } as const
    expect(equalizerNote(failed, desktop)).toBe(
      'Not available for this track: its audio couldn’t be read.',
    )
  })

  it('says the equalizer starts with the next tap where the browser holds Web Audio back', () => {
    const connect = {
      platform: 'web',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote({ ...UNAVAILABLE, equalizerReason: 'suspended' }, connect)).toBe(
      'The equalizer starts with your next tap or click in FXM, such as Play or Pause: until then the browser holds sound effects back.',
    )
    expect(equalizerNote({ ...UNAVAILABLE, equalizerReason: 'no-web-audio' }, connect)).toBe(
      'Not available here: this browser doesn’t let FXM process sound.',
    )
  })

  it('names the free sources this build offers, Jamendo only with its client_id', () => {
    const lite = {
      platform: 'web',
      capabilities: { youtube: 'simple', mediaBytes: false },
    } as const
    // The tests' build has none, as deployed until the owner sets one (lib/free-sources.ts).
    expect(equalizerNote(UNAVAILABLE, lite)).toBe(
      'Not available for this track: without FXM Connect, FXM can’t read YouTube audio. It works on local files, downloads and Internet Archive.',
    )
    const desktop = {
      platform: 'desktop',
      capabilities: { youtube: 'full', mediaBytes: true },
    } as const
    expect(equalizerNote(UNAVAILABLE, desktop)).toMatch(
      /It works on local files, downloads and Internet Archive\.$/,
    )

    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', 'public-id')

    expect(equalizerNote(UNAVAILABLE, lite)).toMatch(
      /It works on local files, downloads, Internet Archive and Jamendo\.$/,
    )
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

describe('soundLabel', () => {
  it('names the Sound button with what differs from normal', () => {
    expect(soundLabel({ rate: 1, equalizer: false, sleepTimer: false })).toBe('Sound')
    expect(soundLabel({ rate: 1.25, equalizer: true, sleepTimer: true })).toBe(
      'Sound: 1.25× speed, equalizer on, sleep timer on',
    )
    expect(soundLabel({ rate: 1, equalizer: false, sleepTimer: true })).toBe(
      'Sound: sleep timer on',
    )
  })
})
