import { test } from '@playwright/test'

// Visual check, not a test: `pnpm --filter @fxm/web screenshots` saves every page
// at three widths in both themes to apps/web/screenshots/ (gitignored).
test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 (pnpm screenshots) to capture')

const WIDTHS = [320, 768, 1280] as const
const THEMES = ['dark', 'light'] as const
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

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} at ${width}px`, () => {
      test.use({
        viewport: { width, height: width < 768 ? 720 : 860 },
        hasTouch: width < 1024,
        reducedMotion: 'reduce', // freezes the skeleton shimmer
      })

      test('captures every page', async ({ page }) => {
        await page.addInitScript((value) => {
          const settings = { state: { catalogMode: 'music', theme: value }, version: 1 }
          localStorage.setItem('fxm.settings.v1', JSON.stringify(settings))
        }, theme)
        for (const [name, path] of PAGES) {
          await page.goto(path)
          await page.getByRole('heading', { level: 1 }).waitFor({ state: 'attached' })
          await page.screenshot({ path: `screenshots/${theme}-${width}-${name}.png` })
        }
        await page.goto('./')
        await page.screenshot({
          path: `screenshots/${theme}-${width}-home-full.png`,
          fullPage: true,
        })
      })
    })
  }
}
