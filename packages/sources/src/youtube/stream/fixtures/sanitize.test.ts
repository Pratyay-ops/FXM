import { describe, expect, it } from 'vitest'
import { FAKE_VISITOR_DATA } from '../../fixtures/sanitize'
import { FIXTURE_HOST, PLACEHOLDER, sanitizePlayerResponse, sanitizeStreamUrl } from './sanitize'
import { PLAYER_FIXTURES, PROBE_FIXTURES } from './testing'

const RECORDED =
  'https://rr4---sn-abcd1234-xyz9.googlevideo.com/videoplayback?expire=1792979495&ei=AbCd&ip=2001%3Adb8%3A85a3%3A0%3A0%3A8a2e%3A370%3A7334&id=o-AbC&itag=251&source=youtube&requiressl=yes&mh=Xy&mn=sn-abcd1234-xyz9%2Csn-abcd1234-xyz8&ms=au%2Crdu&mv=m&mvi=4&pl=48&initcwndbps=1234567&mime=audio%2Fwebm&clen=4034850&dur=238.661&lmt=1790437330874792&c=VISIONOS&sparams=expire%2Cei%2Cip%2Cid%2Citag&sig=AJfQdSs&lsparams=mh%2Cmm%2Cmn&lsig=APaTx'

describe('the stream fixture sanitizer', () => {
  it("replaces a URL's host, IP address, signatures and session values", () => {
    const url = new URL(sanitizeStreamUrl(RECORDED))
    expect(url.hostname).toBe(FIXTURE_HOST)
    expect(url.pathname).toBe('/videoplayback')
    expect(url.searchParams.get('ip')).toBe('192.0.2.1')
    for (const name of ['ei', 'id', 'mh', 'mn', 'ms', 'mv', 'mvi', 'pl', 'initcwndbps']) {
      expect(url.searchParams.get(name), name).toBe(PLACEHOLDER)
    }
    expect(url.searchParams.get('sig')).toBe(PLACEHOLDER)
    expect(url.searchParams.get('lsig')).toBe(PLACEHOLDER)
    expect(
      Object.fromEntries(
        ['expire', 'itag', 'clen', 'dur', 'c', 'mime'].map((name) => [
          name,
          url.searchParams.get(name),
        ]),
      ),
    ).toEqual({
      expire: '1792979495',
      itag: '251',
      clen: '4034850',
      dur: '238.661',
      c: 'VISIONOS',
      mime: 'audio/webm',
    })
    expect(sanitizeStreamUrl('not a url')).toBe('not a url')
  })

  it('keeps only what the resolver reads', () => {
    const clean = sanitizePlayerResponse({
      responseContext: { visitorData: 'CgtSZWFsVmlzaXRvcg', serviceTrackingParams: [] },
      playabilityStatus: { status: 'OK', contextParams: 'Q0FF', miniplayer: {} },
      streamingData: {
        expiresInSeconds: '21540',
        adaptiveFormats: [
          { itag: 137, url: RECORDED, mimeType: 'video/mp4; codecs="avc1"' },
          { itag: 248, url: RECORDED, mimeType: 'video/webm; codecs="vp9"' },
          { itag: 136, url: RECORDED, mimeType: 'video/mp4; codecs="avc1"' },
          { itag: 251, url: RECORDED, mimeType: 'audio/webm; codecs="opus"', indexRange: {} },
        ],
        hlsManifestUrl: 'https://manifest.googlevideo.com/api/manifest/hls_variant/ip/1.2.3.4',
        serverAbrStreamingUrl: RECORDED,
      },
      videoDetails: { videoId: 'zFYEYRcjK2g', keywords: ['x'], viewCount: '1', thumbnail: {} },
      playbackTracking: { videostatsPlaybackUrl: { baseUrl: RECORDED } },
      playerConfig: {},
      storyboards: {},
      attestation: {},
      trackingParams: 'CAAQ',
    }) as Record<string, Record<string, unknown>>
    expect(Object.keys(clean)).toEqual([
      'responseContext',
      'playabilityStatus',
      'streamingData',
      'videoDetails',
    ])
    expect(clean.responseContext).toEqual({ visitorData: FAKE_VISITOR_DATA })
    expect(clean.playabilityStatus).toEqual({ status: 'OK' })
    expect(clean.videoDetails).toEqual({ videoId: 'zFYEYRcjK2g' })
    const formats = clean.streamingData?.adaptiveFormats as { itag: number; url: string }[]
    expect(formats.map((format) => format.itag)).toEqual([251, 137, 248])
    expect(formats.every((format) => new URL(format.url).hostname === FIXTURE_HOST)).toBe(true)
    expect(clean.streamingData?.hlsManifestUrl).not.toContain('1.2.3.4')
    expect(clean.streamingData?.serverAbrStreamingUrl).toBe(
      `https://${FIXTURE_HOST}/videoplayback?fxm=sabr`,
    )
  })

  it("keeps a scheduled stream's start and main text, not its local start time", () => {
    const slate = {
      scheduledStartTime: '1793270700',
      mainText: { runs: [{ text: 'Live in ' }, { text: '3 days' }] },
      subtitleText: { runs: [{ text: 'October 29 at 6:45 AM GMT-4' }] },
      thumbnail: { thumbnails: [] },
    }
    const clean = sanitizePlayerResponse({
      playabilityStatus: {
        status: 'LIVE_STREAM_OFFLINE',
        liveStreamability: {
          liveStreamabilityRenderer: {
            videoId: 'hv867HnY4j4',
            offlineSlate: { liveStreamOfflineSlateRenderer: slate },
          },
        },
      },
    })
    expect(JSON.stringify(clean)).not.toContain('GMT')
    expect(clean).toMatchObject({
      playabilityStatus: {
        liveStreamability: {
          liveStreamabilityRenderer: {
            offlineSlate: {
              liveStreamOfflineSlateRenderer: {
                scheduledStartTime: '1793270700',
                mainText: slate.mainText,
              },
            },
          },
        },
      },
    })
  })
})

describe('the recorded stream fixtures', () => {
  const entries = Object.entries({ ...PLAYER_FIXTURES, probes: PROBE_FIXTURES }).map(
    ([name, json]) => [name, JSON.stringify(json)] as const,
  )

  it('are all there', () => {
    expect(entries).toHaveLength(12)
  })

  it.each(entries)(
    '%s holds no address, session, signature, time zone or nearby host',
    (_name, text) => {
      expect(text).not.toMatch(/\b(?!192\.0\.2\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/u)
      // A local time names the recording machine's time zone, and so roughly where it is.
      expect(text).not.toMatch(/(?:GMT|UTC)[+-]\d/u)
      expect(text).not.toMatch(/(?:[0-9a-f]{1,4}(?::|%3A)){3,7}[0-9a-f]{1,4}/iu)
      expect(text).not.toMatch(/"(?:trackingParams|clickTrackingParams|contextParams)"/u)
      for (const match of text.matchAll(/"visitorData":"([^"]*)"/gu)) {
        expect(match[1]).toBe(FAKE_VISITOR_DATA)
      }
      for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+\.googlevideo\.com)/gu)) {
        expect(['manifest.googlevideo.com', FIXTURE_HOST]).toContain(match[1])
      }
      for (const match of text.matchAll(/[?&](sig|lsig|ei|id|mn|mvi|n|pot)=([^&"]*)/gu)) {
        expect(match[2], match[1]).toBe(PLACEHOLDER)
      }
    },
  )
})
