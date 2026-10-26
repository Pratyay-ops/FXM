import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { noExtensionNote, phonesAnswer } from './connect'
import {
  CONNECT_DOES,
  connectNeededFor,
  diagramLabel,
  extensionFaq,
  freeSources,
  heroNote,
  howItWorksStep,
  iPhoneAnswer,
  losslessAnswer,
  losslessSources,
  musicMode,
  noExtensionHighlight,
  noExtensionPlays,
  otherBrowsersPlays,
  privacyLiteCheck,
  SPOTIFY_ACCOUNT,
  webCardIntro,
} from './tiers'

const BOTH = [false, true] as const

/** The web card's no-extension note, before and after the signed Firefox add-on is out. */
function noExtensionNotes(lite: boolean, jamendo = false): string[] {
  return BOTH.map((firefox) => noExtensionNote(firefox, { lite, jamendo }))
}

/** The FAQ's answer for phones, for every value of AVAILABLE.firefox and AVAILABLE.android. */
function phonesAnswers(lite: boolean, jamendo = false): string[] {
  return BOTH.flatMap((firefox) =>
    BOTH.map((android) => phonesAnswer({ firefox, android, lite, jamendo })),
  )
}

/** Every sentence that depends on AVAILABLE.lite, for one value of it (and of AVAILABLE.jamendo). */
function allCopy(lite: boolean, jamendo = false): string[] {
  const highlight = noExtensionHighlight(lite, jamendo)
  const faq = extensionFaq(lite, jamendo)
  return [
    heroNote(lite),
    highlight.title,
    highlight.text,
    webCardIntro(lite),
    ...noExtensionNotes(lite, jamendo),
    howItWorksStep(lite, jamendo),
    diagramLabel(lite),
    faq.question,
    ...faq.answers,
    connectNeededFor(lite),
    ...phonesAnswers(lite, jamendo),
    iPhoneAnswer(lite, jamendo),
    privacyLiteCheck(lite),
  ]
}

/** The sentences that name the free sources, for both values of AVAILABLE.lite. */
function freeMusicLines(jamendo: boolean): string[] {
  return BOTH.flatMap((lite) => [
    noExtensionHighlight(lite, jamendo).text,
    noExtensionPlays(lite, jamendo),
    otherBrowsersPlays(lite, jamendo),
    iPhoneAnswer(lite, jamendo),
    ...extensionFaq(lite, jamendo).answers.filter((answer) => /free (music|sources)/.test(answer)),
  ]).concat(musicMode(jamendo))
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
    expect(noExtensionHighlight(false, false)).toEqual({
      title: 'Free music, no extension needed',
      text: 'Without FXM Connect, the web app still plays free music from Internet Archive, and invites you to add the extension for YouTube Music and Spotify.',
      experimental: false,
    })
    expect(noExtensionNote(false, { lite: false })).toBe(
      'No extension, or on a phone or tablet? The web app still plays free music from Internet Archive.',
    )
    expect(phonesAnswer({ firefox: false, android: false, lite: false })).toBe(
      'On phones and tablets, and in other browsers such as Safari, the web app plays free music from Internet Archive. FXM Connect needs a desktop browser, and the Android app is coming soon.',
    )
    expect(iPhoneAnswer(false, false)).toBe(
      "FXM Connect isn't available there, so the web app plays from free sources such as Internet Archive.",
    )
    expect(extensionFaq(false, false).question).toBe('Why does the web app need an extension?')
  })

  it('never mentions Lite', () => {
    for (const sentence of allCopy(false)) expect(sentence).not.toMatch(/\bLite\b/)
  })
})

