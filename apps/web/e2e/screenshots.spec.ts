import { expect, type Page, test } from '@playwright/test'

// Visual check, not a test: `pnpm --filter @fxm/web screenshots` saves every page at
// several widths in both themes to apps/web/screenshots/ (gitignored).
test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 (pnpm screenshots) to capture')

type Theme = 'dark' | 'light'
type CatalogMode = 'music' | 'all'

const THEMES: readonly Theme[] = ['dark', 'light']
const WIDTHS = [320, 768, 1280, 1920] as const
const PAGES = [
  ['home', './'],
  ['search', 'search'],
  ['results', 'search?q=daft%20punk'],
  ['library', 'library'],
  ['album', 'album/ytm:MPREb_42'],
  ['artist', 'artist/ytm:UC-daft'],
  ['playlist', 'playlist/liked'],
  ['now-playing', 'now-playing'],
  ['settings', 'settings'],
  ['not-found', 'no-such-page'],
] as const

// Music + Video widens the player bar's mode chip and adds the Videos result tab, which needs
// results: the fake catalog (see below) gives them. The third entry is text to wait for.
const MODE_WIDTHS = [768, 1024, 1280] as const
const MODE_PAGES = [
  ['home', './'],
  ['results', 'search?q=paper%20moons&fake=full', 'Paper Moons (Radio Edit)'],
] as const

function viewport(width: number) {
  return {
    viewport: { width, height: width < 768 ? 720 : 860 },
    hasTouch: width < 1024,
    reducedMotion: 'reduce', // freezes the skeleton shimmer
  } as const
}

async function seedSettings(page: Page, catalogMode: CatalogMode, theme: Theme) {
  await page.addInitScript(
    (state) => localStorage.setItem('fxm.settings.v1', JSON.stringify({ state, version: 1 })),
    { catalogMode, theme },
  )
}

