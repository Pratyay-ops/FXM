import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['apps/*', …]`), so `make test`
// runs these tests. Playwright specs in e2e/ are deliberately outside `include`.
export default defineProject({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
