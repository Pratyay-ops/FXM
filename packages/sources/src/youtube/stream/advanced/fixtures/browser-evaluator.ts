/**
 * An evaluator for the live tests that BotGuard accepts: the committed `eval.html` in Playwright's
 * Chromium (from `.tools/playwright`), loaded as the Android app loads it, at
 * `https://www.youtube.com/` and driven through its mailbox. The page is served locally and every
 * other request of the browser is refused, so the browser itself never touches the network: the
 * test makes BotGuard's requests from Node, as the app makes them through its transport.
 *
 * @module
 */

import { createEvaluator, createMailboxPort } from '@fxm/platform/testing/evaluator'
import type { StreamEvaluator } from '../evaluator'

/** Node's `fs`, without Node's types (this package type-checks as a web worker). */
const fs = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
    }
  }
).process.getBuiltinModule('node:fs')

/** A running browser evaluator. */
export interface BrowserEvaluator {
  /** The evaluator. */
  readonly evaluator: StreamEvaluator
  /** Closes the browser. */
  close(): Promise<void>
}

/** Starts Chromium with `eval.html` at YouTube's origin. */
export async function launchBrowserEvaluator(): Promise<BrowserEvaluator> {
  const { chromium } = await import('playwright-core')
  const html = fs.readFileSync(
    new URL('../../../../../../../apps/web/sandbox/eval.html', import.meta.url),
    'utf8',
  )
  // The full Chromium build in headless mode, without the automation flag: what a user's browser
  // engine looks like to the page.
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const probe = await browser.newPage()
  const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace(
    'HeadlessChrome',
    'Chrome',
  )
  await probe.close()
  const context = await browser.newContext({ userAgent })
  await context.route('**/*', (route) =>
    route.request().url() === 'https://www.youtube.com/'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
      : route.abort(),
  )
  const page = await context.newPage()
  await page.goto('https://www.youtube.com/')
  const port = createMailboxPort({
    run: async (script) => JSON.stringify((await page.evaluate(script)) ?? null),
  })
  return {
    evaluator: createEvaluator('android', port, { origin: 'https://www.youtube.com' }),
    close: () => browser.close(),
  }
}
