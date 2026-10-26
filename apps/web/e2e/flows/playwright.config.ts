import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// The critical flows of the app as it ships: `make dist`'s dist/pages (or FXM_PAGES_DIR), served
// on 127.0.0.1 the way Cloudflare Pages serves it, with its real `_headers` (the Pages stand-in
// of scripts/build-dist, src/pages-server.ts). So the app runs under its deployed policies, the
// Lite tier frames the real sandbox document with its own policy, and the embed and the PWA are
// the deployed ones. Run `make dist` first, or `make e2e`, which does both (e2e/README.md).
//
// Two projects: `flows`, the specs of this folder, and `specs`, the tests of the other specs
// tagged @flow, which cover a critical flow already and run against `vite preview` too. Like
// those, it is offline: no host but this machine resolves, and every request that leaves the
// app's origin is answered by the test (e2e/fake-services.ts), so a request a test didn't answer
// fails instead of reaching a music service. Chromium runs muted: the tests prove playback by
// media events and the position.

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const pages = resolve(process.env.FXM_PAGES_DIR ?? join(root, 'dist/pages'))
// The tests' own helpers read these (e2e/target.ts): the workers inherit them.
process.env.FXM_E2E_TARGET = 'pages'
process.env.FXM_PAGES_DIR = pages
if (!existsSync(join(pages, '_headers'))) {
  throw new Error(`${pages} has no _headers file: run make dist first (or make e2e)`)
}

// The Pages stand-in listens here, and the embed test's page on another origin on the next ports
// (one per worker). Strict: a busy port fails the run rather than test another server.
const port = Number(process.env.FXM_E2E_PORT ?? 6700)
const baseURL = `http://127.0.0.1:${port}/app/`

const chromium = {
  ...devices['Desktop Chrome'],
  // The full Chromium build in new headless mode, as the other browser tests use, muted and
  // offline but for this machine.
  channel: 'chromium',
  launchOptions: {
    args: [
      '--mute-audio',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ],
  },
}

export default defineConfig({
  testDir: '..',
  outputDir: '../../test-results/flows',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // CI's time budget for the whole run, under the workflow step's own (.github/workflows/e2e.yml).
  globalTimeout: process.env.CI ? 12 * 60_000 : 0,
  // At most one retry, in CI only, where a busy runner can miss a timing a local run makes.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // The service worker would serve the app from its cache and could show the update toast while
    // the PWA tests publish new versions: only they turn it on.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'flows', testMatch: 'flows/*.e2e.ts', use: chromium },
    { name: 'specs', testMatch: '*.spec.ts', grep: /@flow\b/, use: chromium },
  ],
  webServer: {
    command: `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/build-dist/src/pages-server.ts ${JSON.stringify(pages)} --port ${port}`,
    cwd: root,
    url: baseURL,
    reuseExistingServer: false,
  },
})
