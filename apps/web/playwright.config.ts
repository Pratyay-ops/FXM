import { defineConfig, devices } from '@playwright/test'

// End-to-end and screenshot runs against a production build served by `vite preview`.
// They are not part of `make test`. Every run builds and serves this checkout: when the
// port is busy (another worktree's preview, say), the run fails instead of silently
// testing that server. Set FXM_E2E_PORT to pick a free port.
const port = Number(process.env.FXM_E2E_PORT ?? 4173)
const baseURL = `http://localhost:${port}/app/`

export default defineConfig({
  testDir: './e2e',
  // The specs only: flows/ and budgets/ run against make dist with their own configs, and
  // budgets/*.test.ts are Vitest's (e2e/README.md).
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // The service worker would serve the app from its cache and could show the update toast
    // while e2e/pwa.spec.ts publishes new versions. Only that spec turns it on.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      // The full Chromium build in new headless mode renders like real Chrome; the
      // lighter headless shell can hang on screenshots in sandboxed environments.
      // Muted: the tests prove playback by media events and the position, never by ear.
      // Offline: no host but this machine resolves, so a request a test didn't stub fails
      // instead of reaching a music service (the tests' own routes answer before any lookup).
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        launchOptions: {
          args: [
            '--mute-audio',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `vite build && vite preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    // Includes the development fake mode, which stays off unless a test asks for it, e.g. the
    // fake stream resolver of e2e/connect.spec.ts. Production builds leave it out.
    env: { VITE_FXM_FAKES: 'on' },
  },
})
