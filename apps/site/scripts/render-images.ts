/**
 * Renders the PNG icons and the social card with Playwright's Chromium:
 *
 *   scripts/run.sh pnpm --filter @fxm/site images
 *
 * The PNGs in public/ are committed, so this only needs to run again when the mark
 * (public/favicon.svg) or the card below changes. Chromium comes from .tools/playwright
 * (see docs/DEVELOPMENT.md).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium } from '@playwright/test'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const mark = await readFile(`${publicDir}favicon.svg`, 'utf8')
// iOS rounds the corners of home screen icons itself, so that one is a full square.
const squareMark = mark.replace(' rx="9" fill="url(#g)"', ' fill="url(#g)"')
if (squareMark === mark) throw new Error('favicon.svg changed: update the rx replacement')

const FONT =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

/** Renders HTML into a PNG of exactly this size (a fresh page each time: resizing one between
 * screenshots can leave stale tiles in headless Chromium). */
async function render(browser: Browser, html: string, width: number, height: number, file: string) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  try {
    await page.setContent(html)
    await page.screenshot({ path: `${publicDir}${file}`, omitBackground: true })
  } finally {
    await page.close()
  }
}

function icon(svg: string, size: number): string {
  return `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
}

// 1200×630 social card: the mark, the tagline and the address.
const card = `<!doctype html>
<html lang="en">
<style>
  html, body { margin: 0; }
  body {
    position: relative;
    box-sizing: border-box;
    width: 1200px;
    height: 630px;
    overflow: hidden;
    padding: 72px 80px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background: #0b0b0f;
    color: #f5f5f7;
    font-family: ${FONT};
  }
  .bars {
    position: absolute;
    right: 88px;
    top: 50%;
    display: flex;
    align-items: center;
    gap: 24px;
    transform: translateY(-50%);
  }
  .bars span {
    width: 56px;
    border-radius: 28px;
  }
  .brand, h1, p { position: relative; margin: 0; }
  .brand { display: flex; align-items: center; gap: 22px; font-size: 48px; font-weight: 800; letter-spacing: -0.02em; }
  .brand svg { width: 76px; height: 76px; }
  h1 { font-size: 76px; font-weight: 800; line-height: 1.04; letter-spacing: -0.035em; }
  h1 span { display: block; color: #a78bfa; }
  p { display: flex; gap: 18px; font-size: 30px; color: #a5a5b2; }
  p strong { color: #f5f5f7; font-weight: 650; }
</style>
<div class="bars">
  <span style="height: 180px; background: #8b5cf6"></span>
  <span style="height: 340px; background: #a78bfa"></span>
  <span style="height: 240px; background: #7c3aed"></span>
  <span style="height: 120px; background: #6d28d9"></span>
</div>
<div class="brand">${mark}FXM</div>
<h1>Practically any song.<span>Free and private.</span></h1>
<p><strong>fxm-music.pages.dev</strong> Free, open-source music player</p>
</html>`

const browser = await chromium.launch({ channel: 'chromium' })
try {
  await render(browser, icon(mark, 32), 32, 32, 'favicon-32.png')
  await render(browser, icon(squareMark, 180), 180, 180, 'apple-touch-icon.png')
  await render(browser, card, 1200, 630, 'og.png')
} finally {
  await browser.close()
}
console.log('Wrote public/favicon-32.png, public/apple-touch-icon.png and public/og.png')
