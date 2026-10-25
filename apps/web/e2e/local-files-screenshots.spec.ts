import { expect, type Page, test } from '@playwright/test'
import { fillMusicFolder, songs, stubFolderPicker } from './local-files-fixture'

// Visual check, not a test, like screenshots.spec.ts: `pnpm --filter @fxm/web screenshots` saves
// the Local files tab (empty, then with songs, one playing) and "On this device" in search, at
// three widths in both themes, to apps/web/screenshots/local-files-*.png (gitignored).
test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 (pnpm screenshots) to capture')
test.describe.configure({ timeout: 120_000 })

const WIDTHS = [320, 768, 1280] as const

async function captureWidths(page: Page, name: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 720 : 860 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: `screenshots/local-files-${name}-${width}.png` })
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`captures local files in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(
      (state) => localStorage.setItem('fxm.settings.v1', JSON.stringify({ state, version: 1 })),
      { catalogMode: 'music', theme },
    )
    await stubFolderPicker(page)
    await fillMusicFolder(page)
    await page.goto('library?tab=local')
    await expect(
      page.getByRole('heading', { name: 'Play music files from this device' }),
    ).toBeVisible()
    await captureWidths(page, `${theme}-empty`)

    await page.getByRole('main').getByRole('button', { name: 'Add a folder' }).click()
    await expect(songs(page).getByRole('listitem')).toHaveCount(3)
    await songs(page).getByRole('button', { name: 'Play Slow Tide' }).click()
    await expect(songs(page).getByRole('button', { name: 'Pause Slow Tide' })).toBeVisible()
    await captureWidths(page, `${theme}-songs`)

    await page.goto('search?q=drive')
    await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible()
    await captureWidths(page, `${theme}-search`)
  })
}
