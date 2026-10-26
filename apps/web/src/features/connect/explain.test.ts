import { describe, expect, it } from 'vitest'
import { detectDevice } from './device'
import {
  appsSentence,
  canGetMoreHere,
  describeConnect,
  describeLite,
  describeSpotify,
  describeYouTube,
  explainConnection,
  howToGetMore,
  isDetecting,
} from './explain'
import {
  CONNECT_STATUS,
  DETECTING,
  readyConnection,
  TIER_CAPABILITIES,
  USER_AGENTS,
} from './testing'

const device = (userAgent: string) => detectDevice({ userAgent })
const chrome = device(USER_AGENTS.chromeWindows)
const firefox = device(USER_AGENTS.firefoxLinux)
const macSafari = device(USER_AGENTS.safariMac)
const iphone = device(USER_AGENTS.iphone)
const android = device(USER_AGENTS.androidChrome)

describe('explainConnection', () => {
  it('says it is still checking before detection is done', () => {
    expect(explainConnection(DETECTING)).toEqual([
      'Checking how FXM can reach music on this device…',
    ])
  })

  it("explains FXM Connect's answer while Lite's check still runs", () => {
    const previewed = { ...DETECTING, connect: CONNECT_STATUS.absent, lite: 'checking' as const }
    expect(isDetecting(previewed)).toBe(false)
    expect(explainConnection(previewed, chrome)).toEqual([
      "FXM Connect isn't installed in this browser.",
      'Checking whether Lite works in this browser…',
    ])
  })

  it('names FXM Connect and its version in Full', () => {
    const lines = explainConnection(
      readyConnection({
        connect: CONNECT_STATUS.present,
        capabilities: TIER_CAPABILITIES.full,
        lite: 'not-needed',
      }),
    )
    expect(lines).toEqual(['FXM Connect 0.1.0 is on in this browser.'])
  })

  it('explains Lite: no FXM Connect, and the check passed', () => {
    expect(
      explainConnection(readyConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' })),
    ).toEqual([
      "FXM Connect isn't installed in this browser.",
      "Lite's check passed: YouTube Music answers this browser without an install.",
    ])
  })

  it('explains Free only: the check failed, or Lite is switched off', () => {
    expect(explainConnection(readyConnection({ lite: 'failed' }))[1]).toMatch(/didn't pass/)
    expect(explainConnection(readyConnection({ lite: 'switched-off' }))[1]).toMatch(
      /switched off for everyone/,
    )
  })

  it("says what YouTube Music needs when Lite's check fails, for the device", () => {
    expect(describeLite('failed', chrome)).toBe(
      "Lite's check didn't pass in this browser, so YouTube Music needs FXM Connect here.",
    )
    expect(describeLite('failed', macSafari)).toBe(
      "Lite's check didn't pass in this browser, so YouTube Music needs FXM Connect, which Safari can't add.",
    )
    for (const phone of [iphone, android]) {
      expect(describeLite('failed', phone)).toBe(
        "Lite's check didn't pass in this browser, so YouTube Music isn't available in this browser.",
      )
    }
  })

  it('says an outdated FXM Connect goes unused, and which version FXM needs', () => {
    expect(describeConnect(CONNECT_STATUS.outdated)).toBe(
      "FXM Connect 0.0.9 is too old for this version of FXM, so FXM doesn't use it. FXM needs version 0.1.0 or later.",
    )
  })

  it('says a missing FXM Connect worked before and may be off or blocked', () => {
    expect(describeConnect(CONNECT_STATUS.missing)).toBe(
      "FXM Connect worked in this browser before (version 0.1.0), but it isn't answering now. It may be turned off, removed or blocked by the browser.",
    )
  })

  it('mentions the Spotify login when FXM Connect offers it', () => {
    const lines = explainConnection(
      readyConnection({
        connect: { ...CONNECT_STATUS.present, features: ['youtube', 'spotify', 'spotify-login'] },
        capabilities: { ...TIER_CAPABILITIES.full, spotify: 'account' },
        lite: 'not-needed',
      }),
    )
    expect(lines).toContain('FXM Connect lets FXM use your Spotify login from this browser.')
  })

  it('speaks of the app on desktop and Android', () => {
    expect(
      explainConnection(
        readyConnection({ platform: 'desktop', capabilities: TIER_CAPABILITIES.full }),
      ),
    ).toEqual(['The desktop app reaches every service directly, with nothing else to install.'])
    expect(explainConnection(readyConnection({ platform: 'android' }))).toEqual([
      "This version of the Android app can't reach YouTube Music or Spotify yet.",
    ])
  })

  it('admits a failed detection', () => {
    expect(explainConnection(readyConnection({ phase: 'failed' }))[0]).toMatch(/couldn't check/)
  })
})

describe('the short descriptions', () => {
  it('describe each Lite state, and nothing when Lite is not needed', () => {
    expect(describeLite('not-needed')).toBeUndefined()
    expect(describeLite('checking')).toMatch(/Checking/)
    expect(describeLite('unavailable')).toMatch(/isn't available/)
  })

  it('describe what YouTube and Spotify allow', () => {
    expect(describeYouTube(TIER_CAPABILITIES.lite)).toMatch(/through Lite/)
    expect(describeYouTube(TIER_CAPABILITIES.free)).toBe('Not reachable')
    expect(describeSpotify(TIER_CAPABILITIES.full)).toBe('Reachable')
    expect(describeSpotify(TIER_CAPABILITIES.lite)).toBe('Not reachable')
  })
})

describe('how a device gets more', () => {
  it('offers the extension in Chromium browsers and Firefox on a computer', () => {
    for (const computer of [chrome, firefox]) {
      expect(howToGetMore(computer, 'youtube-and-spotify')).toBe(
        'For YouTube Music and Spotify, add the free FXM Connect extension.',
      )
      expect(howToGetMore(computer, 'spotify')).toBe(
        'For Spotify, add the free FXM Connect extension.',
      )
    }
    expect(howToGetMore({ browser: 'other', os: 'linux' }, 'spotify')).toBe(
      'For Spotify, add the free FXM Connect extension to Chrome, Edge, Brave or Firefox.',
    )
  })

  it('sends Safari on a Mac to another browser, and offers nothing on iPhone and iPad', () => {
    expect(howToGetMore(macSafari, 'spotify')).toBe(
      "Spotify needs FXM Connect, which Safari can't add. On this Mac, open FXM in Chrome, Edge, Brave or Firefox and add it there.",
    )
    expect(howToGetMore(iphone, 'youtube-and-spotify')).toBe(
      "YouTube Music and Spotify need FXM Connect, which isn't available on iPhone and iPad.",
    )
  })

  it("never offers an app that isn't released", () => {
    expect(howToGetMore(android, 'youtube-and-spotify')).toBe(
      "YouTube Music and Spotify need FXM Connect, which browsers on Android can't add. The Android app is coming soon.",
    )
    for (const somewhere of [chrome, firefox, macSafari, iphone]) {
      expect(howToGetMore(somewhere, 'spotify')).not.toMatch(/app/)
    }
    expect(appsSentence()).toBe(
      'The desktop and Android apps, which need no extension, are coming soon.',
    )
  })

  it('knows where something can be installed right now', () => {
    expect(canGetMoreHere(chrome)).toBe(true)
    expect(canGetMoreHere(macSafari)).toBe(true)
    expect(canGetMoreHere(iphone)).toBe(false)
    expect(canGetMoreHere(android)).toBe(false)
  })
})
