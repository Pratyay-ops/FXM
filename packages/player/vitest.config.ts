import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). happy-dom provides
// the audio elements for the direct audio engine tests; nothing plays real audio.
export default defineProject({
  test: {
    name: 'player',
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
