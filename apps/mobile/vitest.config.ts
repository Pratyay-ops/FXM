import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['apps/*', …]`), so `make test` runs
// these. They check files only: none of them needs the JDK or the Android SDK.
export default defineProject({
  test: {
    name: 'mobile',
    include: ['*.test.ts', 'scripts/**/*.test.ts'],
  },
})