describe('once Lite is out (AVAILABLE.lite on)', () => {
  it('describes Lite as experimental, and only where the browser allows it', () => {
    for (const sentence of [
      heroNote(true),
      noExtensionHighlight(true, false).text,
      webCardIntro(true),
      ...noExtensionNotes(true),
      howItWorksStep(true, false),
      ...phonesAnswers(true),
    ]) {
      // A tier, as the web app calls it: the Features section's modes are Music and Music + Video.
      expect(sentence).toContain('the experimental Lite tier')
      expect(sentence).toContain('where the browser allows it')
    }
    for (const sentence of allCopy(true)) expect(sentence).not.toMatch(/Lite mode/)
    expect(noExtensionHighlight(true, false).experimental).toBe(true)
    expect(extensionFaq(true, false).answers[0]).toMatch(/may stop working at any time/)
  })

  it('still sends Spotify to FXM Connect', () => {
    expect(heroNote(true)).toContain('Spotify needs the free FXM Connect extension')
    expect(noExtensionHighlight(true, false).text).toContain('Add the extension for Spotify')
    expect(extensionFaq(true, false).answers[1]).toMatch(/^For Spotify, add FXM Connect\./)
    expect(connectNeededFor(true)).toBe("Spotify (and for YouTube Music where Lite doesn't work)")
  })

  it('says where Lite was tried, and that Safari and phones are untested', () => {
    for (const answer of phonesAnswers(true)) {
      expect(answer).toContain('tried in Chrome and Firefox on a computer')
      expect(answer).toContain("isn't tested in Safari or on phones yet")
    }
    expect(iPhoneAnswer(true, false)).toContain("Lite isn't tested on iPhone and iPad yet")
  })

  it('keeps who can add FXM Connect, which the Firefox add-on changes', () => {
    expect(noExtensionNote(false, { lite: true })).toBe(
      'No extension, or on a phone or tablet? The web app plays free music from Internet Archive, and YouTube Music in the experimental Lite tier where the browser allows it.',
    )
    expect(noExtensionNote(true, { lite: true })).toBe(
      'No extension, or on an iPhone, an iPad or a phone browser other than Firefox? The web app plays free music from Internet Archive, and YouTube Music in the experimental Lite tier where the browser allows it.',
    )
    expect(phonesAnswer({ firefox: false, android: false, lite: true })).toBe(
      "On phones and tablets, and in other browsers such as Safari, the web app plays free music from Internet Archive, and YouTube Music in the experimental Lite tier where the browser allows it. Lite has been tried in Chrome and Firefox on a computer; it isn't tested in Safari or on phones yet. FXM Connect needs a desktop browser, and the Android app is coming soon.",
    )
    expect(phonesAnswer({ firefox: true, android: true, lite: true, jamendo: true })).toBe(
      "On Android, Firefox 142 or later can add FXM Connect too. In other phone browsers, on iPhone and iPad, and in browsers such as Safari, the web app plays free music from Internet Archive and Jamendo, and YouTube Music in the experimental Lite tier where the browser allows it. Lite has been tried in Chrome and Firefox on a computer; it isn't tested in Safari or on phones yet. The Android app has everything built in.",
    )
  })

  it('no longer says the extension is needed to listen', () => {
    expect(extensionFaq(true, false).question).toBe('Do I need an extension?')
    expect(diagramLabel(true)).toBe('Web app, desktop or Android')
    expect(noExtensionHighlight(true, false).title).toBe('No extension needed to start')
  })
})

describe('in both versions', () => {
  it("says all FXM Connect does: the headers, Spotify's server time and the opt-in login", () => {
    // It always relays Spotify's server time, and its login bridge is opt-in: neither is its
    // "only" other part, and it never holds no music-service code.
    expect(CONNECT_DOES).toContain("adjusts a few headers on FXM's own requests")
    expect(CONNECT_DOES).toContain("fetches Spotify's public server time when the web app asks")
    expect(CONNECT_DOES).toContain('option to use your Spotify login is off unless you turn it on')
    for (const lite of [false, true]) {
      for (const sentence of allCopy(lite)) {
        expect(sentence).not.toMatch(/no music-service|only other part|one other part/)
      }
    }
    expect(howItWorksStep(false, false)).toContain(CONNECT_DOES)
    expect(extensionFaq(true, false).answers[1]).toContain(CONNECT_DOES)
  })

  it('tells the privacy page about the request that checks Lite at start-up', () => {
    expect(privacyLiteCheck(false)).toBe(
      'Without FXM Connect, the web app also sends YouTube Music one request when it starts, to check whether it can reach YouTube Music without the extension.',
    )
    expect(privacyLiteCheck(true)).toBe(
      'Without FXM Connect, the web app also sends YouTube Music one request when it starts, to check whether the experimental Lite tier works in your browser.',
    )
  })

  it('says Music mode plays songs from any source, and the Spotify sync only reads', () => {
    expect(musicMode(false)).toMatch(/^Songs only, from any source/)
    expect(musicMode(true)).toContain('Internet Archive and Jamendo')
    expect(SPOTIFY_ACCOUNT).toContain('read-only')
  })
})

