import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['apps/*', …]`), so `make test` runs
// these tests. They read the Tauri configuration as plain files and need no Rust. The narrow
// `include` also keeps Vitest out of src-tauri/target, which holds thousands of files. Tests
// that need a page (the bridge's engine) ask for happy-dom in their first line.
export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['bridge/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
