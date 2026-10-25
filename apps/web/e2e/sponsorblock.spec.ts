import { expect, type Page, test } from '@playwright/test'
import { SEED_QUEUE } from './now-playing-seed'

// SponsorBlock (stage 8.7): the offer in Music + Video mode, the switch in Settings, the notice
// after a skip, and keyboard focus and controls kept clear of the cards. Nothing here contacts
// SponsorBlock: the one test that plays answers its lookup itself.

const OFFER = 'Skip non-music parts of videos?'
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

/** The made-up music video the seeded queue starts with, as the app stores it. */
const VIDEO_ID = 'cItYoFpInS3'

/**
 * Music + Video mode, a saved queue paused at the start of a music video, and a SponsorBlock
 * that marks its first 12 s as non-music. Skipping is on, unless `skipping` is false: then the
 * offer is still unanswered. Returns the lookups it answered.
 */
async function seedSkippingVideo(page: Page, { skipping = true } = {}): Promise<URL[]> {
  const queue = { ...SEED_QUEUE, index: 4, playedUids: [], mode: 'all' }
  await page.addInitScript(
    ({ saved, on }) => {
      if (sessionStorage.getItem('seeded') !== null) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem(
        'fxm.settings.v1',
        JSON.stringify({ state: { catalogMode: 'all', theme: 'dark' }, version: 1 }),
      )
      if (on) {
        localStorage.setItem(
          'fxm.sponsorblock.v1',
          JSON.stringify({ state: { enabled: true, offered: true, offerShown: true }, version: 1 }),
        )
      }
      localStorage.setItem('fxm.queue.v1', JSON.stringify(saved))
      localStorage.setItem(
        'fxm.playback.v1',
        JSON.stringify({ positionMs: 0, volume: 0.8, muted: false }),
      )
    },
    { saved: queue, on: skipping },
  )
  const lookups: URL[] = []
  await page.route('https://sponsor.ajay.app/**', (route) => {
    lookups.push(new URL(route.request().url()))
    return route.fulfill({
      json: [
        {
          videoID: VIDEO_ID,
          segments: [
            {
              category: 'music_offtopic',
              actionType: 'skip',
              segment: [0, 12],
              UUID: 'e2e',
              videoDuration: 262,
            },
          ],
        },
      ],
      headers: { 'access-control-allow-origin': '*' },
    })
  })
  return lookups
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

/** Whether a tap at the centre of Now playing's Play/Pause button reaches it. */
function playPauseHittable(page: Page) {
  return page.evaluate(() => {
    const track = document.querySelector('section[aria-label="Track"]')
    const button = track?.querySelector<HTMLElement>(
      'button[aria-label="Play"], button[aria-label="Pause"]',
    )
    if (!button) return false
    const { left, top, width, height } = button.getBoundingClientRect()
    const hit = document.elementFromPoint(left + width / 2, top + height / 2)
    return hit !== null && (hit === button || button.contains(hit))
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
  await offer.getByRole('button', { name: 'No thanks' }).click()
  await expect(offer).toHaveCount(0)
  await expect(page.getByText('Skipping stays off.', { exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: 'SponsorBlock' })).toHaveText(
    'Skipping stays off. You can turn it on in Settings.',
  )

  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)
  await page.goto('settings')
  await expect(page.getByRole('switch', { name: SWITCH })).not.toBeChecked()
})

test('offers it in the first Music + Video session only', async ({ page, context }) => {
  await seedMode(page, 'all')
  await page.goto('./')
  await expect(page.getByRole('region', { name: OFFER })).toBeVisible()
  // The same session, after a reload: still offered.
  await page.reload()
  await expect(page.getByRole('region', { name: OFFER })).toBeVisible()

  // A new tab is another session: the choice is left to Settings.
  const other = await context.newPage()
  await other.goto('./')
  await expect(other.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(other.getByRole('region', { name: OFFER })).toHaveCount(0)
})

test('turns skipping on from the offer, and Settings credits SponsorBlock', async ({ page }) => {
  await seedMode(page, 'all')
  await page.goto('./')
  await page.getByRole('region', { name: OFFER }).getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)
  await expect(page.getByRole('main')).toBeFocused()
  await expect(page.getByText('Skipping is on.', { exact: true })).toBeVisible()

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
    // Compact: the title, one sentence and the buttons.
    expect(card?.height).toBeLessThanOrEqual(180)
    await offer.getByRole('button', { name: 'No thanks' }).tap()
    await expect(offer).toHaveCount(0)
  })

  test('fits the skip notice under Now playing’s controls without widening the page', async ({
    page,
  }) => {
    await seedSkippingVideo(page)
    await page.goto('now-playing')
    const track = page.getByRole('region', { name: 'Track' })
    await track.getByRole('button', { name: 'Play' }).tap()
    await expect(track.getByRole('region', { name: 'Skipped the intro' })).toBeVisible()

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0)
    expect(await playPauseHittable(page)).toBe(true)
  })

  test('keeps keyboard focus clear of the offer', async ({ page }) => {
    await seedMode(page, 'all')
    for (const path of ['search', 'library']) {
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

test.describe('on a 390 px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('keeps the offer small, and off Now playing', async ({ page }) => {
    await seedSkippingVideo(page, { skipping: false })
    await page.goto('./')
    const card = await page.getByRole('region', { name: OFFER }).boundingBox()
    expect(card?.height).toBeLessThanOrEqual(140)

    await page.goto('now-playing')
    await expect(
      page.getByRole('region', { name: 'Track' }).getByRole('heading', { name: /City of Pins/ }),
    ).toBeVisible()
    await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)
    expect(await playPauseHittable(page)).toBe(true)
  })

  test('shows the skip notice under Now playing’s controls, which stay clear', async ({ page }) => {
    const lookups = await seedSkippingVideo(page)
    await page.goto('now-playing')
    const track = page.getByRole('region', { name: 'Track' })
    await expect(track.getByRole('heading', { name: /City of Pins/ })).toBeVisible()
    // Asked by hash prefix only, before anything plays.
    await expect.poll(() => lookups.length).toBe(1)
    expect(lookups[0]?.pathname).toMatch(/^\/api\/skipSegments\/[0-9a-f]{4}$/)
    expect(lookups[0]?.href).not.toContain(VIDEO_ID)

    await track.getByRole('button', { name: 'Play' }).tap()

    const notice = track.getByRole('region', { name: 'Skipped the intro' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('City of Pins (Official Video)')
    await expect(page.getByRole('slider', { name: 'Seek' }).first()).toHaveAttribute(
      'aria-valuetext',
      /^0:12 of /,
    )
    expect(await playPauseHittable(page)).toBe(true)
    const box = await notice.boundingBox()
    const next = await track.getByRole('button', { name: 'Next' }).boundingBox()
    expect(box && next && box.y).toBeGreaterThanOrEqual((next?.y ?? 0) + (next?.height ?? 0))

    // From the controls to Undo and back: focus returns to where it came from.
    const repeat = track.getByRole('button', { name: 'Enable repeat' })
    await repeat.focus()
    await page.keyboard.press('Tab')
    await expect(notice.getByRole('button', { name: 'Undo' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(notice).toHaveCount(0)
    await expect(repeat).toBeFocused()
    await expect(page.getByRole('slider', { name: 'Seek' }).first()).toHaveAttribute(
      'aria-valuetext',
      /^0:00 of /,
    )
  })
})

test.describe('on a short window', () => {
  // A small phone held sideways: no room for the offer between the bars.
  test.use({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true })

  test('waits with the offer until there is room for it', async ({ page }) => {
    await seedMode(page, 'all')
    await page.goto('./')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('region', { name: OFFER })).toHaveCount(0)

    await page.setViewportSize({ width: 320, height: 568 })
    await expect(page.getByRole('region', { name: OFFER })).toBeVisible()
  })
})
