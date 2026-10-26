import { describe, expect, it } from 'vitest'
import type { JsonRecord } from '../../json'
import type { StreamRungConfig } from '../config'
import { FAKE_USTREAMER_CONFIG, FIXTURE_HOST } from './fixtures/sanitize'
import { ADVANCED_FIXTURES, ADVANCED_STREAM_CONFIG } from './fixtures/testing'
import { SABR_PLAYBACK_FORMAT, sabrFormatOf, sabrStreamOptions } from './sabr'

const RUNG = ADVANCED_STREAM_CONFIG.rungs.find((rung) => rung.id === 'web-sabr') as StreamRungConfig
const ANSWER = ADVANCED_FIXTURES['web-sabr-song'] as JsonRecord
const URL_ = `https://${FIXTURE_HOST}/videoplayback?expire=1792985798&ip=192.0.2.1&sparams=expire%2Cip&sabr=1&n=transformed`
const NOW = Date.UTC(2026, 9, 26, 12)

describe('the SABR rung', () => {
  it('describes one session per audio format of the rung, in its order', () => {
    const options = sabrStreamOptions(ANSWER, {
      videoId: 'zFYEYRcjK2g',
      rung: RUNG,
      url: URL_,
      poToken: 'fxm-token',
      now: NOW,
    })
    expect(options.map((option) => [option.itag, option.codec, option.container])).toEqual([
      [251, 'opus', 'webm'],
      [140, 'aac', 'm4a'],
    ])
    const [opus] = options
    expect(opus).toMatchObject({
      url: URL_,
      protocol: 'sabr',
      media: 'audio',
      tier: 'high',
      fullLength: 'unverified',
      ipBound: true,
      expiresAt: 1_792_985_798_000,
      rung: 'web-sabr',
      videoId: 'zFYEYRcjK2g',
      label: 'Opus',
    })
    expect(opus?.playback).toMatchObject({
      format: SABR_PLAYBACK_FORMAT,
      videoId: 'zFYEYRcjK2g',
      ustreamerConfig: FAKE_USTREAMER_CONFIG,
      poToken: 'fxm-token',
      client: { nameId: 1, version: RUNG.client.version },
      durationMs: 239_000,
      audio: { itag: 251, lastModified: '1790437330874792', mimeType: 'audio/webm; codecs="opus"' },
    })
    const playback = opus?.playback as { video?: { mimeType: string } } | undefined
    expect(playback?.video?.mimeType.startsWith('video/')).toBe(true)
    expect(JSON.parse(JSON.stringify(opus?.playback))).toEqual(opus?.playback)
  })

  it('needs the ustreamer config, a known client and a googlevideo URL', () => {
    const session = { videoId: 'v', rung: RUNG, url: URL_, poToken: 't', now: NOW }
    const withoutConfig = { ...ANSWER, playerConfig: {} }
    expect(sabrStreamOptions(withoutConfig, session)).toEqual([])
    expect(sabrStreamOptions(ANSWER, { ...session, url: 'https://example.com/sabr' })).toEqual([])
    const otherClient = { ...RUNG, client: { ...RUNG.client, name: 'ANDROID' } }
    expect(sabrStreamOptions(ANSWER, { ...session, rung: otherClient })).toEqual([])
  })

  it('reads the formats SABR needs, and leaves out incomplete ones', () => {
    expect(
      sabrFormatOf({
        itag: 251,
        lastModified: '123',
        mimeType: 'audio/webm; codecs="opus"',
        bitrate: 140000,
        averageBitrate: 130000,
        approxDurationMs: '1000',
        audioTrack: { id: 'en.4' },
      }),
    ).toEqual({
      itag: 251,
      lastModified: '123',
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: 140000,
      averageBitrate: 130000,
      approxDurationMs: 1000,
      audioTrackId: 'en.4',
    })
    expect(
      sabrFormatOf({ itag: 251, mimeType: 'audio/webm', bitrate: 1, approxDurationMs: '1' }),
    ).toBeUndefined()
  })
})
