import { defineConfig, devices } from '@playwright/test'

// End-to-end and screenshot runs against a production build served by `vite preview`.
// They are not part of `make test`. Every run builds and serves this checkout: when the
// port is busy (another worktree's preview, say), the run fails instead of silently
// testing that server. Set FXM_E2E_PORT to pick a free port. FXM_E2E_BASE_URL runs them
// against a server that is up already instead, such as make dist's folder served like
// Cloudflare Pages, with its real headers (scripts/build-dist, `preview`):
// FXM_E2E_BASE_URL=http://127.0.0.1:5800/app/.
const port = Number(process.env.FXM_E2E_PORT ?? 4173)
const external = process.env.FXM_E2E_BASE_URL
const baseURL = external ?? `http://localhost:${port}/app/`

/**
 * The phone specs, which run on two phones instead of desktop Chromium: Chromium as a Pixel 7,
 * and WebKit, the engine of Safari and of every browser on iPhone and iPad, as an iPhone 15.
 */
const PHONE_SPECS = /[\\/]phone-[\w-]+\.spec\.ts$/

/**
 * Chromium runs muted: the tests prove playback by media events and the position, never by ear.
 * And offline: no host but this machine resolves, so a request a test didn't stub fails instead
 * of reaching a music service (the tests' own routes answer before any lookup).
 */
const CHROMIUM_ARGS = [
  '--mute-audio',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
]

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // The service worker would serve the app from its cache and could show the update toast
    // while e2e/pwa.spec.ts publishes new versions. Only that spec and the phone specs turn it on.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: PHONE_SPECS,
      // The full Chromium build in new headless mode renders like real Chrome; the
      // lighter headless shell can hang on screenshots in sandboxed environments.
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        launchOptions: { args: CHROMIUM_ARGS },
      },
    },
    {
      name: 'phone-chromium',
      testMatch: PHONE_SPECS,
      use: {
        ...devices['Pixel 7'],
        channel: 'chromium',
        launchOptions: { args: CHROMIUM_ARGS },
      },
    },
    {
      // WebKit has no switch to mute it or to keep hosts from resolving: the phone specs mute
      // every media element and answer or refuse every request that leaves this machine
      // themselves (e2e/phone.ts).
      name: 'phone-webkit',
      testMatch: PHONE_SPECS,
      use: { ...devices['iPhone 15'] },
    },
  ],
  ...(external === undefined && {
    webServer: {
      command: `vite build && vite preview --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      // Includes the development fake mode, which stays off unless a test asks for it, e.g. the
      // fake stream resolver of e2e/connect.spec.ts. Production builds leave it out.
      env: { VITE_FXM_FAKES: 'on' },
    },
  }),
})
