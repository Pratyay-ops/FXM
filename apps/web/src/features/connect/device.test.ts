import { describe, expect, it } from 'vitest'
import {
  canAddConnect,
  detectDevice,
  extensionsPage,
  isChromium,
  isMacSafari,
  isMobile,
  type NavigatorHints,
  recommendedGuide,
} from './device'

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  operaMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 OPR/120.0.0.0',
  vivaldiLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Vivaldi/7.6',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
}

const at = (userAgent: string, more: Partial<NavigatorHints> = {}) =>
  detectDevice({ userAgent, ...more })

describe('detectDevice', () => {
  it.each([
    ['Chrome on Windows', at(UA.chromeWindows), { browser: 'chrome', os: 'windows' }],
    ['Edge on Windows', at(UA.edgeWindows), { browser: 'edge', os: 'windows' }],
    ['Opera on a Mac', at(UA.operaMac), { browser: 'opera', os: 'macos' }],
    ['Vivaldi on Linux', at(UA.vivaldiLinux), { browser: 'vivaldi', os: 'linux' }],
    ['Chrome on a Chromebook', at(UA.chromeOs), { browser: 'chrome', os: 'chromeos' }],
    ['Firefox on Linux', at(UA.firefoxLinux), { browser: 'firefox', os: 'linux' }],
    ['Safari on a Mac', at(UA.safariMac), { browser: 'safari', os: 'macos' }],
    ['Safari on an iPhone', at(UA.iphoneSafari), { browser: 'safari', os: 'ios' }],
    ['Chrome on an iPhone', at(UA.iphoneChrome), { browser: 'safari', os: 'ios' }],
    ['Chrome on Android', at(UA.androidChrome), { browser: 'chrome', os: 'android' }],
    ['Firefox on Android', at(UA.androidFirefox), { browser: 'firefox', os: 'android' }],
    ['Samsung Internet', at(UA.androidSamsung), { browser: 'samsung', os: 'android' }],
  ])('recognizes %s', (_name, device, expected) => {
    expect(device).toEqual(expected)
  })

  it('tells Brave apart from Chrome by navigator.brave or its brand', () => {
    expect(at(UA.chromeWindows, { brave: {} }).browser).toBe('brave')
    expect(at(UA.chromeWindows, { userAgentData: { brands: [{ brand: 'Brave' }] } }).browser).toBe(
      'brave',
    )
  })

  it('takes an iPad that asks for desktop sites for an iPad, not a Mac', () => {
    expect(at(UA.safariMac, { maxTouchPoints: 5 }).os).toBe('ios')
  })

  it('falls back to the client hint, and to other', () => {
    expect(at('Mozilla/5.0', { userAgentData: { platform: 'Windows' } }).os).toBe('windows')
    expect(at('Mozilla/5.0')).toEqual({ browser: 'other', os: 'other' })
  })
})

describe('recommendedGuide', () => {
  it('sends computers to FXM Connect for their browser', () => {
    expect(recommendedGuide(at(UA.chromeWindows))).toBe('chromium')
    expect(recommendedGuide(at(UA.edgeWindows))).toBe('chromium')
    expect(recommendedGuide(at(UA.chromeOs))).toBe('chromium')
    expect(recommendedGuide(at(UA.firefoxLinux))).toBe('firefox')
  })

  it('sends Android to the app, and Apple devices and Safari to what works without one', () => {
    expect(recommendedGuide(at(UA.androidChrome))).toBe('android')
    expect(recommendedGuide(at(UA.androidFirefox))).toBe('android')
    expect(recommendedGuide(at(UA.iphoneChrome))).toBe('apple')
    expect(recommendedGuide(at(UA.safariMac))).toBe('apple')
  })

  it("suggests the Chromium guide to a browser it doesn't know, until the desktop app is out", () => {
    expect(recommendedGuide({ browser: 'other', os: 'linux' })).toBe('chromium')
  })
})

describe('canAddConnect', () => {
  it('is true for Chromium browsers and Firefox on a computer', () => {
    for (const userAgent of [UA.chromeWindows, UA.edgeWindows, UA.chromeOs, UA.firefoxLinux]) {
      expect(canAddConnect(at(userAgent))).toBe(true)
    }
  })

  it('is false in Safari, on phones and tablets, and in browsers it does not know', () => {
    for (const userAgent of [UA.safariMac, UA.iphoneChrome, UA.androidChrome, UA.androidFirefox]) {
      expect(canAddConnect(at(userAgent))).toBe(false)
    }
    expect(canAddConnect({ browser: 'other', os: 'linux' })).toBe(false)
    expect(isMacSafari(at(UA.safariMac))).toBe(true)
    expect(isMacSafari(at(UA.iphoneSafari))).toBe(false)
  })
})

describe('helpers', () => {
  it("names each Chromium browser's extensions page", () => {
    expect(extensionsPage('chrome')).toBe('chrome://extensions')
    expect(extensionsPage('edge')).toBe('edge://extensions')
    expect(extensionsPage('brave')).toBe('brave://extensions')
    expect(extensionsPage('opera')).toBe('opera://extensions')
    expect(extensionsPage('vivaldi')).toBe('vivaldi://extensions')
    expect(extensionsPage('chromium')).toBe('chrome://extensions')
  })

  it('knows which browsers take the Chromium zip and which devices are phones', () => {
    expect(isChromium('brave')).toBe(true)
    expect(isChromium('firefox')).toBe(false)
    expect(isChromium('samsung')).toBe(false)
    expect(isMobile({ browser: 'chrome', os: 'android' })).toBe(true)
    expect(isMobile({ browser: 'chrome', os: 'chromeos' })).toBe(false)
  })
})
