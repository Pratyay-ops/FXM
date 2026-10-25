import { defineConfig, devices } from '@playwright/test'

// End-to-end and screenshot runs against a production build served by `vite preview`.
// They are not part of `make test`. Every run builds and serves this checkout: when the
// port is busy (another worktree's preview, say), the run fails instead of silently
// testing that server. Set FXM_E2E_PORT to pick a free port.
const port = Number(process.env.FXM_E2E_PORT ?? 4173)
const baseURL = `http://localhost:${port}/app/`

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
    command: `vite build && vite preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
})
