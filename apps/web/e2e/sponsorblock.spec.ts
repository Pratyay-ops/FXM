import { expect, type Page, test } from '@playwright/test'

// SponsorBlock (stage 8.7): the offer in Music + Video mode, the switch in Settings, and keyboard
// focus kept clear of the offer. Nothing here contacts SponsorBlock: nothing plays.

const OFFER = 'Skip the non-music parts of videos?'
const SWITCH = 'Skip non-music parts of videos'

async function seedMode(page: Page, catalogMode: 'music' | 'all') {
  await page.addInitScript((mode) => {
    // Only on the first load, so a test can reload and see what the app saved.
    if (sessionStorage.getItem('seeded') !== null) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem(
      'fxm.settings.v1',
      JSON.stringify({ state: { catalogMode: mode, theme: 'dark' }, version: 1 }),
    )
  }, catalogMode)
}

/** Names the focused element when it is off screen or covered (by a fixed card, say). */
function coveredFocus(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || active === document.body) return null
    const target = active.closest('label') ?? active
    const { left, top, width, height } = target.getBoundingClientRect()
    const hit = document.elementFromPoint(left + width / 2, top + height / 2)
    if (hit && (hit === target || target.contains(hit))) return null
    return active.getAttribute('aria-label') ?? active.textContent?.trim() ?? active.tagName
  })
}

test('offers SponsorBlock once in Music + Video mode', async ({ page }) => {
  await seedMode(page, 'music')
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)

  await page.goto('settings')
  await page.locator('label', { hasText: /^Music \+ Video$/ }).click()
  // Settings has the switch itself.
  await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Home', exact: true })
    .click()

  const offer = page.getByRole('region', { name: OFFER })
  await expect(offer).toBeVisible()
  await offer.getByRole('button', { name: 'Not now' }).click()
  await expect(offer).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)
  await page.goto('settings')
  await expect(page.getByRole('switch', { name: SWITCH })).not.toBeChecked()
})

test('turns skipping on from the offer, and Settings credits SponsorBlock', async ({ page }) => {
  await seedMode(page, 'all')
  await page.goto('./')
  await page.getByRole('region', { name: OFFER }).getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)
  await expect(page.getByRole('main')).toBeFocused()

  await page.goto('settings')
  await expect(page.getByRole('switch', { name: SWITCH })).toBeChecked()
  for (const name of ['Playback', 'About']) {
    const section = page.getByRole('region', { name })
    await expect(section.getByRole('link', { name: /CC BY-NC-SA 4\.0/ })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    )
    await expect(section.getByRole('link', { name: /sponsor\.ajay\.app/ })).toHaveAttribute(
      'href',
      'https://sponsor.ajay.app/',
    )
  }
})

test.describe('on a 320 px phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })

  test('fits the offer above the mini player', async ({ page }) => {
    await seedMode(page, 'all')
    await page.goto('./')
    const offer = page.getByRole('region', { name: OFFER })
    await expect(offer).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0)

    const card = await offer.boundingBox()
    const player = await page.getByRole('region', { name: 'Player' }).boundingBox()
    expect(card && player && card.y + card.height).toBeLessThanOrEqual(player?.y ?? 0)
    await offer.getByRole('button', { name: 'Not now' }).tap()
    await expect(offer).toHaveCount(0)
  })

  test('keeps keyboard focus clear of the offer', async ({ page }) => {
    await seedMode(page, 'all')
    for (const path of ['search', 'now-playing']) {
      await page.goto(path)
      await expect(page.getByRole('region', { name: OFFER })).toBeVisible()
      const covered: string[] = []
      for (let press = 0; press < 30; press++) {
        await page.keyboard.press('Tab')
        const name = await coveredFocus(page)
        if (name) covered.push(name)
      }
      expect(covered, path).toEqual([])
    }
  })
})
