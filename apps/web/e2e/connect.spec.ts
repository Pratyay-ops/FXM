import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test'

// The tiers, the onboarding prompts and the Diagnostics self-test, end to end in a real browser
// against the production build, with fakes for everything outside it:
//
// - FXM Connect: an init script that does what its content script does (the marker on <html>,
//   and a pong with the version and features for each ping);
// - YouTube: Playwright answers InnerTube in front of the real Lite sandbox document
//   (apps/web/sandbox/innertube.html), with `Access-Control-Allow-Origin: null` when Lite should
//   work and a 403 without CORS headers, as YouTube answers named origins, when it shouldn't;
// - the stream resolver (stage 1.4): the fake of `?fake-song=…` (src/features/connect/dev-fakes.ts),
//   which the build includes because playwright.config.ts builds with VITE_FXM_FAKES=on.
//
// Every other request off this machine is refused, so the tests never reach the internet.

const SANDBOX_DOCUMENT = readFileSync(
  fileURLToPath(new URL('../sandbox/innertube.html', import.meta.url)),
  'utf8',
)

const CONNECT_FEATURES = ['youtube', 'googlevideo', 'spotify', 'lastfm', 'spotify-server-time']

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'

/** Puts a fake FXM Connect on every FXM page this page or context opens. */
async function addFakeConnect(target: Page | BrowserContext, version = '0.1.0') {
  await target.addInitScript(
    ({ version, features }) => {
      // Like the real content script: the FXM page only, not the frames inside it.
      if (window !== window.top) return
      // The content script runs once <html> exists, before any page script; init scripts can
      // run before that, so wait for the element.
      const mark = () => document.documentElement.setAttribute('data-fxm-connect', version)
      if (document.documentElement !== null) mark()
      else {
        new MutationObserver((_records, observer) => {
          if (document.documentElement === null) return
          observer.disconnect()
          mark()
        }).observe(document, { childList: true })
      }
      window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== location.origin) return
        if ((event.data as { type?: unknown } | null)?.type === 'fxm-connect:ping') {
          window.postMessage({ type: 'fxm-connect:pong', version, features }, location.origin)
        }
      })
    },
    { version, features: CONNECT_FEATURES },
  )
}

/**
 * Serves the Lite sandbox document and answers InnerTube, as YouTube does or doesn't, after
 * `delayMs` (a slow Lite check).
 */
async function fakeYouTube(page: Page, lite: boolean, delayMs = 0) {
  const innerTube: string[] = []
  // Routes run newest first: the catch-all goes in first.
  await page.route(/^https?:\/\/(?!localhost[:/])/, (route) => route.abort())
  await page.route('**/sandbox/innertube.html', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'content-security-policy': 'sandbox allow-scripts' },
      body: SANDBOX_DOCUMENT,
    }),
  )
  await page.route(/^https:\/\/(?:www|music)\.youtube\.com\/youtubei\/v1\//, async (route) => {
    const request = route.request()
    innerTube.push(
      `${request.method()} ${new URL(request.url()).pathname} ${request.headers().origin}`,
    )
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return lite
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': 'null' },
          body: JSON.stringify({ responseContext: { visitorData: 'Cgt0ZXN0' } }),
        })
      : route.fulfill({ status: 403, body: '' })
  })
  return innerTube
}

const status = (page: Page) => page.getByRole('region', { name: /^This (browser|app)$/ })
const tierCards = (page: Page) => page.getByRole('region', { name: 'What works where' })
const missingPanel = (page: Page) => page.getByRole('region', { name: "What you're missing" })
const LITE_INTRO = 'Try YouTube Music here without an install (experimental)'

/**
 * The layout shift score so far (CLS, without shifts right after input) of the shifts that moved
 * `selector`'s element. Home's own content fills in below its greeting as its shelves load,
 * which moves what follows it and has nothing to do with a notice; a notice that pushed the page
 * would move the greeting too.
 */
