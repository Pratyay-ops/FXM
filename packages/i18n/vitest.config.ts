import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). The runtime is plain
// TypeScript over Intl, so its tests run in Node.
export default defineProject({
  test: {
    name: 'i18n',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
