import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, expect, type Page, test } from '@playwright/test'

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

/** Serves the Lite sandbox document and answers InnerTube, as YouTube does or doesn't. */
async function fakeYouTube(page: Page, lite: boolean) {
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
  await page.route(/^https:\/\/(?:www|music)\.youtube\.com\/youtubei\/v1\//, (route) => {
    const request = route.request()
    innerTube.push(
      `${request.method()} ${new URL(request.url()).pathname} ${request.headers().origin}`,
    )
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

const status = (page: Page) => page.getByRole('status').filter({ hasText: /This (browser|app)/ })
const tierCards = (page: Page) => page.getByRole('region', { name: 'What works where' })

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
    const missing = page.getByRole('region', { name: "What you're missing" })
    await expect(missing).toContainText('Spotify search and related artists')
    await expect(missing).not.toContainText('With Lite')
    // One self-test call, CORS-simple, from the sandbox's opaque origin.
    expect(innerTube).toEqual(['POST /youtubei/v1/music/get_search_suggestions null'])

    await page.goto('./')
    const intro = page.getByRole('region', { name: 'YouTube Music works here without an install' })
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
    await expect(status(page)).toContainText("Lite's check didn't pass in this browser")
    const missing = page.getByRole('region', { name: "What you're missing" })
    await expect(missing).toContainText(
      'With Lite (experimental), YouTube Music without an install',
    )
    await expect(missing).toContainText('With FXM Connect, the desktop app or the Android app')
    // Desktop Chrome: the Chromium guide comes first, open, with Developer mode's warning.
    const guide = page.locator('details').first()
    await expect(guide).toHaveAttribute('open', '')
    await expect(guide).toContainText('Leave Developer mode on')
    await expect(guide).toContainText('chrome://extensions')

    await page.goto('./')
    await expect(page.getByRole('region', { name: 'This browser plays free music' })).toBeVisible()
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

test('notices a disabled FXM Connect and points to the apps', async ({ context, page }) => {
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
  await expect(prompt).toContainText('desktop app or the Android app')
  await prompt.getByRole('link', { name: 'What to do' }).click()

  const section = next.getByRole('region', { name: "FXM Connect isn't answering" })
  await expect(section).toContainText('worked in this browser before (version 0.1.0)')
  await expect(section).toContainText('turns it off whenever Developer mode is off')
  await section.getByRole('button', { name: 'Android app' }).click()
  const android = next.locator('details', {
    has: next.getByRole('heading', { name: 'Android app' }),
  })
  await expect(android).toHaveAttribute('open', '')
  await expect(android).toContainText("Chrome on Android can't add extensions")

  await section.getByRole('button', { name: 'I removed it on purpose' }).click()
  await expect(section).toHaveCount(0)
  await expect(status(next)).toContainText("FXM Connect isn't installed in this browser.")
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
    await expect(freeDiagnostics).toContainText('It needs YouTube Music')
    await expect(
      freeDiagnostics.getByRole('button', { name: 'Resolve and play one song' }),
    ).toBeDisabled()
  })
})

test.describe('screenshots', () => {
  // Visual check, not a test: FXM_SCREENSHOTS=1 saves the onboarding page and Diagnostics in
  // each tier to apps/web/screenshots/ (gitignored).
  test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 to capture')

  const cases = [
    ['free', false, undefined],
    ['lite', true, undefined],
    ['full', false, '0.1.0'],
    ['outdated', false, '0.0.1'],
  ] as const

  for (const width of [320, 768, 1280] as const) {
    for (const theme of ['dark', 'light'] as const) {
      test(`the tiers at ${width}px, ${theme}`, async ({ browser }) => {
        for (const [name, lite, version] of cases) {
          // A fresh context per case: nothing remembered from the case before.
          const context = await browser.newContext({
            viewport: { width, height: width < 768 ? 720 : 900 },
            reducedMotion: 'reduce',
          })
          await context.addInitScript(
            (state) =>
              localStorage.setItem('fxm.settings.v1', JSON.stringify({ state, version: 1 })),
            { catalogMode: 'music', theme },
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
          await context.close()
        }
      })
    }
  }
})
