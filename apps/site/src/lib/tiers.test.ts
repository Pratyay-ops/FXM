import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONNECT_DOES,
  connectNeededFor,
  diagramLabel,
  extensionFaq,
  heroNote,
  howItWorksStep,
  iPhoneAnswer,
  MUSIC_MODE,
  noExtensionHighlight,
  noExtensionNote,
  otherBrowsersAnswer,
  SPOTIFY_ACCOUNT,
  webCardIntro,
} from './tiers'

/** Every sentence that depends on AVAILABLE.lite, for one value of it. */
function allCopy(lite: boolean): string[] {
  const highlight = noExtensionHighlight(lite)
  const faq = extensionFaq(lite)
  return [
    heroNote(lite),
    highlight.title,
    highlight.text,
    webCardIntro(lite),
    noExtensionNote(lite),
    howItWorksStep(lite),
    diagramLabel(lite),
    faq.question,
    ...faq.answers,
    connectNeededFor(lite),
    otherBrowsersAnswer(lite),
    iPhoneAnswer(lite),
  ]
}

describe('before Lite is out (AVAILABLE.lite off)', () => {
  it('says the browser needs FXM Connect for YouTube Music and Spotify', () => {
    expect(heroNote(false)).toBe(
      'In the browser, YouTube Music and Spotify need the free FXM Connect extension.',
    )
    expect(webCardIntro(false)).toBe(
      'Runs in your browser. Add the free FXM Connect extension to use YouTube Music and Spotify.',
    )
    expect(connectNeededFor(false)).toBe('YouTube Music and Spotify')
    expect(diagramLabel(false)).toBe('Web app with FXM Connect, desktop or Android')
  })

  it('promises only free sources without the extension', () => {
    expect(noExtensionHighlight(false)).toEqual({
      title: 'Free music, no extension needed',
      text: 'Without FXM Connect, the web app still plays free music from Internet Archive and Jamendo, and invites you to add the extension for YouTube Music and Spotify.',
      experimental: false,
    })
    expect(noExtensionNote(false)).toBe(
      'No extension, or on a phone or tablet? The web app still plays free music from Internet Archive and Jamendo.',
    )
    expect(otherBrowsersAnswer(false)).toBe(
      'On phones and tablets, and in other browsers such as Safari, the web app plays free music from Internet Archive and Jamendo.',
    )
    expect(iPhoneAnswer(false)).toBe(
      "FXM Connect isn't available there, so the web app plays from free sources such as Internet Archive and Jamendo.",
    )
    expect(extensionFaq(false).question).toBe('Why does the web app need an extension?')
  })

  it('never mentions Lite', () => {
    for (const sentence of allCopy(false)) expect(sentence).not.toMatch(/\bLite\b/)
  })
})

describe('once Lite is out (AVAILABLE.lite on)', () => {
  it('describes Lite as experimental, and only where the browser allows it', () => {
    for (const sentence of [
      heroNote(true),
      noExtensionHighlight(true).text,
      webCardIntro(true),
      noExtensionNote(true),
      howItWorksStep(true),
      otherBrowsersAnswer(true),
    ]) {
      expect(sentence).toContain('the experimental Lite mode')
      expect(sentence).toContain('where the browser allows it')
    }
    expect(noExtensionHighlight(true).experimental).toBe(true)
    expect(extensionFaq(true).answers[0]).toMatch(/may stop working at any time/)
  })

  it('still sends Spotify to FXM Connect', () => {
    expect(heroNote(true)).toContain('Spotify needs the free FXM Connect extension')
    expect(noExtensionHighlight(true).text).toContain('Add the extension for Spotify')
    expect(extensionFaq(true).answers[1]).toMatch(/^For Spotify, add FXM Connect\./)
    expect(connectNeededFor(true)).toBe("Spotify (and for YouTube Music where Lite doesn't work)")
  })

  it('says where Lite was tried, and that Safari and phones are untested', () => {
    expect(otherBrowsersAnswer(true)).toContain('tried in Chrome and Firefox on a computer')
    expect(otherBrowsersAnswer(true)).toContain("isn't tested in Safari or on phones yet")
    expect(iPhoneAnswer(true)).toContain("Lite isn't tested on iPhone and iPad yet")
  })

  it('no longer says the extension is needed to listen', () => {
    expect(extensionFaq(true).question).toBe('Do I need an extension?')
    expect(diagramLabel(true)).toBe('Web app, desktop or Android')
    expect(noExtensionHighlight(true).title).toBe('No extension needed to start')
  })
})

describe('in both versions', () => {
  it('never claims FXM Connect has no music-service code: it carries the Spotify login bridge', () => {
    expect(CONNECT_DOES).toContain(
      'an option to use your Spotify login, is off unless you turn it on',
    )
    for (const lite of [false, true]) {
      for (const sentence of allCopy(lite)) expect(sentence).not.toMatch(/no music-service/)
    }
    expect(howItWorksStep(false)).toContain(CONNECT_DOES)
    expect(extensionFaq(true).answers[1]).toContain(CONNECT_DOES)
  })

  it('says Music mode plays songs from any source, and the Spotify sync only reads', () => {
    expect(MUSIC_MODE).toMatch(/^Songs only, from any source/)
    expect(MUSIC_MODE).toContain('Internet Archive and Jamendo')
    expect(SPOTIFY_ACCOUNT).toContain('read-only')
  })
})

describe('the pages', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('take every Lite sentence from these helpers, with AVAILABLE.lite', () => {
    expect(source('../components/Hero.astro')).toContain('heroNote(AVAILABLE.lite)')
    expect(source('../components/Features.astro')).toContain('noExtensionHighlight(AVAILABLE.lite)')
    const getFxm = source('../components/GetFxm.astro')
    expect(getFxm).toContain('webCardIntro(AVAILABLE.lite)')
    expect(getFxm).toContain('noExtensionNote(AVAILABLE.lite)')
    const how = source('../components/HowItWorks.astro')
    expect(how).toContain('howItWorksStep(AVAILABLE.lite)')
    expect(how).toContain('diagramLabel(AVAILABLE.lite)')
    const faq = source('../components/Faq.astro')
    for (const helper of [
      'extensionFaq',
      'connectNeededFor',
      'otherBrowsersAnswer',
      'iPhoneAnswer',
    ]) {
      expect(faq).toContain(`${helper}(AVAILABLE.lite)`)
    }
  })

  it('drop the sentences revision 3 found untrue', () => {
    const pages = [
      '../components/Features.astro',
      '../components/Faq.astro',
      '../components/HowItWorks.astro',
      '../components/GetFxm.astro',
      '../pages/privacy.astro',
    ].map(source)
    for (const page of pages) {
      expect(page).not.toContain('contains no music-service code')
      expect(page).not.toContain('Only songs from the YouTube Music catalog')
      expect(page).not.toContain('to sync your recommendations')
      // 1.11 may name BotGuard again, for its opt-in rungs only.
      expect(page).not.toContain('For some songs, also Google')
    }
  })

  it('tell Chromium users to leave Developer mode on', () => {
    expect(source('../components/GetFxm.astro')).toMatch(/Leave it on/)
  })
})
