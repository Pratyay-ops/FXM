import { defineConfig } from '@playwright/test'

// End-to-end test of the built Chromium extension (dist/chromium) against a local HTTPS mock of
// the music services. It is not part of `make test`: run `pnpm --filter @fxm/extension test:e2e`,
// which builds the extension first. Set FXM_CONNECT_E2E_PORT if port 5240 is taken.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  // One mock server and one browser profile at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
})
