import { describe, expect, it } from 'vitest'
import {
  ANDROID_INSTALL,
  installFinePrint,
  noExtensionNote,
  phonesAnswer,
  plainText,
  privacyInstall,
  privacyUpdateCheck,
} from './connect'

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

  it('points every phone and tablet to the free sources', () => {
    expect(noExtensionNote(false)).toBe(
      'No extension, or on a phone or tablet? The web app still plays free music from Internet Archive and Jamendo.',
    )
  })

  it('says that a zip install asks for no permission approval', () => {
    expect(privacyInstall(false)).toBe(
      "You install it from a zip file, so your browser doesn't ask you to approve its permissions.",
    )
  })

  it('has no Firefox update check to tell about yet', () => {
    expect(privacyUpdateCheck(false)).toBe('')
  })
})

describe('once the signed Firefox add-on is out', () => {
  it('names Firefox, on a computer and on Android, next to the Chromium zip', () => {
    const text = installFinePrint(true)
    expect(text).toContain('Chrome, Edge and Brave 120 or later, on a computer')
    expect(text).toContain('Firefox 140 or later, and for Firefox 142 or later on Android')
    expect(text).not.toContain('coming')
  })

  it('tells phone users that Firefox 142 or later on Android can add FXM Connect', () => {
    expect(phonesAnswer({ firefox: true, android: false })).toBe(
      'On Android, Firefox 142 or later can add FXM Connect too. In other phone browsers, on iPhone and iPad, and in browsers such as Safari, the web app plays free music from Internet Archive and Jamendo. The Android app is coming soon.',
    )
    expect(phonesAnswer({ firefox: true, android: true })).toMatch(
      /The Android app has everything built in\.$/,
    )
    for (const android of [false, true]) {
      expect(phonesAnswer({ firefox: true, android })).not.toContain('needs a desktop browser')
    }
  })

  it("points only phones that can't add FXM Connect to the free sources", () => {
    const note = noExtensionNote(true)
    expect(note).toBe(
      'No extension, or on an iPhone, an iPad or a phone browser other than Firefox? The web app still plays free music from Internet Archive and Jamendo.',
    )
    expect(note).not.toContain('on a phone or tablet')
  })

  it("walks through Firefox for Android's install from a file, as Mozilla documents it", () => {
    expect(plainText(ANDROID_INSTALL)).toBe(
      'On Android (Firefox 142 or later): download the .xpi in Firefox, open Settings → About Firefox and tap the Firefox logo five times. Then go back to Settings, tap Install extension from file, pick the file and tap Add.',
    )
    // The names of Firefox's own buttons and menus are labels, which the page shows in bold.
    expect(ANDROID_INSTALL.filter((part) => typeof part !== 'string')).toEqual([
      { label: 'Settings → About Firefox' },
      { label: 'Settings' },
      { label: 'Install extension from file' },
      { label: 'Add' },
    ])
  })

  it('says that Firefox asks for approval and the Chromium zip does not', () => {
    const text = privacyInstall(true)
    expect(text).toContain('Firefox asks you to approve its permissions')
    expect(text).toContain(
      "In Chrome, Edge and Brave you install it from a zip file, so the browser doesn't ask",
    )
  })

  it("says that Firefox checks Mozilla's site for updates to the add-on", () => {
    expect(privacyUpdateCheck(true)).toBe(
      "Firefox checks addons.mozilla.org for updates to the FXM Connect add-on, under Mozilla's privacy policy.",
    )
  })
})