async function layoutShiftOf(page: Page, selector: string): Promise<number> {
  return page.evaluate(
    (target) =>
      new Promise<number>((resolve) => {
        const element = document.querySelector(target)
        let total = 0
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            value: number
            hadRecentInput: boolean
            sources?: { node?: Node | null }[]
          }[]) {
            if (entry.hadRecentInput) continue
            const moved = (entry.sources ?? []).some(
              (source) => source.node != null && element != null && source.node.contains(element),
            )
            if (moved) total += entry.value
          }
        }).observe({ type: 'layout-shift', buffered: true })
        // The buffered entries come in the observer's first call, right after observe().
        setTimeout(() => resolve(total), 200)
      }),
    selector,
  )
}

test.describe('the tiers', () => {
  test('Full with FXM Connect: no Lite self-test, no notice', async ({ page }) => {
    const innerTube = await fakeYouTube(page, true)
    await addFakeConnect(page)
    await page.goto('connect')

    await expect(status(page)).toContainText('Full')
    await expect(status(page)).toContainText('FXM Connect 0.1.0 is on in this browser.')
    const current = tierCards(page).locator('li[aria-current="true"]')
    await expect(current.getByRole('heading', { level: 3 })).toHaveText('Full')
    await expect(page.getByText('Nothing: this device has everything FXM offers.')).toBeVisible()
    expect(innerTube).toEqual([])

    await page.goto('./')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(
      page.getByRole('region', { name: /plays free music|without an install/ }),
    ).toHaveCount(0)
  })

  test('Lite without an install, where the self-test passes, marked experimental', async ({
    page,
  }) => {
    const innerTube = await fakeYouTube(page, true)
    await page.goto('connect')

    await expect(status(page)).toContainText('Lite')
    await expect(status(page)).toContainText('Experimental')
    await expect(status(page)).toContainText("Lite's check passed")
    const current = tierCards(page).locator('li[aria-current="true"]')
    await expect(current.getByRole('heading', { level: 3 })).toContainText('Lite')
    await expect(missingPanel(page)).toContainText('Spotify search and related artists')
    await expect(missingPanel(page)).not.toContainText('Lite (experimental) adds')
    // One self-test call, CORS-simple, from the sandbox's opaque origin.
    expect(innerTube).toEqual(['POST /youtubei/v1/music/get_search_suggestions null'])

    await page.goto('./')
    const intro = page.getByRole('region', { name: LITE_INTRO })
    await expect(intro).toBeVisible()
    await intro.getByRole('button', { name: 'Dismiss' }).click()
    await expect(intro).toHaveCount(0)

    // A new visit: once detection is done (the onboarding page says Lite), Home stays quiet.
    await page.goto('connect')
    await expect(status(page)).toContainText("Lite's check passed")
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Home', exact: true })
      .click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Good /)
    await expect(intro).toHaveCount(0)
  })

  test('Free only where the self-test fails, with what is missing', async ({ page }) => {
    await fakeYouTube(page, false)
    await page.goto('connect')

    await expect(status(page)).toContainText('Free only')
    await expect(status(page)).toContainText(
      "Lite's check didn't pass in this browser, so YouTube Music needs FXM Connect here.",
    )
    await expect(missingPanel(page)).toContainText(
      'Lite (experimental) adds YouTube Music and its ad-free audio.',
    )
    await expect(missingPanel(page)).toContainText(
      "Full adds YouTube Music without Lite's experimental route, YouTube Music downloads and Spotify search",
    )
    // Desktop Chrome: the Chromium guide comes first, open, with Developer mode's warning, and
    // the main button leads to it.
    const guide = page.locator('details').first()
    await expect(guide).toHaveAttribute('open', '')
    await expect(guide).toContainText('Leave Developer mode on')
    await expect(guide).toContainText('chrome://extensions')
    await status(page)
      .getByRole('button', { name: /^Add FXM Connect to / })
      .click()
    await expect(guide.locator('summary')).toBeFocused()
    // The apps aren't out: named as coming soon, with no steps.
    await expect(tierCards(page)).toContainText(
      'FXM Connect, the desktop app (coming soon) or the Android app (coming soon).',
    )
    const android = page.locator('details', {
      has: page.getByRole('heading', { name: /^Android app/ }),
    })
    await expect(android).toContainText('Not released yet')

    await page.goto('./')
    const intro = page.getByRole('region', { name: 'This browser plays free music' })
    await expect(intro).toContainText(
      'For YouTube Music and Spotify, add the free FXM Connect extension.',
    )
    await expect(intro).not.toContainText(/desktop app|Android app|one of the apps/)
  })
})

