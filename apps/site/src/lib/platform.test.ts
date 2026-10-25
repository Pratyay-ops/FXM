import { describe, expect, it } from 'vitest'
import { cardForPlatform, detectPlatform, type Platform } from './platform'

// Real user agents (Chromium's reduced format where it applies).
const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  bot: 'Mozilla/5.0 (compatible; ExampleBot/1.0)',
}

describe('detectPlatform', () => {
  it.each<[string, string, number, Platform | null]>([
    ['Android', UA.androidChrome, 5, 'android'],
    ['iPhone', UA.iphone, 5, 'ios'],
    ['iPad asking for the desktop site', UA.ipadDesktop, 5, 'ios'],
    ['Mac', UA.mac, 0, 'macos'],
    ['Windows', UA.windows, 0, 'windows'],
    ['Linux', UA.linuxFirefox, 0, 'linux'],
    ['ChromeOS', UA.chromebook, 0, 'chromeos'],
    ['an unknown device', UA.bot, 0, null],
  ])('recognizes %s', (_name, userAgent, maxTouchPoints, expected) => {
    expect(detectPlatform({ userAgent, maxTouchPoints })).toBe(expected)
  })

  it('falls back to the client hint when the user agent says nothing', () => {
    expect(detectPlatform({ userAgent: UA.bot, platformHint: 'Windows' })).toBe('windows')
    expect(detectPlatform({ userAgent: UA.bot, platformHint: 'Chrome OS' })).toBe('chromeos')
    expect(detectPlatform({ userAgent: UA.bot, platformHint: 'Unknown' })).toBeNull()
  })

  it('trusts the user agent over the client hint', () => {
    expect(detectPlatform({ userAgent: UA.androidChrome, platformHint: 'macOS' })).toBe('android')
  })
})

describe('cardForPlatform', () => {
  it('suggests the app for the platform, or the web app where there is none', () => {
    expect(cardForPlatform('android')).toBe('android')
    expect(cardForPlatform('windows')).toBe('desktop')
    expect(cardForPlatform('macos')).toBe('desktop')
    expect(cardForPlatform('linux')).toBe('desktop')
    expect(cardForPlatform('ios')).toBe('web')
    expect(cardForPlatform('chromeos')).toBe('web')
    expect(cardForPlatform(null)).toBeNull()
  })
})
