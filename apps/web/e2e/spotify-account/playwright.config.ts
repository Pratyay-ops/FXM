import { defineConfig } from '@playwright/test'

// The Spotify account's browser tests (stage 3.5): the deployed layout from `make dist`, the
// development build of FXM Connect loaded into Chromium, and a made-up Spotify, all on one local
// HTTPS server (network.ts). Not part of `make test`: `pnpm --filter @fxm/web e2e:spotify-account`
// builds what it needs and runs them. Firefox can't load an extension under Playwright, so the
// Firefox half of the check is the owner's manual test (src/features/spotify-account/README.md).
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  outputDir: '../../test-results/spotify-account',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  // One server (one port) and one browser profile at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  // A sync makes a dozen requests through FXM Connect and a sandboxed document: give it time on
  // a busy machine.
  expect: { timeout: 30_000 },
})
