import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

// Visual check, not a test: `pnpm --filter @fxm/web screenshots` saves every page at
// several widths in both themes to apps/web/screenshots/ (gitignored).
test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 (pnpm screenshots) to capture')
// Each test visits a dozen pages or more; leave room for a busy machine.
test.describe.configure({ timeout: 180_000 })

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

// The library after restoring e2e/fixtures/library-backup.json (fictional songs).
const LIBRARY_BACKUP = fileURLToPath(new URL('./fixtures/library-backup.json', import.meta.url))
const LIBRARY_PAGES = [
  ['library-playlists', 'library'],
  ['library-liked', 'library?tab=liked'],
  ['library-downloads', 'library?tab=downloads'],
  ['library-artists', 'library?tab=artists'],
  ['library-albums', 'library?tab=albums'],
  ['library-recent', 'library?tab=recent'],
  ['playlist-local', 'playlist/local:playlist:6f1c2d3e-0000-4000-8000-000000000001'],
  // Shuffled earlier: shows the Undo notice.
  ['playlist-shuffled', 'playlist/local:playlist:6f1c2d3e-0000-4000-8000-000000000002'],
] as const

async function restoreLibrary(page: Page) {
  await page.goto('library')
  await page.getByRole('main').getByRole('button', { name: 'Backup' }).click()
  const dialog = page.getByRole('dialog', { name: 'Back up your library' })
  await dialog.getByLabel('Choose a backup file').setInputFiles(LIBRARY_BACKUP)
  await dialog.getByRole('radio', { name: /Replace/ }).check()
  await dialog.getByRole('button', { name: 'Replace my library' }).click()
  await expect(page.getByText('Library replaced from the backup')).toBeVisible()
}

/** The library's interactive states: a sort view, select mode, a row menu, the backup dialog. */
async function captureLibraryStates(page: Page, prefix: string) {
  await page.goto('playlist/local:playlist:6f1c2d3e-0000-4000-8000-000000000001')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Sort: Custom order' }).click()
  await page.getByRole('menuitemradio', { name: 'Title' }).click()
  await page.screenshot({ path: `screenshots/${prefix}-playlist-sorted.png` })
  await main.getByRole('button', { name: 'Show custom order' }).click()
  await main.getByRole('button', { name: 'Select' }).click()
  await main.getByRole('checkbox', { name: 'Select Copper Sun' }).check()
  await main.getByRole('checkbox', { name: 'Select Static Bloom' }).check()
  await page.screenshot({ path: `screenshots/${prefix}-playlist-select.png` })
  await main.getByRole('button', { name: 'Select', pressed: true }).click()
  await main.getByRole('button', { name: 'More options for Gravity Letters' }).click()
  await page.getByRole('menu').waitFor()
  await page.screenshot({ path: `screenshots/${prefix}-playlist-menu.png` })
  await page.keyboard.press('Escape')
  await page.goto('library')
  await page.getByRole('main').getByRole('button', { name: 'Backup' }).click()
  await page.getByRole('dialog', { name: 'Back up your library' }).waitFor()
  await page.screenshot({ path: `screenshots/${prefix}-backup-dialog.png` })
}

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

/** Waits for the parts of the shell that load just after it: the like button, the playlists. */
async function waitForShell(page: Page) {
  await expect(page.getByRole('button', { name: 'Like' }).first()).toBeEnabled()
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.getByRole('region', { name: 'Your playlists' }).getByRole('link').first().waitFor()
  }
}

async function capture(page: Page, pages: readonly (readonly [string, string])[], prefix: string) {
  for (const [name, path] of pages) {
    await page.goto(path)
    await page.getByRole('heading', { level: 1 }).waitFor({ state: 'attached' })
    await waitForShell(page)
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

      test('captures the library with songs in it', async ({ page }) => {
        await seedSettings(page, 'music', theme)
        await restoreLibrary(page)
        await capture(page, LIBRARY_PAGES, `${theme}-${width}`)
        await captureLibraryStates(page, `${theme}-${width}`)
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

test.describe('forced colors (Windows High Contrast) at 1280px', () => {
  test.use({ ...viewport(1280), forcedColors: 'active' })

  test("captures Home's onboarding, with artists and genres picked", async ({ page }) => {
    test.skip(
      process.env.VITE_FXM_FAKE_CATALOG !== 'on',
      "Home's development fakes need a build with VITE_FXM_FAKE_CATALOG=on",
    )
    await seedSettings(page, 'music', 'dark')
    await page.goto('./?fake-home=lite')
    const onboarding = page.getByRole('region', { name: 'What do you like to listen to?' })
    await onboarding.getByRole('button', { name: 'Aurora Lane' }).click()
    await onboarding.getByRole('button', { name: 'Jazz' }).click()
    await onboarding.screenshot({ path: 'screenshots/forced-colors-1280-onboarding.png' })
  })

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
