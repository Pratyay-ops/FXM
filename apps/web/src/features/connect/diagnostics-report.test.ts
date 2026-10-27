import { describe, expect, it } from 'vitest'
import type { AudioCheckState } from './audio-check'
import {
  browserLabel,
  type DiagnosticsReportInput,
  diagnosticsReport,
  type ReportNavigator,
  redactReport,
  systemLabel,
} from './diagnostics-report'
import type { SelfTestAttempt, SelfTestReport } from './self-test'
import { CONNECT_STATUS, readyConnection, TIER_CAPABILITIES, USER_AGENTS } from './testing'

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68'

const edge: ReportNavigator = {
  userAgent: EDGE_UA,
  userAgentData: {
    brands: [
      { brand: 'Not?A_Brand', version: '99' },
      { brand: 'Chromium', version: '130' },
      { brand: 'Microsoft Edge', version: '130' },
    ],
    platform: 'Windows',
  },
}

describe('browserLabel', () => {
  it("names the browser from Client Hints' brands, skipping the made-up ones", () => {
    expect(browserLabel(edge)).toBe('Microsoft Edge 130')
    expect(
      browserLabel({
        userAgent: USER_AGENTS.chromeWindows,
        userAgentData: {
          brands: [
            { brand: 'Google Chrome', version: '156' },
            { brand: 'Not.A/Brand', version: '8' },
            { brand: 'Chromium', version: '156' },
          ],
        },
      }),
    ).toBe('Google Chrome 156')
    expect(
      browserLabel({
        userAgent: '',
        userAgentData: { brands: [{ brand: 'Chromium', version: '130' }] },
      }),
    ).toBe('Chromium 130')
    expect(
      browserLabel({
        userAgent: '',
        brave: {},
        userAgentData: { brands: [{ brand: 'Chromium', version: '130' }] },
      }),
    ).toBe('Brave 130')
  })

  it('falls back to the User-Agent string, with the major version only', () => {
    expect(browserLabel({ userAgent: EDGE_UA })).toBe('Microsoft Edge 130')
    expect(browserLabel({ userAgent: USER_AGENTS.chromeWindows })).toBe('Chrome 156')
    expect(browserLabel({ userAgent: USER_AGENTS.androidChrome })).toBe('Chrome 156')
    expect(browserLabel({ userAgent: USER_AGENTS.firefoxLinux })).toBe('Firefox 158')
    expect(browserLabel({ userAgent: USER_AGENTS.safariMac })).toBe('Safari 19.0')
    expect(browserLabel({ userAgent: USER_AGENTS.iphone })).toBe('Safari 19.0')
    expect(browserLabel({ userAgent: 'curl/8.0' })).toBe('Unknown')
    // Client Hints without brands, as some browsers give them.
    expect(browserLabel({ userAgent: USER_AGENTS.firefoxLinux, userAgentData: {} })).toBe(
      'Firefox 158',
    )
  })
})

describe('systemLabel', () => {
  it('names the system without its version', () => {
    expect(systemLabel(edge)).toBe('Windows')
    expect(systemLabel({ userAgent: USER_AGENTS.safariMac })).toBe('macOS')
    expect(systemLabel({ userAgent: USER_AGENTS.firefoxLinux })).toBe('Linux')
    expect(systemLabel({ userAgent: USER_AGENTS.androidChrome })).toBe('Android')
    expect(systemLabel({ userAgent: USER_AGENTS.iphone })).toBe('iOS or iPadOS')
  })
})

// What a real stream URL carries, none of which may reach the report.
const IP = '203.0.113.7'
const IPV6 = '2001:db8:85a3::8a2e:370:7334'
const SIGNATURE = 'AOq0QJ8wRQIhAKz3eXsSignatureValueThatIsLong0123456789'
const STREAM_URL = `https://rr3---sn-fake1.googlevideo.com/videoplayback?expire=1767225600&ei=abc&ip=${IP}&id=o-AbCdEf&itag=251&source=youtube&requiressl=yes&pot=TOKEN-${SIGNATURE}&sig=${SIGNATURE}&lsig=${SIGNATURE}`

const SONG = { videoId: 'zFYEYRcjK2g', title: 'Creep', artist: 'Radiohead' }

const attempt: SelfTestAttempt = {
  label: 'Opus · 135 kbps · VISIONOS',
  rungs: 'all',
  option: {
    url: STREAM_URL,
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    bitrateKbps: 135,
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength: 'verified',
  },
  result: { ok: true, startedAfterMs: 420, playedMs: 3000 },
}

const played: SelfTestReport = {
  status: 'passed',
  song: SONG,
  resolveMs: 1200,
  attempts: [attempt],
  played: attempt,
}

const full = readyConnection({
  capabilities: TIER_CAPABILITIES.full,
  connect: { ...CONNECT_STATUS.present, version: '0.2.0' },
  lite: 'not-needed',
  budget: {
    hourlyLimit: 600,
    used: 4,
    remaining: 596,
    pauseLevel: 0,
    waitingBulk: 0,
  },
})

function input(overrides: Partial<DiagnosticsReportInput> = {}): DiagnosticsReportInput {
  return {
    appVersion: '0.2.0',
    state: full,
    navigator: edge,
    selfTest: { report: played, running: false },
    audio: { phase: 'done', result: { kind: 'refused', host: 'rr3---sn-fake1.googlevideo.com' } },
    ...overrides,
  }
}

