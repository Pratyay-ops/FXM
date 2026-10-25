import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Browser checks of a deployment (e2e/deployed.e2e.ts). With FXM_DEPLOY_URL they run against
// that deployment, as the deploy workflow does. Without it they serve dist/pages (run make dist
// first), or the folder in FXM_PAGES_DIR, on 127.0.0.1 the way Cloudflare Pages would, on
// FXM_PREVIEW_PORT (default 5800, which fails instead of moving when the port is taken).
// FXM_E2E_CHANNEL picks the browser: CI uses the runner's Chrome ("chrome"), so no browser is
// downloaded there.
const deployment = process.env.FXM_DEPLOY_URL
const port = Number(process.env.FXM_PREVIEW_PORT ?? 5800)
const baseURL = deployment ?? `http://127.0.0.1:${port}`
const folder = process.env.FXM_PAGES_DIR ? JSON.stringify(resolve(process.env.FXM_PAGES_DIR)) : ''

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // A deployment is reached over the internet; one retry absorbs a dropped connection.
  retries: deployment ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.FXM_E2E_CHANNEL ?? 'chromium' },
    },
  ],
  ...(deployment
    ? {}
    : {
        webServer: {
          command: `node --experimental-strip-types --disable-warning=ExperimentalWarning src/pages-server.ts ${folder} --port ${port}`,
          url: `${baseURL}/`,
          reuseExistingServer: false,
        },
      }),
})
