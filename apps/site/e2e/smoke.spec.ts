import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { AVAILABLE } from '../src/config'

// Browser checks on the production build: `pnpm --filter @fxm/site e2e`. They need
// Chromium from .tools/playwright, so `make test` does not run them.

const PAGES = [
  ['/', 200],
  ['/privacy', 200],
  ['/disclaimer', 200],
  ['/no-such-page', 404],
] as const

const USER_AGENTS = {
  android:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  bot: 'Mozilla/5.0 (compatible; ExampleBot/1.0)',
}

/** Collects uncaught errors and console errors (other than the 404 page's own status). */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('status of 404')) {
      errors.push(message.text())
    }
  })
  return errors
}

for (const [path, status] of PAGES) {
  test.describe(`${path}`, () => {
    test(`answers ${status} without errors and fits a 320 px screen`, async ({ page }) => {
      const errors = trackErrors(page)
      await page.setViewportSize({ width: 320, height: 720 })
      const response = await page.goto(path)
      expect(response?.status()).toBe(status)
      // body clips horizontal overflow as a safety net; lift it to see the real width.
      await page.addStyleTag({ content: 'body { overflow-x: visible !important; }' })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBe(0)
      expect(errors).toEqual([])
    })

    for (const colorScheme of ['dark', 'light'] as const) {
      test(`passes axe in the ${colorScheme} theme`, async ({ page }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await page.goto(path)
        // Open every FAQ answer so its content is checked too.
        await page.evaluate(() => {
          for (const details of document.querySelectorAll('details')) details.open = true
        })
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
          .analyze()
        const violations = results.violations.map(
          (violation) =>
            `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
        )
        expect(violations).toEqual([])
      })
    }
  })
}

test('the skip link comes first and moves focus to the main content', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to main content' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
})

test('follows the system colour scheme, dark first', async ({ page }) => {
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  expect(await background()).toBe('rgb(11, 11, 15)')
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await background()).toBe('rgb(246, 246, 248)')
})

test('stops the playing animation when reduced motion is on', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const animation = await page
    .locator('.eq span')
    .first()
    .evaluate((element) => getComputedStyle(element).animationName)
  expect(animation).toBe('none')
})

test.describe('the Download button', () => {
  // Only cards with something to download are suggested (AVAILABLE in src/config.ts).
  const computer = AVAILABLE.desktop ? 'get-desktop' : 'get-web'
  for (const [device, userAgent, card] of [
    ['a Windows PC', USER_AGENTS.windows, computer],
    ['a Mac', USER_AGENTS.mac, computer],
    ['an Android phone', USER_AGENTS.android, AVAILABLE.android ? 'get-android' : null],
    ['an iPhone', USER_AGENTS.iphone, null],
  ] as const) {
    test.describe(`on ${device}`, () => {
      test.use({ userAgent })

      if (card) {
        test(`points to #${card}`, async ({ page }) => {
          await page.goto('/')
          await expect(page.locator('[data-download-link]')).toHaveAttribute('href', `#${card}`)
          await expect(page.locator(`#${card}`)).toHaveClass(/is-suggested/)
          await expect(page.locator(`#${card} .for-you`)).toBeVisible()
          await expect(page.locator('.is-suggested')).toHaveCount(1)
        })
      } else {
        test('points to all the options', async ({ page }) => {
          await page.goto('/')
          await expect(page.locator('[data-download-link]')).toHaveAttribute('href', '#get')
          await expect(page.locator('.is-suggested')).toHaveCount(0)
          await expect(page.locator('.for-you').first()).toBeHidden()
        })
      }
    })
  }

  test.describe('on an unknown device', () => {
    test.use({ userAgent: USER_AGENTS.bot })

    test('points to all the options', async ({ page }) => {
      // Chromium also reports the real OS in navigator.userAgentData; hide it.
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined })
      })
      await page.goto('/')
      await expect(page.locator('[data-download-link]')).toHaveAttribute('href', '#get')
      await expect(page.locator('.is-suggested')).toHaveCount(0)
    })
  })

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false, userAgent: USER_AGENTS.android })

    test('still points to all the options', async ({ page }) => {
      await page.goto('/')
      await expect(page.locator('[data-download-link]')).toHaveAttribute('href', '#get')
      await expect(page.locator('.for-you').first()).toBeHidden()
    })
  })
})

test.describe('the main menu', () => {
  test('opens from a button on a phone and closes after a link', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(nav.locator('.links')).toBeHidden()
    await nav.locator('summary').click()
    const features = nav.locator('.menu-panel').getByRole('link', { name: 'Features' })
    await expect(features).toBeVisible()
    await features.click()
    await expect(page).toHaveURL(/#features$/)
    await expect(features).toBeHidden()
  })

  test('closes on Escape and gives focus back to its button', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await page.goto('/privacy')
    const button = page.locator('.menu summary')
    await button.click()
    await expect(page.locator('.menu-panel')).toBeVisible()
    await page.locator('.menu-panel a').first().focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.menu-panel')).toBeHidden()
    await expect(button).toBeFocused()
  })

  for (const width of [768, 1280]) {
    test(`shows the links in the header at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/privacy')
      const nav = page.getByRole('navigation', { name: 'Main' })
      for (const name of ['Features', 'How it works', 'Download', 'FAQ', 'GitHub']) {
        await expect(nav.locator('.links').getByRole('link', { name })).toBeVisible()
      }
      await expect(nav.locator('.menu')).toBeHidden()
      // Everything fits on one line.
      const overflow = await page.evaluate(() => {
        const inner = document.querySelector('.site-header .inner')
        return inner ? inner.scrollWidth - inner.clientWidth : -1
      })
      expect(overflow).toBe(0)
    })
  }
})

test('links and buttons are at least 44 px tall on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  for (const path of ['/', '/privacy', '/disclaimer']) {
    await page.goto(path)
    await page.locator('.menu summary').click()
    const small = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          'header a, header summary, footer a, .button, .services a',
        ),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          name: element.textContent?.trim() || element.getAttribute('aria-label'),
          height: Math.round(element.getBoundingClientRect().height),
        }))
        .filter((target) => target.height < 44),
    )
    expect(small, path).toEqual([])
  }
})
