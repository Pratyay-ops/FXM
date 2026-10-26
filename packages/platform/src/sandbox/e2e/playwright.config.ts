import { defineConfig, devices } from '@playwright/test'
import { E2E_PORT } from './port.ts'

// Browser tests of the sandbox documents, in Chromium and Firefox. Not part of `make test`: run
// `scripts/run.sh pnpm --filter @fxm/platform test:e2e`, which installs the two browsers into
// .tools/playwright first. Every request goes through the test network's proxy on port 5510
// (FXM_SANDBOX_E2E_PORT to change it), so the mock tests never touch the internet. FXM_LIVE=1
// adds the live test, which reaches YouTube itself (see README.md in the folder above).
const proxy = { server: `http://127.0.0.1:${E2E_PORT}` }

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  // One test network (one port) and one browser at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  use: {
    // The test network's certificate is self-signed.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The full Chromium build in the new headless mode, as the other packages' tests use.
        channel: 'chromium',
        launchOptions: { proxy, args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          proxy,
          firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
        },
      },
    },
  ],
})
