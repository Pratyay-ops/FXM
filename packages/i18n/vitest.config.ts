import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). The runtime is plain
// TypeScript over Intl, so its tests run in Node; the React and DOM tests ask for happy-dom in
// their first line. tools/ holds the string inventory, the runtime's size check and the measure
// of what the web app's first load would hold.
export default defineProject({
  test: {
    name: 'i18n',
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
})
