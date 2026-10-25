import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// The signed-module e2e test: real browser engines load a signed YouTube module from a blob:
// URL under the desktop app's Content Security Policy. Not part of `make test`; run it with
// `scripts/run.sh pnpm --filter @fxm/platform test:e2e:updates`. Chromium stands in for
// WebView2 and Android System WebView, WebKit (when installed) for WKWebView and WebKitGTK.
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.mjs',
  // Traces and screenshots of failures stay out of the repository.
  outputDir: join(tmpdir(), 'fxm-updates-e2e-results'),
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  // One local server, on a fixed port.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.FXM_E2E_WEBKIT === '1'
      ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }]
      : []),
  ],
})
