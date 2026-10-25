import { defineProject } from 'vitest/config'

// Unit tests only: they run offline as part of `make test`.
export default defineProject({
  test: {
    name: 'extension',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
