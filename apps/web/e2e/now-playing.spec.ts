import { expect, type Page, test } from '@playwright/test'
import { LONG_CREDITS, seedNowPlaying } from './now-playing-seed'

// Now playing in a real browser, with a saved queue (see now-playing-seed.ts). Nothing plays:
// the stream resolver arrives with stage 2.3, so these check what works without it, and that
// a song that can't play says so.

/** The titles of the songs up next, in order. */
function upNext(page: Page) {
  return page
    .getByRole('region', { name: 'Next up' })
    .getByRole('listitem')
    .locator('span.truncate.font-semibold')
    .allTextContents()
}

/** How far the page is wider than the window, in pixels. */
function horizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

const SEEDED_ORDER = [
  'Slow Flare',
  'Glass Tides',
  'City of Pins (Official Video)',
  'Winter Radio',
  'Hollow Street',
]

test.describe('with a saved queue', () => {
  test.beforeEach(async ({ page }) => {
    await seedNowPlaying(page)
  })

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

  test('makes the lyrics one Tab stop, with the arrow keys between the lines', async ({ page }) => {
    await page.goto('now-playing')
    const current = page.getByRole('button', { name: 'Hold the light a little longer' }).first()
    await expect(current).toHaveAttribute('aria-current', 'true')

    await current.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('button', { name: 'Every signal turning amber' })).toBeFocused()
    // One Tab leaves the lyrics, whatever their length.
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Current line' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'LRCLIB' })).toBeFocused()
  })

  test.describe('on a tall window', () => {
    // Rows near a covered edge make the list scroll while the pointer rests there.
    test.use({ viewport: { width: 1280, height: 1100 } })

    test('reorders the queue by dragging a handle, and keeps the order across a reload', async ({
      page,
    }) => {
      await page.goto('now-playing?tab=queue')
      // The page loads lazily: wait for the list rather than read it once.
      await expect.poll(() => upNext(page)).toEqual(SEEDED_ORDER)

      const handle = page.getByRole('button', { name: 'Move Slow Flare', exact: true })
      const target = page.getByRole('button', { name: 'Move Winter Radio', exact: true })
      const from = await handle.boundingBox()
      const to = await target.boundingBox()
      if (from === null || to === null) throw new Error('The handles are not laid out')
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 + 8, { steps: 12 })
      await page.mouse.up()

      const moved = [
        'Glass Tides',
        'City of Pins (Official Video)',
        'Winter Radio',
        'Slow Flare',
        'Hollow Street',
      ]
      await expect.poll(() => upNext(page)).toEqual(moved)
      // The click that ends the drag doesn't open the move buttons.
      await expect(page.getByRole('group', { name: 'Move Slow Flare' })).toHaveCount(0)

      await page.reload()
      await expect.poll(() => upNext(page)).toEqual(moved)
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
    await expect(
      page.getByRole('button', { name: 'Move Hollow Street', exact: true }),
    ).toBeFocused()
  })

  test('reviews a best guess in the review list', async ({ page }) => {
    await page.goto('now-playing?tab=queue')
    await expect(page.getByRole('heading', { name: '1 song needs review' })).toBeVisible()

    await page.getByRole('button', { name: 'Review', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Review best guesses' })
    await expect(dialog.getByText('Glass Tides (Live)')).toBeVisible()
    await expect(dialog.getByText('Mara Quell · 4:07 (original 4:01)')).toBeVisible()
    await dialog
      .getByRole('button', { name: 'Approve the best guess for Glass Tides' })
      .press('Enter')

    await expect(dialog.getByText(/nothing in the queue needs review/)).toBeVisible()
    await expect(page.getByRole('heading', { name: /needs review/ })).toHaveCount(0)
    // The row went with the focused button: "Done" has the focus.
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    // "Review" went with the notice: focus lands on the queue, not on nothing.
    await expect(page.getByRole('heading', { name: 'Now playing', level: 3 })).toBeFocused()
  })

  test.describe('the player bar’s Queue button', () => {
    const queueButton = (page: Page) =>
      page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Queue' })

    test('opens the queue, and pressed again closes it back to the page it opened on', async ({
      page,
    }) => {
      await page.goto('library')
      await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
      const queue = queueButton(page)
      await expect(queue).toHaveAttribute('aria-pressed', 'false')

      await queue.click()
      await expect(page).toHaveURL(/\/now-playing\?tab=queue$/)
      await expect.poll(() => upNext(page)).toEqual(SEEDED_ORDER)
      await expect(queue).toHaveAttribute('aria-pressed', 'true')

      // From the keyboard too, and the focus stays on the button.
      await queue.press('Space')
      await expect(page).toHaveURL(/\/library$/)
      await expect(page.getByRole('heading', { level: 1, name: 'Your library' })).toBeVisible()
      await expect(queue).toHaveAttribute('aria-pressed', 'false')
      await expect(queue).toBeFocused()
    })

    test('closes a queue opened straight from a link to Home, inside FXM', async ({ page }) => {
      await page.goto('now-playing?tab=queue')
      const queue = queueButton(page)
      await expect(queue).toHaveAttribute('aria-pressed', 'true')

      await queue.click()

      await expect(page).toHaveURL(/\/app\/$/)
      await expect(page.getByRole('heading', { level: 1, name: /^Good/ })).toBeVisible()
      await expect(queue).toHaveAttribute('aria-pressed', 'false')
    })
  })

  test.describe('on a laptop window', () => {
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1366, height: 768 },
    ]) {
      test.describe(`of ${viewport.width}×${viewport.height}`, () => {
        test.use({ viewport })

        test('keeps the title, the badge and the switcher above the player bar', async ({
          page,
        }) => {
          await page.goto('now-playing')
          const bar = await page.getByRole('region', { name: 'Player' }).boundingBox()
          const switcher = await page
            .getByRole('button', { name: 'Not the right version?' })
            .boundingBox()
          if (bar === null || switcher === null) throw new Error('Not laid out')
          expect(switcher.y + switcher.height).toBeLessThanOrEqual(bar.y)
          await expect(
            page.getByRole('heading', { level: 2, name: 'Neon Harbor' }),
          ).toBeInViewport()
        })
      })
    }
  })

  test.describe('on a 390 px phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('fills the screen, with the lyrics and the queue a tap away', async ({ page }) => {
      await page.goto('now-playing')
      await expect(page.getByRole('heading', { level: 2, name: 'Neon Harbor' })).toBeVisible()
      // No tab bar and no mini player: the top bar's back arrow leaves.
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Player' })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()

      await page.getByRole('region', { name: 'Track' }).getByRole('button', { name: 'Queue' }).tap()

      await expect(page).toHaveURL(/tab=queue$/)
      await expect(page.getByRole('tab', { name: 'Queue' })).toBeInViewport()
      await expect(page.getByRole('heading', { name: 'Next up' })).toBeInViewport()
    })

    test('moves a song with taps, without dragging', async ({ page }) => {
      await page.goto('now-playing?tab=queue')
      await expect.poll(() => upNext(page)).toEqual(SEEDED_ORDER)

      await page.getByRole('button', { name: 'Move Winter Radio', exact: true }).tap()
      const moves = page.getByRole('group', { name: 'Move Winter Radio' })
      await moves.getByRole('button', { name: 'Up' }).tap()

      await expect
        .poll(() => upNext(page))
        .toEqual([
          'Slow Flare',
          'Glass Tides',
          'Winter Radio',
          'City of Pins (Official Video)',
          'Hollow Street',
        ])
      await moves.getByRole('button', { name: 'Play next' }).tap()
      await expect
        .poll(() => upNext(page))
        .toEqual([
          'Winter Radio',
          'Slow Flare',
          'Glass Tides',
          'City of Pins (Official Video)',
          'Hollow Street',
        ])
    })

    test('shows why a song from the queue can’t play', async ({ page }) => {
      await page.goto('now-playing?tab=queue')
      const row = page.getByRole('button', { name: /^Play Slow Flare/ })
      await row.scrollIntoViewIfNeeded()

      await row.tap()

      // Nothing can play until stage 2.3 connects a resolver: the problem comes into view.
      await expect(page.getByText('This song can’t play here', { exact: true })).toBeInViewport()
      await expect(
        page.getByRole('region', { name: 'Now playing' }).getByText('Couldn’t play'),
      ).toBeVisible()
    })
  })
})

