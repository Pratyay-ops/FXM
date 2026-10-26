import { defineConfig, devices } from '@playwright/test'

// Smoke tests and screenshots run against the production build served by `astro
// preview`. They are not part of `make test`. Set FXM_E2E_PORT when several worktrees
// run them at the same time; the preview server refuses a port that is already taken.
const port = Number(process.env.FXM_E2E_PORT ?? 4321)
const baseURL = `http://localhost:${port}`

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // The full Chromium build in new headless mode renders like real Chrome; the
      // lighter headless shell can hang on screenshots in sandboxed environments.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: {
    // --ignore-lock keeps the server in the foreground so Playwright can stop it (Astro 7
    // moves `astro preview` to the background when it detects a coding agent).
    command: `astro build && astro preview --port ${port} --ignore-lock`,
    url: baseURL,
    reuseExistingServer: false,
  },
})
