import { describe, expect, it } from 'vitest'
import { ANDROID_INSTALL_NOTE, installFinePrint, phonesAnswer, privacyInstall } from './connect'

describe('before the signed Firefox add-on is out', () => {
  it('keeps FXM Connect to Chromium browsers on a computer and says the add-on is coming', () => {
    expect(installFinePrint(false)).toBe(
      'For Chrome, Edge and Brave 120 or later, on a computer. A Firefox add-on is coming.',
    )
  })

  it('tells phone users that FXM Connect needs a desktop browser', () => {
    expect(phonesAnswer({ firefox: false, android: false })).toBe(
      'On phones and tablets, and in other browsers such as Safari, the web app plays free music from Internet Archive and Jamendo. FXM Connect needs a desktop browser, and the Android app is coming soon.',
    )
    expect(phonesAnswer({ firefox: false, android: true })).toMatch(
      /FXM Connect needs a desktop browser; the Android app has everything built in\.$/,
    )
  })

  it('says that a zip install asks for no permission approval', () => {
    expect(privacyInstall(false)).toBe(
      "You install it from a zip file, so your browser doesn't ask you to approve its permissions.",
    )
  })
})

describe('once the signed Firefox add-on is out', () => {
  it('names Firefox, on a computer and on Android, next to the Chromium zip', () => {
    const text = installFinePrint(true)
    expect(text).toContain('Chrome, Edge and Brave 120 or later, on a computer')
    expect(text).toContain('Firefox 140 or later, and for Firefox 142 or later on Android')
    expect(text).not.toContain('coming')
  })

  it('tells phone users that Firefox for Android can add FXM Connect', () => {
    expect(phonesAnswer({ firefox: true, android: false })).toBe(
      'On Android, Firefox can add FXM Connect too. In other phone browsers, on iPhone and iPad, and in browsers such as Safari, the web app plays free music from Internet Archive and Jamendo. The Android app is coming soon.',
    )
    expect(phonesAnswer({ firefox: true, android: true })).toMatch(
      /The Android app has everything built in\.$/,
    )
    for (const android of [false, true]) {
      expect(phonesAnswer({ firefox: true, android })).not.toContain('needs a desktop browser')
    }
  })

  it('says how Firefox for Android installs a file, as Mozilla documents it', () => {
    expect(ANDROID_INSTALL_NOTE).toContain('Install extension from file')
    expect(ANDROID_INSTALL_NOTE).toContain('tap the Firefox logo five times')
  })

  it('says that Firefox asks for approval and the Chromium zip does not', () => {
    const text = privacyInstall(true)
    expect(text).toContain('Firefox asks you to approve its permissions')
    expect(text).toContain(
      "In Chrome, Edge and Brave you install it from a zip file, so the browser doesn't ask",
    )
  })
})
