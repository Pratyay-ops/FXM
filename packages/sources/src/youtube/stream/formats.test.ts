import type { StreamOption } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { JsonRecord } from '../json'
import { BUNDLED_STREAM_CONFIG, type StreamRungConfig } from './config'
import { PLAYER_FIXTURES, VIDEOS } from './fixtures/testing'
import { isYouTubeStreamOption, kindOfMimeType, parseStreamUrl, streamOptionsOf } from './formats'

type Json = { [key: string]: unknown }

const [VISIONOS, , , MUXED] = BUNDLED_STREAM_CONFIG.rungs as [
  StreamRungConfig,
  StreamRungConfig,
  StreamRungConfig,
  StreamRungConfig,
]
const NOW = Date.UTC(2026, 9, 26)

function options(response: unknown, rung = VISIONOS, videoId: string = VIDEOS.song) {
  return streamOptionsOf(response as JsonRecord, videoId, rung, BUNDLED_STREAM_CONFIG, NOW)
}

/** The VISIONOS fixture with its adaptive formats changed by `change`. */
function withFormats(change: (formats: Json[]) => Json[]): unknown {
  const copy = structuredClone(PLAYER_FIXTURES['visionos-song']) as Json
  const streaming = copy.streamingData as Json
  streaming.adaptiveFormats = change(streaming.adaptiveFormats as Json[])
  return copy
}

describe('stream options from a /player response', () => {
  it("reports every VISIONOS audio format in the rung's order, with all it knows", () => {
    const found = options(PLAYER_FIXTURES['visionos-song'])
    expect(found.map((option) => option.itag)).toEqual([251, 140, 250, 249, 139])
    const [opus, aac] = found
    expect(opus).toEqual({
      url: expect.stringMatching(
        /^https:\/\/rr1---sn-fxmfixture\.googlevideo\.com\/videoplayback\?/,
      ),
      codec: 'opus',
      container: 'webm',
      media: 'audio',
      bitrateKbps: 135.2,
      sampleRateHz: 48_000,
      tier: 'high',
      protocol: 'progressive',
      expiresAt: 1_792_979_495_000,
      ipBound: true,
      fullLength: 'unverified',
      videoId: VIDEOS.song,
      rung: 'visionos',
      itag: 251,
      label: 'Opus',
      contentLength: 4_034_850,
    })
    expect(aac).toMatchObject({
      label: 'AAC',
      codec: 'aac',
      container: 'm4a',
      media: 'audio',
      bitrateKbps: 129.6,
      sampleRateHz: 44_100,
      tier: 'high',
      contentLength: 3_865_089,
    })
    expect(found.slice(2).map((option) => [option.itag, option.bitrateKbps, option.tier])).toEqual([
      [250, 68.5, 'normal'],
      [249, 51.6, 'low'],
      [139, 48.9, 'low'],
    ])
  })

  it('takes the tier from the nominal bitrate, so a quiet Opus 251 stays high', () => {
    // The made-for-kids video's Opus 251 averages 111.7 kbps against a nominal 149 kbps.
    const kids = PLAYER_FIXTURES['android-kids'] as Json
    const opus = structuredClone((kids.streamingData as Json).adaptiveFormats as Json[]).find(
      (format) => format.itag === 251,
    ) as Json
    const url = (
      (PLAYER_FIXTURES['visionos-song'].streamingData.adaptiveFormats as Json[]).find(
        (format) => format.itag === 251,
      ) as Json
    ).url
    const found = options(withFormats(() => [{ ...opus, url }]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ itag: 251, bitrateKbps: 111.7, tier: 'high' })
  })

  it("reports itag 18 as a muxed video whose AAC track's bitrate comes from the config", () => {
    const [muxed, ...rest] = options(PLAYER_FIXTURES['android-song'], MUXED)
    expect(rest).toEqual([])
    expect(muxed).toMatchObject({
      codec: 'aac',
      container: 'mp4',
      media: 'muxed-video',
      bitrateKbps: 128,
      tier: 'high',
      sampleRateHz: 44_100,
      ipBound: true,
      fullLength: 'unverified',
      rung: 'android-muxed',
      itag: 18,
      label: 'AAC from 360p video',
      expiresAt: 1_792_979_495_000,
    })
    expect(muxed?.contentLength).toBeUndefined()
    const unknown = { ...BUNDLED_STREAM_CONFIG, muxedAudioKbps: {} }
    const [plain] = streamOptionsOf(
      PLAYER_FIXTURES['android-song'] as JsonRecord,
      VIDEOS.song,
      MUXED,
      unknown,
      NOW,
    )
    expect(plain?.bitrateKbps).toBeUndefined()
    expect(plain?.tier).toBe('normal')
    const unlabelled = structuredClone(PLAYER_FIXTURES['android-song']) as Json
    delete ((unlabelled.streamingData as Json).formats as Json[])[0]?.qualityLabel
    expect(options(unlabelled, MUXED)[0]?.label).toBe('AAC from video')
  })

  it("finds nothing where a rung's formats have no direct URL", () => {
    // ANDROID's adaptive formats are SABR-only: they carry no URL.
    expect(options(PLAYER_FIXTURES['android-song'], VISIONOS)).toEqual([])
    expect(options({ playabilityStatus: { status: 'OK' } })).toEqual([])
  })

  it('skips dubbed, descriptive and compressed copies, and keeps the original audio', () => {
    const found = options(
      withFormats((formats) => {
        const opus = formats.find((format) => format.itag === 251) as Json
        return [
          { ...opus, isDrc: true, averageBitrate: 1 },
          { ...opus, audioTrack: { id: 'es.3', audioIsDefault: false }, averageBitrate: 2 },
          // xtags are a base64 protobuf of key and value pairs: here acont = dubbed.
          { ...opus, xtags: 'Cg8KBWFjb250EgZkdWJiZWQ', averageBitrate: 3 },
          { ...opus, xtags: 'acont=dubbed-auto', averageBitrate: 4 },
          { ...opus, audioTrack: { id: 'en.4', audioIsDefault: true } },
        ]
      }),
    )
    expect(found.map((option) => option.bitrateKbps)).toEqual([135.2])
  })

  it('never takes a URL outside googlevideo, or a format FXM cannot play', () => {
    const found = options(
      withFormats((formats) =>
        formats.map((format) => {
          if (format.itag === 251) return { ...format, url: 'https://evil.example/videoplayback' }
          if (format.itag === 140) return { ...format, url: 'http://rr1.googlevideo.com/x' }
          if (format.itag === 250) return { ...format, mimeType: 'audio/mp4; codecs="ec-3"' }
          if (format.itag === 249) return { ...format, url: 42 }
          return format
        }),
      ),
    )
    expect(found.map((option) => option.itag)).toEqual([139])
  })

  it('falls back to expiresInSeconds, and says when a URL is not bound to an IP address', () => {
    const found = options(
      withFormats((formats) =>
        formats.map((format) => {
          const url = new URL(String(format.url))
          url.searchParams.delete('expire')
          url.searchParams.delete('ip')
          url.searchParams.set('sparams', 'itag,source')
          return { ...format, url: url.href }
        }),
      ),
    )
    expect(found[0]?.expiresAt).toBe(NOW + 21_540_000)
    expect(found[0]?.ipBound).toBe(false)
  })

  it('tells options from the ladder apart', () => {
    const [option] = options(PLAYER_FIXTURES['visionos-song'])
    expect(option && isYouTubeStreamOption(option)).toBe(true)
    const plain: StreamOption = {
      url: 'https://archive.org/x.flac',
      codec: 'flac',
      container: 'flac',
      media: 'audio',
      tier: 'lossless',
      protocol: 'progressive',
      ipBound: false,
      fullLength: 'unverified',
    }
    expect(isYouTubeStreamOption(plain)).toBe(false)
  })
})

