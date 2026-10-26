import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). Tests run in Node; the
// ones that need a page create their own happy-dom `Window` at the FXM origin, because in
// Vitest's global happy-dom environment `event.source` of a message is not the page's `window`.
export default defineProject({
  test: {
    name: 'platform',
    include: ['src/**/*.test.ts'],
    // The budget's import simulation runs some 2,000 fake-clock steps: quick on its own, but
    // several agents' test runs at once can slow it far past Vitest's default of 5 s.
    testTimeout: 60_000,
  },
})