test('prompts an upgrade for an outdated FXM Connect', async ({ page }) => {
  await fakeYouTube(page, false)
  await addFakeConnect(page, '0.0.1')
  await page.goto('./')

  const prompt = page.getByRole('region', { name: 'Update FXM Connect' })
  await expect(prompt).toContainText('FXM Connect 0.0.1 is too old for this version of FXM')
  await prompt.getByRole('link', { name: 'How to update' }).click()

  await expect(page).toHaveURL(/\/app\/connect#update$/)
  const steps = page.getByRole('region', { name: 'Update FXM Connect' })
  await expect(steps).toContainText('Install version 0.1.0 or later')
  await expect(steps).toBeInViewport()
  await expect(status(page)).toContainText('Free only')
})

test('keeps keyboard focus on the page when a notice goes away', async ({ page }) => {
  await fakeYouTube(page, false)
  await addFakeConnect(page, '0.0.1')
  await page.goto('./')
  const prompt = page.getByRole('region', { name: 'Update FXM Connect' })
  await prompt.getByRole('button', { name: 'Dismiss' }).focus()
  await page.keyboard.press('Enter')
  await expect(prompt).toHaveCount(0)
  await expect(page.locator('main#main')).toBeFocused()
})

test('notices a disabled FXM Connect and says what to do', async ({ context, page }) => {
  // A first visit with FXM Connect: FXM remembers that it was seen in this browser.
  await fakeYouTube(page, false)
  await addFakeConnect(page)
  await page.goto('connect')
  await expect(status(page)).toContainText('Full')
  await page.close()

  // Then FXM Connect is turned off: the next visit finds it missing.
  const next = await context.newPage()
  await fakeYouTube(next, false)
  await next.goto('./')
  const prompt = next.getByRole('region', { name: "FXM Connect isn't answering" })
  await expect(prompt).toContainText('It worked in this browser before')
  // The apps aren't out, so the prompt doesn't offer them.
  await expect(prompt).not.toContainText(/desktop app|Android app/)
  await prompt.getByRole('link', { name: 'What to do' }).click()

  const section = next.getByRole('region', { name: "FXM Connect isn't answering" })
  await expect(section).toContainText('worked in this browser before (version 0.1.0)')
  await expect(section).toContainText('turns it off whenever Developer mode is off')
  await expect(section).toContainText(
    'The desktop and Android apps, which need no extension, are coming soon.',
  )
  await expect(section.getByRole('button', { name: /Desktop app|Android app/ })).toHaveCount(0)
  // Said once: the status card leaves the details to the section.
  await expect(status(next)).not.toContainText('worked in this browser before')

  await section.getByRole('button', { name: 'I removed it on purpose' }).focus()
  await next.keyboard.press('Enter')
  await expect(section).toHaveCount(0)
  // Focus moves to the status card, which now says what changed.
  await expect(status(next)).toBeFocused()
  await expect(status(next)).toContainText("FXM Connect isn't installed in this browser.")

  // No invitation to add what the user just removed.
  await next
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Home', exact: true })
    .click()
  await expect(next.getByRole('heading', { level: 1 })).toHaveText(/^Good /)
  await expect(next.getByRole('region', { name: /plays free music|isn't answering/ })).toHaveCount(
    0,
  )
})

test.describe('the notices never move the page', () => {
  test.use({ viewport: { width: 360, height: 720 } })

  const cases = [
    ['the first-visit introduction, after a slow Lite check', 'This browser plays free music'],
    ['the upgrade prompt', 'Update FXM Connect'],
  ] as const

  for (const [name, notice] of cases) {
    test(name, async ({ page }) => {
      await fakeYouTube(page, false, 1500)
      if (notice === 'Update FXM Connect') await addFakeConnect(page, '0.0.1')
      await page.goto('./')
      const heading = page.getByRole('heading', { level: 1 })
      await expect(heading).toHaveText(/^Good /)
      // The page's own content, before the notice's layer. Its height follows Home's shelves as
      // they load (the welcome card, here), which a notice has nothing to do with: what must not
      // move is where the page starts, the greeting.
      const content = page.locator('main > div > :first-child')
      await expect(page.getByRole('region', { name: 'Play practically any song' })).toBeVisible()
      const before = await heading.boundingBox()

      const shown = page.getByRole('region', { name: notice })
      await expect(shown).toBeVisible()

      // It floats above the mini player and the tab bar: nothing on the page moved.
      expect(await heading.boundingBox()).toEqual(before)
      expect(await layoutShiftOf(page, 'main h1')).toBe(0)
      // The end of the page still scrolls clear of it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await expect(async () => {
        const end = await content.boundingBox()
        const box = await shown.boundingBox()
        expect((end?.y ?? 0) + (end?.height ?? 0)).toBeLessThanOrEqual(box?.y ?? 0)
      }).toPass()
    })
  }
})

test.describe('with the other floating layers, on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("keeps SponsorBlock's offer and the app's toast clear of a notice", async ({
    context,
    page,
  }) => {
    // FXM Connect worked here once, so the next visit says it isn't answering, on every page.
    await fakeYouTube(page, false)
    await addFakeConnect(page)
    await page.goto('connect')
    await expect(status(page)).toContainText('Full')
    await page.close()

    const next = await context.newPage()
    await fakeYouTube(next, false)
    // Music + Video mode, where SponsorBlock offers itself (stage 8.7).
    await next.addInitScript(() => {
      localStorage.setItem(
        'fxm.settings.v1',
        JSON.stringify({ state: { catalogMode: 'all', theme: 'dark' }, version: 1 }),
      )
    })
    await next.goto('library')
    const notice = next.getByRole('region', { name: "FXM Connect isn't answering" })
    const offer = next.getByRole('region', { name: 'Skip non-music parts of videos?' })
    await expect(notice).toBeVisible()
    await expect(offer).toBeVisible()
    const below = async (upper: Locator, lower: Locator) => {
      const [top, bottom] = await Promise.all([upper.boundingBox(), lower.boundingBox()])
      expect((top?.y ?? 0) + (top?.height ?? 0)).toBeLessThanOrEqual(bottom?.y ?? 0)
    }
    // The notice stacks above SponsorBlock's card instead of hiding behind it.
    await expect(() => below(notice, offer)).toPass()

    // The page's own button; the empty list offers another.
    await next.getByRole('main').getByRole('button', { name: 'New playlist' }).first().click()
    const dialog = next.getByRole('dialog', { name: 'New playlist' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Late night')
    await dialog.getByRole('button', { name: 'Create' }).click()
    const toast = next.getByRole('status').getByText('Created Late night')
    await expect(toast).toBeVisible()
    // The toast rises above the notice, whose buttons stay in reach.
    await expect(notice).toBeVisible()
    await expect(() => below(toast, notice)).toPass({ timeout: 3_000 })
  })
})

