import { expect, type Page, test } from '@playwright/test'
import { seedNowPlaying } from './now-playing-seed'

// Now playing in a real browser, with a saved queue (see now-playing-seed.ts). Nothing plays:
// the stream resolver arrives with stage 2.3, so these check what works without it.

test.beforeEach(async ({ page }) => {
  await seedNowPlaying(page)
})

/** The titles of the songs up next, in order. */
function upNext(page: Page) {
  return page
    .getByRole('region', { name: 'Next up' })
    .getByRole('listitem')
    .locator('span.truncate.font-semibold')
    .allTextContents()
}

test('puts the saved queue back, with the match, the review and synced lyrics', async ({
  page,
}) => {
  await page.goto('now-playing')

  await expect(page.getByRole('heading', { level: 2, name: 'Neon Harbor' })).toBeVisible()
  await expect(page.getByText('Matched from Spotify · 0.93')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Not the right version?' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Hold the light a little longer' }).first(),
  ).toHaveAttribute('aria-current', 'true')
  await expect(
    page.getByRole('link', { name: 'Open now playing: Neon Harbor by The Midnight Lanterns' }),
  ).toBeAttached()
})

test('seeks to a lyric line', async ({ page }) => {
  await page.goto('now-playing')
  const line = page.getByRole('button', { name: 'Salt in the static, a song on repeat' })

  await line.click()

  await expect(line).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('slider', { name: 'Seek' }).first()).toHaveAttribute(
    'aria-valuetext',
    /^1:08 of /,
  )
})

test.describe('on a tall window', () => {
  // Rows near a covered edge make the list scroll while the pointer rests there.
  test.use({ viewport: { width: 1280, height: 1100 } })

  test('reorders the queue by dragging a handle, and keeps the order across a reload', async ({
    page,
  }) => {
    await page.goto('now-playing?tab=queue')
    expect(await upNext(page)).toEqual([
      'Slow Flare',
      'Glass Tides',
      'City of Pins (Official Video)',
      'Winter Radio',
      'Hollow Street',
    ])

    const handle = page.getByRole('button', { name: 'Move Slow Flare', exact: true })
    const target = page.getByRole('button', { name: 'Move Winter Radio', exact: true })
    const from = await handle.boundingBox()
    const to = await target.boundingBox()
    if (from === null || to === null) throw new Error('The handles are not laid out')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 + 8, { steps: 12 })
    await page.mouse.up()

    await expect
      .poll(() => upNext(page))
      .toEqual([
        'Glass Tides',
        'City of Pins (Official Video)',
        'Winter Radio',
        'Slow Flare',
        'Hollow Street',
      ])

    await page.reload()
    await expect
      .poll(() => upNext(page))
      .toEqual([
        'Glass Tides',
        'City of Pins (Official Video)',
        'Winter Radio',
        'Slow Flare',
        'Hollow Street',
      ])
  })
})

test('reorders the queue from the keyboard', async ({ page }) => {
  await page.goto('now-playing?tab=queue')
  const handle = page.getByRole('button', { name: 'Move Hollow Street', exact: true })

  await handle.focus()
  await page.keyboard.press('Home')

  await expect
    .poll(() => upNext(page))
    .toEqual([
      'Hollow Street',
      'Slow Flare',
      'Glass Tides',
      'City of Pins (Official Video)',
      'Winter Radio',
    ])
  await expect(page.getByRole('button', { name: 'Move Hollow Street', exact: true })).toBeFocused()
})

test('reviews a best guess in the review list', async ({ page }) => {
  await page.goto('now-playing?tab=queue')
  await expect(page.getByRole('heading', { name: '1 song needs review' })).toBeVisible()

  await page.getByRole('button', { name: 'Review', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review best guesses' })
  await expect(dialog.getByText('Glass Tides (Live)')).toBeVisible()
  await dialog.getByRole('button', { name: 'Approve the best guess for Glass Tides' }).click()

  await expect(dialog.getByText(/nothing in the queue needs review/)).toBeVisible()
  await expect(page.getByRole('heading', { name: /needs review/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  // "Review" went with the notice: focus lands on the queue, not on nothing.
  await expect(page.getByRole('heading', { name: 'Now playing', level: 3 })).toBeFocused()
})

test.describe('on a 320 px phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })

  test('fits the screen, with the lyrics and the queue', async ({ page }) => {
    for (const path of ['now-playing', 'now-playing?tab=queue']) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 2, name: 'Neon Harbor' })).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, path).toBeLessThanOrEqual(0)
    }
  })

  test('shows the current song in the mini player', async ({ page }) => {
    await page.goto('./')
    await expect(
      page
        .getByRole('region', { name: 'Player' })
        .getByRole('link', { name: 'Open now playing: Neon Harbor by The Midnight Lanterns' }),
    ).toBeVisible()
  })
})
