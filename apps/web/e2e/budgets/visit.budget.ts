import { type Browser, expect, type Page, test } from '@playwright/test'
import { PHONE, RUNS } from './budgets'
import { format, type Measured, report } from './report'
import { type BudgetServer, startBudgetServer, type Transfer } from './server'
import {
  cumulativeLayoutShift,
  interactionToNextPaint,
  largestContentfulPaint,
  median,
  observeVitals,
  VITALS_KEY,
  type VitalsRecord,
} from './vitals'

// A first visit of make dist's app against its budgets: the bytes it transfers, with and without
// the service worker, and its Largest Contentful Paint, Cumulative Layout Shift and Interaction
// to Next Paint on a mid-range phone over Slow 4G (PHONE in budgets.ts), the median of RUNS
// visits. The app is served as Cloudflare Pages serves it (server.ts), offline but for this
// machine, so it starts in the Free tier: Lite's check can't reach YouTube.

test.describe.configure({ mode: 'serial' })

const base = Number(process.env.FXM_BUDGETS_PORT ?? 6710)
let server: BudgetServer

test.beforeAll(async () => {
  // The Pages stand-in (playwright.config.ts) listens on `base`, the fronts on the next ports.
  server = await startBudgetServer(`http://127.0.0.1:${base}`, {
    secure: base + 1,
    plain: base + 2,
  })
})

test.afterAll(async () => {
  await server?.close()
})

/** The bytes of some answers, how many there were, and the HTTP versions they came over. */
function total(transfers: readonly Transfer[]) {
  return {
    bytes: transfers.reduce((sum, transfer) => sum + transfer.bytes, 0),
    requests: transfers.length,
    protocols: [...new Set(transfers.map((transfer) => transfer.protocol))].sort(),
  }
}

/** A first visit's transfer, unthrottled: without the service worker, or with it. */
async function transferOfFirstVisit(browser: Browser, worker: boolean) {
  const context = await browser.newContext({
    ...PHONE.context,
    serviceWorkers: worker ? 'allow' : 'block',
  })
  try {
    const page = await context.newPage()
    server.transfers.length = 0
    await page.goto(`${server.plain}/app/`)
    await page.waitForLoadState('networkidle')
    if (worker) {
      // Active only once installed, and Workbox stores the whole shell while it installs.
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready
      })
    }
    return total(server.transfers)
  } finally {
    await context.close()
  }
}

/** A few taps and some typing, as someone trying the app out would. */
async function interact(page: Page): Promise<void> {
  const settle = () => page.waitForTimeout(500)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Search' }).tap()
  const field = page.getByRole('searchbox', { name: 'Search' }).first()
  await field.tap()
  await field.pressSequentially('radiohead', { delay: 120 })
  await settle()
  await page.getByRole('link', { name: 'Settings' }).first().tap()
  await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor({ timeout: 30_000 })
  await settle()
  await page.locator('label', { hasText: /^Light$/u }).tap()
  await settle()
  await page.locator('label', { hasText: /^Dark$/u }).tap()
  await settle()
  await nav.getByRole('link', { name: 'Library' }).tap()
  await page.getByRole('heading', { level: 1, name: 'Your library' }).waitFor({ timeout: 30_000 })
  await nav.getByRole('link', { name: 'Home' }).tap()
  // Event Timing reports an interaction after its next paint.
  await page.waitForTimeout(1000)
}

/** One first visit on {@link PHONE}: its timings, and what the page transferred until idle. */
async function timedFirstVisit(browser: Browser) {
  const context = await browser.newContext({
    ...PHONE.context,
    serviceWorkers: 'block',
    // The secure front's certificate is self-signed.
    ignoreHTTPSErrors: true,
  })
  try {
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: PHONE.network.latencyMs,
      downloadThroughput: PHONE.network.downloadBytesPerSecond,
      uploadThroughput: PHONE.network.uploadBytesPerSecond,
    })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PHONE.cpuSlowdown })
    await page.addInitScript(observeVitals)
    const vitals = () =>
      page.evaluate((key) => (window as unknown as Record<string, VitalsRecord>)[key], VITALS_KEY)

    server.transfers.length = 0
    await page.goto(`${server.secure}/app/`, { timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 60_000 })
    const transferred = total(server.transfers)
    // Largest Contentful Paint stops at the first input, so it is read before any.
    const lcp = largestContentfulPaint((await vitals())?.paints ?? [])
    await interact(page)
    const record = await vitals()
    if (record === undefined) throw new Error('The page kept no performance entries')
    return {
      lcp,
      cls: cumulativeLayoutShift(record.shifts),
      inp: interactionToNextPaint(record.interactions),
      interactions: new Set(record.interactions.map((entry) => entry.interactionId)).size,
      transferred,
    }
  } finally {
    await context.close()
  }
}

/** Each run's value, in the budget's unit. */
function each(budget: 'lcp' | 'cls' | 'inp', values: readonly number[]): string {
  return `median of ${values.map((value) => format(budget, value)).join(', ')}`
}

test('a first visit stays within its budgets', async ({ browser }) => {
  test.setTimeout(RUNS * 90_000 + 60_000)
  const page = await transferOfFirstVisit(browser, false)
  const withWorker = await transferOfFirstVisit(browser, true)
  const runs: Awaited<ReturnType<typeof timedFirstVisit>>[] = []
  for (let run = 0; run < RUNS; run += 1) runs.push(await timedFirstVisit(browser))
  // Timings over HTTP/1.1 would wait for six connections, which Cloudflare's visitors don't.
  for (const run of runs) expect(run.transferred.protocols).toEqual(['2.0'])

  const lcps = runs.map((run) => run.lcp?.startTime ?? Number.POSITIVE_INFINITY)
  const largest = [...new Set(runs.map((run) => run.lcp?.element ?? 'nothing'))].join(', ')
  const cls = runs.map((run) => run.cls)
  const inp = runs.map((run) => run.inp)
  const interactions = Math.min(...runs.map((run) => run.interactions))
  const measured: Measured[] = [
    {
      budget: 'firstLoad',
      value: page.bytes,
      detail: `${page.requests} requests, without the service worker`,
    },
    {
      budget: 'firstVisit',
      value: withWorker.bytes,
      detail: `${withWorker.requests} requests, with the service worker's install`,
    },
    { budget: 'lcp', value: median(lcps), detail: `${each('lcp', lcps)}; largest: ${largest}` },
    { budget: 'cls', value: median(cls), detail: each('cls', cls) },
    {
      budget: 'inp',
      value: median(inp),
      detail: `${each('inp', inp)}; at least ${interactions} interactions took 16 ms or more`,
    },
  ]
  await report(test.info(), `First visit on ${PHONE.name}`, measured, {
    transfer: { page, withWorker },
    runs,
  })
})