test.describe('on an Android phone', () => {
  test.use({ userAgent: ANDROID_CHROME, viewport: { width: 360, height: 760 }, isMobile: true })

  test('says what plays here, and that the Android app is coming soon', async ({ page }) => {
    await fakeYouTube(page, false)
    await page.goto('./')
    const intro = page.getByRole('region', { name: 'This browser plays free music' })
    await expect(intro).toContainText(
      "YouTube Music and Spotify need FXM Connect, which browsers on Android can't add. The Android app is coming soon.",
    )
    await intro.getByRole('link', { name: 'See your options' }).click()

    await expect(status(page)).toContainText("YouTube Music isn't available in this browser")
    // Nothing to install here yet: no main button, and the guides are for other devices.
    await expect(status(page).getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Other devices and apps' })).toBeVisible()
    const guide = page.locator('details').first()
    await expect(guide).toHaveAttribute('open', '')
    await expect(guide.getByRole('heading', { level: 3 })).toContainText('Android app')
    await expect(guide).toContainText('Coming soon')
    await expect(guide).toContainText("Until it's out, this browser plays free music")
    await expect(guide).toContainText('Not released yet')
    await expect(guide).not.toContainText('download the APK')
  })
})

test.describe('on an iPhone', () => {
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 }, isMobile: true })

  test('offers nothing to install, and says what works', async ({ page }) => {
    await fakeYouTube(page, false)
    await page.goto('./')
    const intro = page.getByRole('region', { name: 'This browser plays free music' })
    await expect(intro).toContainText(
      "YouTube Music and Spotify need FXM Connect, which isn't available on iPhone and iPad.",
    )
    await expect(intro).not.toContainText(/add the free|one of the apps/)
    await page.goto('connect')
    await expect(status(page).getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Other devices and apps' })).toBeVisible()
    await expect(page.locator('details').first()).toContainText(
      "Lite hasn't been tested in Safari yet",
    )
  })
})

