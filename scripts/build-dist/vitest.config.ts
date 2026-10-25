import { defineProject } from 'vitest/config'

// Unit tests only. The Playwright checks of a deployed site (e2e/*.e2e.ts) run separately with
// `pnpm --filter @fxm/deploy e2e`, so `make test` never starts a browser. Some tests start bash
// and node (deploy-script.test.ts) or a local server, which takes longer on a busy machine.
export default defineProject({
  test: {
    name: 'deploy',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
