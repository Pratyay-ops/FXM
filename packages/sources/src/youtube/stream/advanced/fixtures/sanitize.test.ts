import { describe, expect, it } from 'vitest'
import { FIXTURE_HOST } from '../../fixtures/sanitize'
import {
  FAKE_SIGNATURE,
  FAKE_USTREAMER_CONFIG,
  sanitizeAdvancedResponse,
  sanitizeSignatureCipher,
} from './sanitize'
import { ADVANCED_FIXTURES } from './testing'

const RECORDED =
  'https://rr4---sn-abcd1234-xyz9.googlevideo.com/videoplayback?expire=1792983248&ei=AbCd&ip=2001%3Adb8%3A85a3%3A0%3A0%3A8a2e%3A370%3A7334&id=o-AbC&itag=251&source=youtube&mime=audio%2Fwebm&clen=4034850&c=TVHTML5&n=RealN123&sparams=expire%2Cei%2Cip&lsig=APaTx'

/** Every string in a value, deeply. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}

describe('the advanced fixture sanitizer', () => {
  it("scrubs a signatureCipher's URL and replaces its signature and n", () => {
    const cipher = new URLSearchParams(
      sanitizeSignatureCipher(
        new URLSearchParams({ s: 'RealScrambledSignature', sp: 'sig', url: RECORDED }).toString(),
        251,
      ),
    )
    expect(cipher.get('s')).toBe(FAKE_SIGNATURE)
    expect(cipher.get('sp')).toBe('sig')
    const url = new URL(cipher.get('url') ?? '')
    expect(url.hostname).toBe(FIXTURE_HOST)
    expect(url.searchParams.get('ip')).toBe('192.0.2.1')
    expect(url.searchParams.get('n')).toBe('fxm-n-251')
    expect(url.searchParams.get('lsig')).toBe('fxm')
    expect(url.searchParams.get('clen')).toBe('4034850')
  })

  it('keeps the SABR URL and ustreamer config, scrubbed', () => {
    const clean = sanitizeAdvancedResponse({
      playabilityStatus: { status: 'OK' },
      streamingData: { adaptiveFormats: [], serverAbrStreamingUrl: `${RECORDED}&sabr=1` },
      playerConfig: {
        audioConfig: {},
        mediaCommonConfig: {
          mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: 'Real' },
        },
      },
    }) as {
      streamingData: { serverAbrStreamingUrl: string }
      playerConfig: unknown
    }
    const url = new URL(clean.streamingData.serverAbrStreamingUrl)
    expect([url.hostname, url.searchParams.get('sabr'), url.searchParams.get('n')]).toEqual([
      FIXTURE_HOST,
      '1',
      'fxm-n-sabr',
    ])
    expect(clean.playerConfig).toEqual({
      mediaCommonConfig: {
        mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: FAKE_USTREAMER_CONFIG },
      },
    })
  })

  it('left nothing of the recording machine in the fixtures', () => {
    for (const [name, fixture] of Object.entries(ADVANCED_FIXTURES)) {
      for (const text of strings(fixture)) {
        for (const url of text.match(/https?:\/\/[^\s"&]+googlevideo\.com/gu) ?? []) {
          expect(url, name).toContain(FIXTURE_HOST)
        }
        expect(text, name).not.toMatch(
          /(?<![\d.])(?!192\.0\.2\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/u,
        )
        expect(text, name).not.toMatch(/visitorData/u)
      }
      for (const text of strings(fixture).filter((value) => value.includes('sp=sig'))) {
        expect(new URLSearchParams(text).get('s'), name).toBe(FAKE_SIGNATURE)
      }
    }
  })
})