test.describe('the Diagnostics self-test', () => {
  test('resolves and plays one song with FXM Connect', async ({ page }) => {
    await fakeYouTube(page, false)
    await addFakeConnect(page)
    await page.goto('settings?fake-song=plays')
    const diagnostics = page.locator('section#diagnostics')
    await expect(diagnostics).toContainText('Full')

    await diagnostics.getByRole('button', { name: 'Resolve and play one song' }).click()

    await expect(diagnostics).toContainText(
      /Played \d+\.\d s of Fake stream · 128 kbps · VISIONOS\./,
      {
        timeout: 15_000,
      },
    )
  })

  test('in Lite, falls back to the last-resort stream when the first one fails', async ({
    page,
  }) => {
    await fakeYouTube(page, true)
    await page.goto('settings?fake-song=capped')
    const diagnostics = page.locator('section#diagnostics')
    await expect(diagnostics).toContainText('Check passed')

    await diagnostics.getByRole('button', { name: 'Resolve and play one song' }).click()

    await expect(diagnostics).toContainText(/Played \d+\.\d s of Fake last-resort stream/, {
      timeout: 15_000,
    })
    await expect(diagnostics).toContainText(
      "Fake stream that stops early · 135 kbps · VISIONOS: the browser couldn't play it",
    )
  })

  test("says when no stream plays, and when it can't run at all", async ({ page }) => {
    await fakeYouTube(page, true)
    await page.goto('settings?fake-song=fails')
    const diagnostics = page.locator('section#diagnostics')
    await expect(diagnostics).toContainText('Check passed')
    await diagnostics.getByRole('button', { name: 'Resolve and play one song' }).click()
    await expect(diagnostics).toContainText('No stream played.', { timeout: 15_000 })

    // Without YouTube access there is nothing to test.
    const free = await page.context().newPage()
    await fakeYouTube(free, false)
    await free.goto('settings')
    const freeDiagnostics = free.locator('section#diagnostics')
    await expect(freeDiagnostics).toContainText('Free only')
    await expect(freeDiagnostics).toContainText(
      "This browser can't reach YouTube Music, so there is nothing to test.",
    )
    await expect(
      freeDiagnostics.getByRole('button', { name: 'Resolve and play one song' }),
    ).toBeDisabled()
  })
})

