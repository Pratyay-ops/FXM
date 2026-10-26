import { defineConfig, devices } from '@playwright/test'
import { PORTS } from './network'

// The embed's browser tests: the player on another site, in the Lite tier, against the local
// test network in network.ts. Not part of `make test`: `pnpm --filter @fxm/web e2e:embed`
// builds the embed with its test doubles (`--mode e2e`) and runs them. Every request goes
// through the network's proxy, so nothing reaches the internet.
const proxy = { server: `http://127.0.0.1:${PORTS.proxy}` }

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  outputDir: '../../test-results/embed',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  // One test network (one set of ports) and one browser at a time.
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
      // The full Chromium build in the new headless mode, as the other browser tests use.
      use: { ...devices['Desktop Chrome'], channel: 'chromium', launchOptions: { proxy } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], launchOptions: { proxy } },
    },
  ],
})
