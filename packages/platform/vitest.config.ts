import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). Tests run in Node; the
// ones that need a page create their own happy-dom `Window` at the FXM origin, because in
// Vitest's global happy-dom environment `event.source` of a message is not the page's `window`.
export default defineProject({
  test: {
    name: 'platform',
    include: ['src/**/*.test.ts'],
  },
})
