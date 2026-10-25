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

// Music + Video widens the player bar's mode chip and adds the Videos result tab.
const MODE_WIDTHS = [768, 1024, 1280] as const
const MODE_PAGES = [
  ['home', './'],
  ['results', 'search?q=daft%20punk'],
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

async function capture(page: Page, pages: readonly (readonly [string, string])[], prefix: string) {
  for (const [name, path] of pages) {
    await page.goto(path)
    await page.getByRole('heading', { level: 1 }).waitFor({ state: 'attached' })
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
  ['results-lite', 'search?q=owl&fake=lite', 'Rooftop Radio'],
  ['results-free', 'search?q=owl&fake=free', 'Set up YouTube Music'],
  ['album', 'album/ytm:alb-neon-harbor?fake=full', 'Last Ferry Home'],
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

  test('captures the sliders, segmented controls and tabs', async ({ page }) => {
    await seedSettings(page, 'all', 'dark')
    await capture(
      page,
      [
        ['settings', 'settings'],
        ['results', 'search?q=daft%20punk'],
        ['now-playing', 'now-playing?tab=queue'],
      ],
      'forced-colors-1280',
    )
  })
})
