import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). The manager is
// runtime-agnostic, so its tests run in Node: fetch, streams and Blob are Node's own.
export default defineProject({
  test: {
    name: 'downloads',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
