import { type Page, test } from '@playwright/test'
import { seedNowPlaying } from './now-playing-seed'

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
  ['album', 'album/MPREb_42'],
  ['artist', 'artist/UC-daft'],
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

// Now playing in use: a saved queue with a match, a best guess to review and synced lyrics
// (now-playing-seed.ts), plus its dialogs.
const NOW_PLAYING_WIDTHS = [320, 768, 1280] as const

async function captureNowPlaying(page: Page, prefix: string) {
  const shoot = (name: string) => page.screenshot({ path: `screenshots/${prefix}-${name}.png` })
  // Phones show the panels under the track: scroll the tabs up to the top bar.
  const scrollToPanels = () =>
    page.getByRole('tablist', { name: 'Now playing panels' }).evaluate((tabs) => {
      tabs.scrollIntoView({ block: 'start' })
    })

  await page.goto('now-playing')
  await page.getByRole('button', { name: 'Hold the light a little longer' }).first().waitFor()
  await shoot('now-playing')
  await scrollToPanels()
  await shoot('now-playing-lyrics')
  await page.getByRole('button', { name: 'YouTube Music', exact: true }).click()
  await page.getByRole('button', { name: 'Not the right version?' }).click()
  await page.getByRole('dialog', { name: 'Choose the right version' }).waitFor()
  await shoot('now-playing-versions')

  await page.goto('now-playing?tab=queue')
  await page.getByRole('heading', { name: 'Next up' }).waitFor()
  await scrollToPanels()
  await shoot('now-playing-queue')
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await page.getByRole('dialog', { name: 'Review best guesses' }).waitFor()
  await shoot('now-playing-review')
}

for (const theme of THEMES) {
  for (const width of NOW_PLAYING_WIDTHS) {
    test.describe(`${theme} at ${width}px with a queue`, () => {
      test.use(viewport(width))

      test('captures Now playing in use', async ({ page }) => {
        await seedSettings(page, 'music', theme)
        await seedNowPlaying(page)
        await captureNowPlaying(page, `${theme}-${width}`)
      })
    })
  }
}

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

  test('captures Now playing in use: the badges, the queue, the switch and the lyrics', async ({
    page,
  }) => {
    await seedSettings(page, 'music', 'dark')
    await seedNowPlaying(page)
    await captureNowPlaying(page, 'forced-colors-1280')
  })
})
