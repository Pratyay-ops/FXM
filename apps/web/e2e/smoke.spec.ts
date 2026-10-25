import { expect, type Page, test } from '@playwright/test'

// Paths are relative to the /app/ base URL (see playwright.config.ts).
const PAGES = [
  './',
  'search',
  'search?q=lofi%20beats',
  'library',
  'album/ytm:MPREb_42',
  'artist/ytm:UC-daft',
  'playlist/liked',
  'now-playing',
  'settings',
  'no-such-page',
]

const GREETING = /^Good (morning|afternoon|evening)$/

function horizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

/** Names the focused element when it is off screen or covered (by the fixed bars, say). */
function coveredFocus(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || active === document.body) return null
    // Visually hidden radios (segmented controls) show through their label.
    const target = active.closest('label') ?? active
    const { left, top, width, height } = target.getBoundingClientRect()
    const hit = document.elementFromPoint(left + width / 2, top + height / 2)
    if (hit && (hit === target || target.contains(hit))) return null
    return active.getAttribute('aria-label') ?? active.textContent?.trim() ?? active.tagName
  })
}

/** Presses Tab `presses` times and lists the focused elements that were hidden. */
async function tabAndCollectCovered(page: Page, presses: number) {
  const covered: string[] = []
  for (let press = 0; press < presses; press++) {
    await page.keyboard.press('Tab')
    const name = await coveredFocus(page)
    if (name) covered.push(name)
  }
  return covered
}

test('navigates the shell from the sidebar', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
  const nav = page.getByRole('navigation', { name: 'Main' })

  await nav.getByRole('link', { name: 'Library' }).click()

  await expect(page).toHaveURL(/\/app\/library$/)
  await expect(nav.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
})

test('links Home to /app/, which survives a reload', async ({ page }) => {
  await page.goto('library')
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Home', exact: true })
    .click()
  await expect(page).toHaveURL(/\/app\/$/)

  await page.reload()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(GREETING)
})

test('searches from the top bar, one Back away from where it started', async ({ page }) => {
  await page.goto('library')
  // Real keystrokes, as fast as Playwright types: each one must not add a history entry.
  await page
    .getByRole('banner')
    .getByRole('searchbox', { name: 'Search' })
    .pressSequentially('daft punk')
  await expect(page).toHaveURL(/\/app\/search\?q=daft%20punk$/)
  await expect(page.getByRole('heading', { name: 'Results for “daft punk”' })).toBeVisible()

  await page.goBack()

  await expect(page).toHaveURL(/\/app\/library$/)
})

test('skips to the page content without breaking Back', async ({ page }) => {
  await page.goto('./')
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()

  await page.getByRole('link', { name: 'Skip to content' }).focus()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('main')).toBeFocused()
  await expect(page).toHaveURL(/\/app\/library$/)
  await expect(page.getByRole('button', { name: 'Go back' })).toBeEnabled()
})

test('keeps the catalog mode and theme across a reload', async ({ page }) => {
  await page.goto('settings')
  await page.locator('label', { hasText: 'Music + Video' }).click()
  await page.locator('label', { hasText: /^Light$/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()

  await expect(page.getByRole('radio', { name: 'Music + Video' })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('link', { name: /Catalog mode: Music \+ Video/ })).toBeVisible()
})

test.describe('on a short desktop window', () => {
  test.use({ viewport: { width: 1280, height: 680 } })

  test('keeps keyboard focus clear of the top bar and player bar', async ({ page }) => {
    await page.goto('settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()

    expect(await tabAndCollectCovered(page, 30)).toEqual([])

    // Back from the player bar to the last link of the page, which sits behind the bar.
    await page.getByRole('region', { name: 'Player' }).getByRole('link').first().focus()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('link', { name: /Source on GitHub/ })).toBeFocused()
    expect(await coveredFocus(page)).toBeNull()
  })
})

test.describe('on a 320 px phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })

  test('nothing overflows horizontally', async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached()
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0)
    }
  })

  test('keeps keyboard focus clear of the mini player and tab bar', async ({ page }) => {
    await page.goto('search')
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached()

    expect(await tabAndCollectCovered(page, 30)).toEqual([])
  })

  test('uses the tab bar and opens Now Playing from the mini player', async ({ page }) => {
    await page.goto('./')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' }).tap()
    await expect(page).toHaveURL(/\/app\/search$/)

    await page.getByRole('region', { name: 'Player' }).getByRole('link').tap()

    await expect(page).toHaveURL(/\/app\/now-playing$/)
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  })
})
