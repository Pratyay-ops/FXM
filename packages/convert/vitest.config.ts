import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: ['packages/*', …]`). Conversion is
// runtime-agnostic, so its tests run in Node with audio the tests generate themselves (sine
// waves and silence, never real recordings). The real ffmpeg core is tested only when one is
// built (core.wasm.test.ts reads FXM_FFMPEG_CORE_DIR), so `make test` needs no build.
export default defineProject({
  test: {
    name: 'convert',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