describe('reading formats', () => {
  it.each([
    ['audio/webm; codecs="opus"', { codec: 'opus', container: 'webm', media: 'audio' }],
    ['audio/mp4; codecs="mp4a.40.2"', { codec: 'aac', container: 'm4a', media: 'audio' }],
    ['audio/mp4; codecs="mp4a.40.5"', { codec: 'aac', container: 'm4a', media: 'audio' }],
    [
      'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      { codec: 'aac', container: 'mp4', media: 'muxed-video' },
    ],
    ['audio/webm; codecs="vorbis"', { codec: 'vorbis', container: 'webm', media: 'audio' }],
    ['video/mp4; codecs="avc1.640028"', undefined],
    ['video/webm; codecs="vp9"', undefined],
    ['audio/mp4; codecs="ac-3"', undefined],
    ['text/plain', undefined],
  ])('%s', (mimeType, kind) => {
    expect(kindOfMimeType(mimeType)).toEqual(kind)
  })

  it('accepts only HTTPS googlevideo URLs without credentials', () => {
    expect(parseStreamUrl('https://rr3---sn-x.googlevideo.com/videoplayback?itag=18')).toBeDefined()
    expect(parseStreamUrl('https://googlevideo.com/videoplayback')).toBeUndefined()
    expect(parseStreamUrl('https://x.googlevideo.com.evil.example/')).toBeUndefined()
    expect(parseStreamUrl('https://user:pass@rr1.googlevideo.com/')).toBeUndefined()
    expect(parseStreamUrl('not a url')).toBeUndefined()
    expect(parseStreamUrl(undefined)).toBeUndefined()
  })
})