describe('diagnosticsReport', () => {
  it('lists the version, the platform, the browser, the tier, FXM Connect and each check', () => {
    expect(diagnosticsReport(input()).split('\n')).toEqual([
      'FXM diagnostics',
      'App version: 0.2.0',
      'Platform: Web app, in a browser',
      'System: Windows',
      'Browser: Microsoft Edge 130',
      'Tier: Full',
      'FXM Connect: Version 0.2.0, on',
      'FXM Connect features: youtube, googlevideo, spotify, lastfm, spotify-server-time',
      'Lite self-test: Not needed: FXM Connect gives full access',
      expect.stringMatching(/^YouTube: .+/),
      expect.stringMatching(/^Spotify: .+/),
      'YouTube requests: 4 of 600 in the last hour',
      'Song self-test: Played 3.0 s of Opus · 135 kbps · VISIONOS. Resolving took 1.2 s, and playback started 0.4 s later.',
      "YouTube audio: Refused (CORS). YouTube's audio server answered, but the browser wouldn't let FXM Connect read the audio, so YouTube downloads and the equalizer don't work. Update FXM Connect to the latest version.",
      'YouTube audio server: rr3---sn-fake1.googlevideo.com',
      '',
    ])
  })

  it('says where a readable redirect led, and what was not run or not tested', () => {
    const redirected = diagnosticsReport(
      input({
        audio: {
          phase: 'done',
          result: {
            kind: 'readable',
            host: 'rr3---sn-fake1.googlevideo.com',
            redirectedTo: 'rr5---sn-fake2.googlevideo.com',
          },
        },
      }),
    )
    expect(redirected).toContain(
      'YouTube audio server: rr3---sn-fake1.googlevideo.com, redirected to rr5---sn-fake2.googlevideo.com\n',
    )

    const notRun = diagnosticsReport(
      input({ selfTest: { report: undefined, running: false }, audio: { phase: 'idle' } }),
    )
    expect(notRun).toContain('Song self-test: Not run\n')
    expect(notRun).toContain('YouTube audio: Not run (it runs after the song self-test)\n')
    expect(notRun).not.toContain('YouTube audio server')

    const lite = diagnosticsReport(
      input({
        state: readyConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' }),
        audio: { phase: 'idle' },
      }),
    )
    expect(lite).toContain('Tier: Lite\n')
    expect(lite).toContain('FXM Connect: Not installed\n')
    expect(lite).toContain('FXM Connect features: None\n')
    expect(lite).toContain(
      "YouTube audio: Not tested. In Lite, YouTube songs play, but this browser can't read their audio, so YouTube downloads and the equalizer aren't available here.\n",
    )
  })

  it('never copies URLs, query strings, signatures, IP addresses, tokens or cookies', () => {
    // A real cookie on the page, which the report must not pick up either.
    // biome-ignore lint/suspicious/noDocumentCookie: the test needs a cookie on the page.
    document.cookie = 'SID=cookie-secret-value; path=/'
    // Everything that could carry them, filled with them.
    const leaky: AudioCheckState = {
      phase: 'done',
      result: { kind: 'readable', host: IP, redirectedTo: `${IPV6}` },
    }
    const failed: SelfTestReport = {
      status: 'failed',
      song: SONG,
      stage: 'play',
      attempts: [
        {
          label: `Stream at ${STREAM_URL}`,
          rungs: 'all',
          option: attempt.option,
          result: {
            ok: false,
            reason: 'media-error',
            afterMs: 80,
            playedMs: 0,
            detail: `from ${IP} and ${IPV6}, token=${SIGNATURE} Cookie: SID=cookie-secret-value`,
          },
        },
      ],
    }
    const reports = [
      diagnosticsReport(input()),
      diagnosticsReport(
        input({
          state: readyConnection({
            ...full,
            connect: {
              state: 'present',
              version: `0.2.0?sig=${SIGNATURE}`,
              features: ['youtube', `https://evil.example/?ip=${IP}`, 'googlevideo'],
            },
          }),
          navigator: { userAgent: `${EDGE_UA} ${STREAM_URL}` },
          selfTest: { report: failed, running: false },
          audio: leaky,
        }),
      ),
    ]
    for (const report of reports) {
      for (const secret of [
        'http',
        '://',
        'videoplayback',
        '?',
        '&',
        '=',
        IP,
        IPV6,
        '2001:db8',
        SIGNATURE,
        'sig',
        'expire',
        'TOKEN',
        'token=',
        'cookie-secret-value',
        'SID',
        EDGE_UA,
        'Win64',
      ]) {
        expect(report).not.toContain(secret)
      }
      expect(report).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
    }
    // The only server it names is googlevideo's, by host name.
    expect(reports[0]).toContain('YouTube audio server: rr3---sn-fake1.googlevideo.com')
    expect(reports[1]).not.toContain('YouTube audio server')
    expect(reports[1]).toContain('FXM Connect features: youtube, googlevideo')
    // biome-ignore lint/suspicious/noDocumentCookie: removes the test's cookie.
    document.cookie = 'SID=; path=/; max-age=0'
  })
})

describe('redactReport', () => {
  it('removes what looks like a URL, a query, an IP address, a token or a cookie', () => {
    expect(redactReport(`see ${STREAM_URL} now`)).toBe('see [address removed] now')
    expect(redactReport('path?ip=1&sig=2')).toBe('path[removed]')
    expect(redactReport(`from ${IP}`)).toBe('from [IP address removed]')
    expect(redactReport(`from ${IPV6}.`)).toBe('from [IP address removed].')
    expect(redactReport('Cookie: SID=abc')).toBe('[removed]')
    expect(redactReport(`a ${SIGNATURE} b`)).toBe('a [removed] b')
  })

  it('keeps versions, times and host names', () => {
    const kept =
      'Version 0.2.1, on. Waits until 10:30 AM. rr3---sn-fake1.googlevideo.com. Played 3.0 s.'
    expect(redactReport(kept)).toBe(kept)
  })
})