async function capture(
  page: Page,
  pages: readonly (readonly [name: string, path: string, ready?: string])[],
  prefix: string,
) {
  for (const [name, path, ready] of pages) {
    await page.goto(path)
    await page.getByRole('heading', { level: 1 }).waitFor({ state: 'attached' })
    if (ready) await page.getByText(ready).first().waitFor()
    await page.screenshot({ path: `screenshots/${prefix}-${name}.png` })
  }
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} at ${width}px`, () => {
      test.use(viewport(width))

      test('captures every page', async ({ page }) => {
        await seedSettings(page, 'music', theme)
        await capture(page, PAGES, `${theme}-${width}`)
        await page.goto('./')
        await page.screenshot({
          path: `screenshots/${theme}-${width}-home-full.png`,
          fullPage: true,
        })
      })
    })
  }

  for (const width of MODE_WIDTHS) {
    test.describe(`${theme} at ${width}px in Music + Video mode`, () => {
      test.use(viewport(width))

      test('captures the player bar and the result tabs', async ({ page }) => {
        await seedSettings(page, 'all', theme)
        await capture(page, MODE_PAGES, `${theme}-${width}-all`)
      })
    })
  }
}

// Search and browse with the fake catalog (src/features/search/dev-fakes.ts): `pnpm screenshots`
// builds with VITE_FXM_FAKE_CATALOG=on, and `?fake=<tier>` picks the tier. Each entry names the
// text that shows the page has loaded.
const CATALOG_WIDTHS = [320, 768, 1280] as const
const CATALOG_PAGES = [
  ['results', 'search?q=harbor&fake=full', 'Afterglow Avenue'],
  // Four sources to pick from, as once stage 1.6 is wired in: the switch must still fit.
  ['results-sources', 'search?q=harbor&fake=full&fake-sources=all', 'Afterglow Avenue'],
  ['results-lite', 'search?q=owl&fake=lite', 'Rooftop Radio'],
  ['results-free', 'search?q=owl&fake=free', 'Search needs YouTube Music access'],
  ['search-free', 'search?fake=free', 'Search needs YouTube Music access'],
  ['album', 'album/ytm:alb-neon-harbor?fake=full', 'Last Ferry Home'],
  ['album-lite', 'album/ytm:alb-neon-harbor?fake=lite', 'Lite mode, experimental'],
  ['artist', 'artist/ytm:art-nova-lane?fake=full', 'Fans also like'],
  ['playlist', 'playlist/ytm:pl-late-night-drive?fake=full', 'Neon Prayer'],
  ['album-free', 'album/ytm:alb-neon-harbor?fake=free', 'This album is on YouTube Music'],
  ['spotify-unreachable', 'album/spotify:alb-owl-hours?fake=lite', 'This album is on Spotify'],
] as const

for (const theme of THEMES) {
  for (const width of CATALOG_WIDTHS) {
    test.describe(`catalog, ${theme} at ${width}px`, () => {
      test.use(viewport(width))

      test('captures search and browse with the fake catalog', async ({ page }) => {
        await seedSettings(page, 'music', theme)
        for (const [name, path, ready] of CATALOG_PAGES) {
          await page.goto(path)
          await page.getByText(ready).first().waitFor()
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          )
          expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(0)
          await page.screenshot({
            path: `screenshots/${theme}-${width}-catalog-${name}.png`,
            fullPage: true,
          })
        }

        await page.goto('album/ytm:alb-neon-harbor?fake=full')
        await page.getByRole('button', { name: 'More options for Neon Harbor' }).click()
        await page.getByRole('menu').waitFor()
        await page.screenshot({ path: `screenshots/${theme}-${width}-catalog-menu.png` })
        await page.getByRole('menuitem', { name: 'Add to playlist…' }).click()
        await page.getByRole('button', { name: /^Workout/ }).waitFor()
        await page.screenshot({ path: `screenshots/${theme}-${width}-catalog-dialog.png` })
      })
    })
  }
}

// A small phone: the search page's header must leave room for results above the mini player.
test.describe('catalog on a 375 × 667 phone', () => {
  test.use({ ...viewport(375), viewport: { width: 375, height: 667 } })

  test('shows at least three whole results without scrolling', async ({ page }) => {
    await seedSettings(page, 'music', 'dark')
    for (const [name, path] of [
      ['results', 'search?q=harbor&fake=full'],
      ['results-sources', 'search?q=harbor&fake=full&fake-sources=all'],
    ] as const) {
      await page.goto(path)
      await page.getByText('Afterglow Avenue').first().waitFor()
      await page.getByRole('navigation', { name: 'Search suggestions' }).waitFor()
      await page.screenshot({ path: `screenshots/dark-375-catalog-${name}.png` })
      const whole = await page.evaluate(() => {
        const rows = document.querySelectorAll('ul[aria-label="Songs"] > li')
        // The mini player's card (the desktop player bar, also a "Player", is hidden here).
        const card = [...document.querySelectorAll('section[aria-label="Player"] > div')]
          .map((element) => element.getBoundingClientRect())
          .find((rect) => rect.height > 0)
        const bottom = card?.top ?? window.innerHeight
        return [...rows].filter((row) => {
          const { top, bottom: end } = row.getBoundingClientRect()
          return top >= 0 && end <= bottom
        }).length
      })
      expect(whole, `${path}: whole rows above the mini player`).toBeGreaterThanOrEqual(3)
    }
  })
})

// Links in a row sit in a box that truncates (overflow: hidden), which cuts off a focus ring
// drawn outside them: theirs must be drawn inside.
test.describe('catalog keyboard focus at 1280px', () => {
  test.use(viewport(1280))

  test('draws the focus ring of a link in a row inside the box that clips it', async ({ page }) => {
    await page.goto('search?q=harbor&fake=full')
    const play = page.getByRole('button', { name: 'Play Harbor Lights by Nova Lane' })
    await play.focus()
    await page.keyboard.press('Tab')
    // Polled: the focus styles may apply a frame after the key press.
    const ring = () =>
      page.evaluate(() => {
        const link = document.activeElement
        if (!(link instanceof HTMLAnchorElement)) return { focused: link?.tagName ?? null }
        const style = getComputedStyle(link)
        const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset)
        let clip = link.parentElement
        while (clip && getComputedStyle(clip).overflow === 'visible') clip = clip.parentElement
        const box = link.getBoundingClientRect()
        const area = clip?.getBoundingClientRect()
        const inside =
          area === undefined ||
          (box.left - reach >= area.left - 0.5 &&
            box.right + reach <= area.right + 0.5 &&
            box.top - reach >= area.top - 0.5 &&
            box.bottom + reach <= area.bottom + 0.5)
        return { focused: link.textContent, outline: style.outlineStyle, inside }
      })
    await expect.poll(ring).toEqual({ focused: 'Nova Lane', outline: 'solid', inside: true })
  })
})

test.describe('catalog in Music + Video mode at 1280px', () => {
  test.use(viewport(1280))

  test('captures video results', async ({ page }) => {
    await seedSettings(page, 'all', 'dark')
    await page.goto('search?q=paper%20moons&fake=full')
    await page.getByRole('tab', { name: 'Videos' }).click()
    await page.getByText('Live at the Lantern').first().waitFor()
    await page.screenshot({ path: 'screenshots/dark-1280-all-catalog-videos.png' })
  })
})

test.describe('forced colors (Windows High Contrast) at 1280px', () => {
  test.use({ ...viewport(1280), forcedColors: 'active' })

  test('captures the sliders, segmented controls, source chips and tabs', async ({ page }) => {
    await seedSettings(page, 'all', 'dark')
    await capture(
      page,
      [
        ['settings', 'settings'],
        ['results', 'search?q=harbor&fake=full&fake-sources=all', 'Afterglow Avenue'],
        ['now-playing', 'now-playing?tab=queue'],
      ],
      'forced-colors-1280',
    )
  })
})
