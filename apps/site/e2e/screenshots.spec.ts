import { type Page, test } from '@playwright/test'

// Visual check, not a test: `pnpm --filter @fxm/site screenshots` saves every page at
// three widths in both themes to apps/site/screenshots/ (gitignored). Tall pages are
// also saved in slices, and the home page section by section, which are easier to
// review than one very tall image.
test.skip(!process.env.FXM_SCREENSHOTS, 'Set FXM_SCREENSHOTS=1 (pnpm screenshots) to capture')

const WIDTHS = [320, 768, 1280] as const
const THEMES = ['dark', 'light'] as const
const PAGES = [
  ['home', '/'],
  ['privacy', '/privacy'],
  ['disclaimer', '/disclaimer'],
  ['not-found', '/no-such-page'],
] as const

async function captureSlices(page: Page, path: string, sliceHeight: number) {
  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
  }))
  for (let y = 0, index = 1; y < height; y += sliceHeight, index++) {
    const clip = { x: 0, y, width, height: Math.min(sliceHeight, height - y) }
    await page.screenshot({
      path: `${path}-${String(index).padStart(2, '0')}.png`,
      fullPage: true,
      clip,
    })
  }
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} at ${width}px`, () => {
      const height = width < 768 ? 720 : 900
      test.use({
        colorScheme: theme,
        viewport: { width, height },
        hasTouch: width < 1024,
        reducedMotion: 'reduce', // freezes the playing indicator
      })

      test('captures every page', async ({ page }) => {
        const prefix = `screenshots/${theme}-${width}`
        for (const [name, path] of PAGES) {
          await page.goto(path)
          await page.screenshot({ path: `${prefix}-${name}.png`, fullPage: true })
          await captureSlices(page, `${prefix}-${name}-slice`, height * 2)
        }

        await page.goto('/')
        // Keep the sticky header from covering the sections.
        await page.addStyleTag({ content: '.site-header { position: static !important; }' })
        const sections = page.locator('main > section')
        for (let index = 0; index < (await sections.count()); index++) {
          const section = sections.nth(index)
          const id = (await section.getAttribute('id')) ?? 'section'
          await section.screenshot({ path: `${prefix}-home-${index + 1}-${id}.png` })
        }
      })
    })
  }
}
