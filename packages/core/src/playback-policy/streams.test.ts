import { describe, expect, it } from 'vitest'
import type { StreamOption } from '../providers'
import {
  choosePlaybackStream,
  type StreamChoice,
  type StreamSupport,
  streamsUsableUntil,
  URL_REFRESH_MARGIN_MS,
} from './streams'

function stream(name: string, overrides: Partial<StreamOption> = {}): StreamOption {
  return {
    url: `https://media.test/${name}`,
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    bitrateKbps: 150,
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength: 'verified',
    ...overrides,
  }
}

const opus251 = stream('251')
const aac140 = stream('140', { codec: 'aac', container: 'm4a', bitrateKbps: 130 })
const opus249 = stream('249', { bitrateKbps: 50, tier: 'low' })
const itag18 = stream('18', {
  codec: 'aac',
  container: 'mp4',
  media: 'muxed-video',
  bitrateKbps: 96,
  tier: 'normal',
})

const supports =
  (answers: Record<string, StreamSupport>, fallback: StreamSupport = 'probably') =>
  (option: StreamOption): StreamSupport =>
    answers[`${option.codec}/${option.container}`] ?? fallback

function choose(options: StreamOption[], choice: Partial<StreamChoice> = {}): string | undefined {
  const picked = choosePlaybackStream(options, {
    support: supports({}),
    ceiling: 'high',
    ...choice,
  })
  return picked?.url.replace('https://media.test/', '')
}

describe('choosePlaybackStream: format choice per canPlayType', () => {
  it('plays Opus 251 where the player is sure of it', () => {
    expect(choose([aac140, opus251])).toBe('251')
  })

  it('plays AAC 140 where the player only may play Opus', () => {
    const support = supports({ 'opus/webm': 'maybe' })
    expect(choose([opus251, aac140], { support })).toBe('140')
  })

  it('tries a stream the player only may play when nothing is sure', () => {
    expect(choose([opus251, aac140], { support: () => 'maybe' })).toBe('251')
  })

  it('never picks a stream the player cannot play, a capped one or an excluded one', () => {
    const support = supports({ 'opus/webm': 'no' })
    expect(choose([opus251], { support })).toBeUndefined()
    expect(choose([stream('cap', { fullLength: 'capped' }), aac140])).toBe('140')
    const exclude = (option: StreamOption) => option.url.endsWith('251')
    expect(choose([opus251, aac140], { exclude })).toBe('140')
    expect(choose([])).toBeUndefined()
  })

  it('applies the tier ceiling', () => {
    expect(choose([opus251, opus249], { ceiling: 'low' })).toBe('249')
    expect(choose([opus251, itag18], { ceiling: 'normal' })).toBe('18')
  })

  it('prefers audio only to a muxed video on mobile data, even of a lower tier', () => {
    expect(choose([opus249, itag18], { ceiling: 'normal' })).toBe('18')
    expect(choose([opus249, itag18], { ceiling: 'normal', preferAudioOnly: true })).toBe('249')
    expect(choose([itag18], { ceiling: 'normal', preferAudioOnly: true })).toBe('18')
  })
})

describe('streamsUsableUntil', () => {
  const limits = { marginMs: URL_REFRESH_MARGIN_MS, maxAgeMs: 3_600_000 }

  it('stops 10 minutes before the earliest expiry, however long that is', () => {
    expect(URL_REFRESH_MARGIN_MS).toBe(600_000)
    const options = [{ expiresAt: 21_600_000 }, { expiresAt: 21_000_000 }]
    expect(streamsUsableUntil(options, 0, limits)).toBe(20_400_000)
  })

  it('stops after the maximum age for options that never expire', () => {
    expect(streamsUsableUntil([{}], 1000, limits)).toBe(3_601_000)
    expect(streamsUsableUntil([], 1000, limits)).toBe(3_601_000)
    expect(streamsUsableUntil([{ expiresAt: 99_999_999_999 }, {}], 1000, limits)).toBe(3_601_000)
  })

  it('treats a non-finite expiry as expired', () => {
    expect(streamsUsableUntil([{ expiresAt: Number.NaN }], 1000, limits)).toBe(1000)
  })
})