test.describe('screenshots', () => {
  // Visual check, not a test: FXM_SCREENSHOTS=1 saves the onboarding page, Home with its notice
  // and Diagnostics in each tier, on a computer and on phones, to apps/web/screenshots/
  // (gitignored), and the onboarding page in forced colors.
  test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 to capture')
  // Each run captures every case, three pages each.
  test.describe.configure({ timeout: 180_000 })

  // [name, Lite passes, FXM Connect's version, seen here before, a phone's User-Agent]
  const cases = [
    ['free', false, undefined, false, undefined],
    ['lite', true, undefined, false, undefined],
    ['full', false, '0.1.0', false, undefined],
    ['outdated', false, '0.0.1', false, undefined],
    ['missing', false, undefined, true, undefined],
    ['android', false, undefined, false, ANDROID_CHROME],
    ['iphone', true, undefined, false, IPHONE_SAFARI],
  ] as const

  for (const width of [320, 768, 1280] as const) {
    for (const theme of ['dark', 'light'] as const) {
      test(`the tiers at ${width}px, ${theme}`, async ({ browser }) => {
        for (const [name, lite, version, seen, phone] of cases) {
          if (phone !== undefined && width > 768) continue
          // A fresh context per case: nothing remembered from the case before.
          const context = await browser.newContext({
            viewport: { width, height: width < 768 ? 720 : 900 },
            reducedMotion: 'reduce',
            ...(phone === undefined ? {} : { userAgent: phone, isMobile: true }),
          })
          await context.addInitScript(
            ({ state, seen }) => {
              localStorage.setItem('fxm.settings.v1', JSON.stringify({ state, version: 1 }))
              if (seen) {
                localStorage.setItem(
                  'fxm.connect.lastSeen',
                  JSON.stringify({ version: '0.1.0', at: 1 }),
                )
              }
            },
            { state: { catalogMode: 'music', theme }, seen },
          )
          const tab = await context.newPage()
          await fakeYouTube(tab, lite)
          if (version !== undefined) await addFakeConnect(tab, version)
          await tab.goto('connect')
          await expect(status(tab)).not.toContainText('Checking')
          await tab.screenshot({
            path: `screenshots/connect-${theme}-${width}-${name}.png`,
            fullPage: true,
          })
          await tab.goto('./')
          await expect(tab.getByRole('heading', { level: 1 })).toBeVisible()
          await tab.waitForTimeout(300)
          await tab.screenshot({ path: `screenshots/connect-${theme}-${width}-${name}-home.png` })
          await tab.goto(`settings?fake-song=capped`)
          const diagnostics = tab.locator('section#diagnostics')
          await expect(diagnostics).not.toContainText('Checking…')
          if (name === 'lite') {
            await diagnostics.getByRole('button', { name: 'Resolve and play one song' }).click()
            await expect(diagnostics).toContainText('Played', { timeout: 15_000 })
          }
          await diagnostics.screenshot({
            path: `screenshots/connect-${theme}-${width}-${name}-diagnostics.png`,
          })
          if (name === 'free') {
            // Settings → FXM Connect, the way back to the onboarding page.
            await tab.screenshot({
              path: `screenshots/connect-${theme}-${width}-settings.png`,
              fullPage: true,
            })
          }
          await context.close()
        }
      })
    }
  }

  test('the onboarding page in forced colors', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      forcedColors: 'active',
      reducedMotion: 'reduce',
    })
    const tab = await context.newPage()
    await fakeYouTube(tab, true)
    await tab.goto('connect')
    await expect(status(tab)).not.toContainText('Checking')
    await tab.screenshot({ path: 'screenshots/connect-forced-colors.png', fullPage: true })
    await context.close()
  })
})
