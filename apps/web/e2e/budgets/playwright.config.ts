import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// The performance budgets of the app as it ships (e2e/README.md): make dist's dist/pages (or
// FXM_PAGES_DIR) and the bundle inventory it keeps in dist/inventory. The chunk budgets read the
// files; the first-visit budgets load the app in Chromium from the Pages stand-in of
// scripts/build-dist (src/pages-server.ts), behind a front that speaks HTTP/2 and compresses as
// Cloudflare Pages does (server.ts). Run `make budgets`, which runs make dist first.
//
// One worker, so no other test competes for the CPU while one measures. Offline but for this
// machine, and muted, like the other browser tests.

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const pages = resolve(process.env.FXM_PAGES_DIR ?? join(root, 'dist/pages'))
// The tests read these (e2e/target.ts, visit.budget.ts): the workers inherit them.
process.env.FXM_E2E_TARGET = 'pages'
process.env.FXM_PAGES_DIR = pages
if (!existsSync(join(pages, '_headers'))) {
  throw new Error(`${pages} has no _headers file: run make dist first (or make budgets)`)
}

// The Pages stand-in listens here, and the fronts on the next two ports. Strict: a busy port
// fails the run rather than measure another server.
const port = Number(process.env.FXM_BUDGETS_PORT ?? 6710)
process.env.FXM_BUDGETS_PORT = String(port)

export default defineConfig({
  testDir: '.',
  testMatch: '*.budget.ts',
  outputDir: '../../test-results/budgets',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // CI's time budget for the whole run, under the workflow step's own (.github/workflows/e2e.yml).
  globalTimeout: process.env.CI ? 10 * 60_000 : 0,
  // No retry: a budget exceeded fails the run. A retry would pass it as merely flaky once one
  // median came in under, and the sizes come out the same every time. The timings are medians
  // of several visits already (RUNS in budgets.ts).
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
  use: {
    // No trace: recording one takes the CPU time the timings measure.
    trace: 'off',
    // The full Chromium build in new headless mode, muted and offline but for this machine.
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    launchOptions: {
      args: [
        '--mute-audio',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ],
    },
  },
  webServer: {
    command: `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/build-dist/src/pages-server.ts ${JSON.stringify(pages)} --port ${port}`,
    cwd: root,
    url: `http://127.0.0.1:${port}/app/`,
    reuseExistingServer: false,
  },
})