test.describe('on a 320 px phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true })

  test('fits the screen with a long title and three artists, with the lyrics and the queue', async ({
    page,
  }) => {
    await seedNowPlaying(page, { current: LONG_CREDITS })
    for (const path of ['now-playing', 'now-playing?tab=queue']) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 2, name: LONG_CREDITS.title })).toBeVisible()
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0)
    }
  })

  test('shows the current song in the mini player', async ({ page }) => {
    await seedNowPlaying(page)
    await page.goto('./')
    await expect(
      page
        .getByRole('region', { name: 'Player' })
        .getByRole('link', { name: 'Open now playing: Neon Harbor by The Midnight Lanterns' }),
    ).toBeVisible()
  })

  test('says in the mini player when a song couldn’t play', async ({ page }) => {
    await seedNowPlaying(page)
    await page.goto('./')
    const player = page.getByRole('region', { name: 'Player' })

    await player.getByRole('button', { name: 'Play' }).tap()

    await expect(player.getByText('Couldn’t play')).toBeVisible()
    await expect(page.getByText(/^This song can’t play here\. /)).toBeAttached()
  })
})

// The mini player: the track, then Like, Previous, Play and Next, each a 44 px target. Below
// 360 px Like makes room for the title (Now playing has it); a long title is cut short.
for (const width of [320, 360, 390]) {
  test.describe(`the mini player on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 720 }, hasTouch: true, isMobile: true })

    test('fits its controls, and steps the queue without opening Now playing', async ({ page }) => {
      await seedNowPlaying(page, { current: LONG_CREDITS })
      await page.goto('./')
      const player = page.getByRole('region', { name: 'Player' })
      const like = player.getByRole('button', { name: 'Like' })
      const narrow = width < 360
      await (narrow ? expect(like).toBeHidden() : expect(like).toBeEnabled())

      const card = await player.locator(':scope > div').boundingBox()
      const track = await player.getByRole('link').boundingBox()
      if (card === null || track === null) throw new Error('The mini player is not laid out')
      let end = track.x + track.width
      for (const name of [...(narrow ? [] : ['Like']), 'Previous', 'Play', 'Next']) {
        const box = await player.getByRole('button', { name, exact: true }).boundingBox()
        if (box === null) throw new Error(`${name} is not laid out`)
        expect(box.width, name).toBeGreaterThanOrEqual(44)
        expect(box.height, name).toBeGreaterThanOrEqual(44)
        expect(box.x, `${name} after what comes before it`).toBeGreaterThanOrEqual(end - 0.5)
        end = box.x + box.width
        expect(end, `${name} inside the card`).toBeLessThanOrEqual(card.x + card.width)
      }
      const title = player.getByText(LONG_CREDITS.title, { exact: true })
      const cut = await title.evaluate((element) => element.scrollWidth > element.clientWidth)
      expect(cut, 'the long title is cut short').toBe(true)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

      await player.getByRole('button', { name: 'Next', exact: true }).tap()
      await expect(player.getByRole('link')).toHaveAccessibleName(
        /^Open now playing: Slow Flare by Odessa Rain/,
      )
      await player.getByRole('button', { name: 'Previous', exact: true }).tap()
      await expect(player.getByRole('link')).toHaveAccessibleName(
        /^Open now playing: Neon Harbor \(Extended Night Drive Version\)/,
      )
      await expect(page).toHaveURL(/\/app\/$/)
    })
  })
}
