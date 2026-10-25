import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['apps/*', …]`), so `make test` runs
// these tests. They read the Tauri configuration as plain files and need no Rust. The narrow
// `include` also keeps Vitest out of src-tauri/target, which holds thousands of files.
export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
