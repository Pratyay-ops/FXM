import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['apps/*', …]`), so `make test`
// runs these tests. Playwright specs in e2e/ are deliberately outside `include`; the unit tests
// of the performance budgets' arithmetic (e2e/budgets/*.test.ts) are in it.
export default defineProject({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'happy-dom',
    // pwa/ holds the build-time PWA config (manifest, service worker options, icons).
    include: ['src/**/*.test.{ts,tsx}', 'pwa/**/*.test.ts', 'e2e/budgets/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // The build without Jamendo's public client_id, as deployed until the owner sets one
    // (src/lib/free-sources.ts): a test that wants Jamendo stubs the variable.
    env: { VITE_FXM_JAMENDO_CLIENT_ID: '' },
    // Pages load lazily, and a dynamic import can take seconds when other checks share the
    // machine. A real failure still fails, only later (see also asyncUtilTimeout in setup.ts).
    testTimeout: 20_000,
    // Vitest replaces CSS with empty strings by default; the contrast test in
    // styles/tokens.test.ts reads the tokens with `?raw` (the id keeps that query).
    css: { include: [/tokens\.css(\?|$)/] },
  },
})