describe('Jamendo (AVAILABLE.jamendo, set by the deploy with FXM’s public client_id)', () => {
  it('keeps the free-music lines to Internet Archive until the build offers Jamendo', () => {
    expect(freeSources(false)).toBe('Internet Archive')
    for (const sentence of [...freeMusicLines(false), ...allCopy(false), ...allCopy(true)]) {
      expect(sentence).not.toMatch(/Jamendo/)
    }
    expect(howItWorksStep(false, false)).toContain('FXM asks YouTube Music, Internet Archive and')
  })

  it('says Jamendo is coming soon wherever the site names it before then', () => {
    expect(losslessSources(false)).toBe('(Internet Archive; Jamendo is coming soon)')
    expect(losslessAnswer(false)).toBe(
      'Yes, where the source has it. Internet Archive offers real lossless FLAC, which FXM can play, and so will Jamendo (coming soon).',
    )
  })

  it('names Jamendo next to Internet Archive once the build offers it, with nothing coming soon', () => {
    expect(freeSources(true)).toBe('Internet Archive and Jamendo')
    for (const sentence of freeMusicLines(true))
      expect(sentence).toContain('Internet Archive and Jamendo')
    for (const sentence of [...allCopy(false, true), ...allCopy(true, true)]) {
      expect(sentence).not.toMatch(/Jamendo \(coming soon\)|Jamendo is coming soon|will Jamendo/)
    }
    expect(howItWorksStep(false, true)).toContain(
      'FXM asks YouTube Music, Internet Archive, Jamendo and',
    )
    expect(losslessSources(true)).toBe('(Internet Archive, Jamendo)')
    expect(losslessAnswer(true)).toBe(
      'Yes, where the source has it. Internet Archive and Jamendo offer real lossless FLAC, which FXM can play.',
    )
  })
})

describe('the pages', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('take every Lite sentence from these helpers, with AVAILABLE.lite', () => {
    expect(source('../components/Hero.astro')).toContain('heroNote(AVAILABLE.lite)')
    const features = source('../components/Features.astro')
    expect(features).toContain('noExtensionHighlight(AVAILABLE.lite, AVAILABLE.jamendo)')
    const getFxm = source('../components/GetFxm.astro')
    expect(getFxm).toContain('webCardIntro(AVAILABLE.lite)')
    expect(getFxm).toMatch(
      /noExtensionNote\(AVAILABLE\.firefox, \{\s*lite: AVAILABLE\.lite,\s*jamendo: AVAILABLE\.jamendo,?\s*\}\)/,
    )
    const how = source('../components/HowItWorks.astro')
    expect(how).toContain('howItWorksStep(AVAILABLE.lite, AVAILABLE.jamendo)')
    expect(how).toContain('diagramLabel(AVAILABLE.lite)')
    const faq = source('../components/Faq.astro')
    expect(faq).toContain('connectNeededFor(AVAILABLE.lite)')
    for (const helper of ['extensionFaq', 'iPhoneAnswer']) {
      expect(faq).toContain(`${helper}(AVAILABLE.lite, AVAILABLE.jamendo)`)
    }
    // phonesAnswer (src/lib/connect.ts) also reads AVAILABLE.firefox and AVAILABLE.android.
    expect(faq).toMatch(/phonesAnswer\(\{[^}]*lite: AVAILABLE\.lite,\s*jamendo: AVAILABLE\.jamendo/)
    expect(source('../pages/privacy.astro')).toContain('privacyLiteCheck(AVAILABLE.lite)')
  })

  it('take every sentence naming Jamendo from AVAILABLE.jamendo', () => {
    const features = source('../components/Features.astro')
    expect(features).toContain('musicMode(AVAILABLE.jamendo)')
    expect(features).toContain('losslessSources(AVAILABLE.jamendo)')
    expect(source('../components/Faq.astro')).toContain('losslessAnswer(AVAILABLE.jamendo)')
    expect(source('../components/HowItWorks.astro')).toContain(
      "AVAILABLE.jamendo ? 'Jamendo' : 'Jamendo (coming soon)'",
    )
    const privacy = source('../pages/privacy.astro')
    expect(privacy).toMatch(/name: 'Jamendo',[\s\S]*?use: AVAILABLE\.jamendo/)
    // Everywhere else, Jamendo comes only through the helpers above.
    for (const page of ['../components/GetFxm.astro', '../components/Hero.astro']) {
      expect(source(page)).not.toContain('Jamendo')
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

  it('promise only the update prompt the web app has: one for an out-of-date FXM Connect', () => {
    const getFxm = source('../components/GetFxm.astro')
    expect(getFxm).not.toContain('says a new version is out')
    expect(getFxm).toMatch(/When the web app says FXM Connect is out of date/)
  })
})
