import { describe, expect, it } from 'vitest'
import { AVAILABLE } from '../config'
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
  const none = { desktop: false, android: false }
  const both = { desktop: true, android: true }
  const platforms: (Platform | null)[] = [
    'android',
    'ios',
    'chromeos',
    'windows',
    'macos',
    'linux',
    null,
  ]

  it.each([
    ['nothing', none],
    ['everything', both],
    ['what src/config.ts says', AVAILABLE],
  ])('never suggests an app that is not out (released: %s)', (_name, released) => {
    for (const platform of platforms) {
      const card = cardForPlatform(platform, released)
      expect(card === null || card === 'web' || released[card]).toBe(true)
    }
  })

  it('sends computers to the web app and FXM Connect until the desktop app is out', () => {
    for (const platform of ['windows', 'macos', 'linux', 'chromeos'] as const) {
      expect(cardForPlatform(platform, none)).toBe('web')
    }
  })

  it('suggests nothing on phones while there is no app for them', () => {
    expect(cardForPlatform('android', none)).toBeNull()
    expect(cardForPlatform('ios', none)).toBeNull()
  })

  it('suggests the apps once they are released', () => {
    expect(cardForPlatform('windows', both)).toBe('desktop')
    expect(cardForPlatform('macos', both)).toBe('desktop')
    expect(cardForPlatform('linux', both)).toBe('desktop')
    expect(cardForPlatform('android', both)).toBe('android')
  })

  it('keeps Chromebooks on the web app and iPhones without a suggestion', () => {
    expect(cardForPlatform('chromeos', both)).toBe('web')
    expect(cardForPlatform('ios', both)).toBeNull()
  })

  it('suggests nothing for an unknown device', () => {
    expect(cardForPlatform(null, none)).toBeNull()
    expect(cardForPlatform(null, both)).toBeNull()
  })
})
