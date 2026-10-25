import { defineProject } from 'vitest/config'

// Unit tests only. The Playwright specs in e2e/ run separately (pnpm e2e, pnpm screenshots).
export default defineProject({
  test: {
    name: 'site',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
