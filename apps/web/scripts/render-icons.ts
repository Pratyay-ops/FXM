/**
 * Renders the app icons (pwa/icons.ts) into the PNGs in public/ with Playwright's Chromium:
 *
 *   scripts/run.sh pnpm --filter @fxm/web icons
 *
 * The PNGs are committed, so this only needs to run again when the mark changes. Chromium
 * comes from .tools/playwright (see the README).
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium } from '@playwright/test'
import { ICON_FILES, iconSvg } from '../pwa/icons.ts'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))

/** Renders an SVG into a PNG of exactly `size` pixels (a fresh page each time: resizing one
 * between screenshots can leave stale tiles in headless Chromium). */
async function render(browser: Browser, svg: string, size: number, path: string) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  })
  try {
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    )
    await mkdir(dirname(path), { recursive: true })
    await page.screenshot({ path, omitBackground: true })
  } finally {
    await page.close()
  }
}

const browser = await chromium.launch({ channel: 'chromium' })
try {
  for (const icon of ICON_FILES) {
    await render(browser, iconSvg(icon.variant), icon.size, `${publicDir}${icon.file}`)
  }
} finally {
  await browser.close()
}
console.log(`Wrote ${ICON_FILES.map((icon) => `public/${icon.file}`).join(', ')}`)
