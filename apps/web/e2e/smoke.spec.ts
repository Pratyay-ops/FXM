import { expect, type Page, test } from '@playwright/test'

// Paths are relative to the /app/ base URL (see playwright.config.ts).
const PAGES = [
  './',
  'search',
  'search?q=lofi%20beats',
  'library',
  'album/MPREb_42',
  'artist/UC-daft',
  'playlist/liked',
  'now-playing',
  'settings',
  'no-such-page',
]

function horizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

test('navigates the shell from the sidebar', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /^Good (morning|afternoon|evening)$/,
  )
  const nav = page.getByRole('navigation', { name: 'Main' })

  await nav.getByRole('link', { name: 'Library' }).click()

  await expect(page).toHaveURL(/\/app\/library$/)
  await expect(nav.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
})

test('searches from the top bar', async ({ page }) => {
  await page.goto('library')
  await page.getByRole('banner').getByRole('searchbox', { name: 'Search' }).fill('daft punk')
  await expect(page).toHaveURL(/\/app\/search\?q=daft%20punk$/)
  await expect(page.getByRole('heading', { name: 'Results for “daft punk”' })).toBeVisible()
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

test.describe('on a 320 px phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })

  test('nothing overflows horizontally', async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached()
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0)
    }
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
