import { defineProject } from 'vitest/config'

// Unit tests only. The Playwright end-to-end test (e2e/*.e2e.ts) runs separately with
// `pnpm --filter @fxm/extension test:e2e`, so `make test` never starts a browser.
export default defineProject({
  test: {
    name: 'extension',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
