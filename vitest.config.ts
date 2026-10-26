import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'scripts/build-dist', 'packaging'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**', 'scripts/build-dist/src/**'],
      exclude: ['**/*.test.{ts,tsx}'],
    },
  },
})
