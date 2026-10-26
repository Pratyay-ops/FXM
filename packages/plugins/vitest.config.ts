import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). The host is
// runtime-agnostic, so its tests run in Node: the evaluator is the real runtime of eval.html run
// in-process (`createInProcessEvaluator`), and the network is a fake `fetch`.
// `browser.test.ts` runs the real eval.html in Chromium, only with FXM_BROWSER=1.
export default defineProject({
  test: {
    name: 'plugins',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // A plugin call takes several evaluator round trips; on a busy machine that can pass 5 s.
    testTimeout: 30_000,
  },
})
