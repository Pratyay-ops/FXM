import { defineProject } from 'vitest/config'

// Picked up by the root vitest.config.ts (`projects: [..., 'packaging']`), so `make test` runs
// these. They read files and run the generators and the F-Droid build script against stubs,
// offline: none of them needs F-Droid's tools, Flatpak, winget, the JDK or the network.
export default defineProject({
  test: {
    name: 'packaging',
    include: ['*.test.ts', '{fdroid,obtainium,flatpak,winget}/**/*.test.ts'],
    environment: 'node',
    // The F-Droid build script's test starts bash, which takes longer on a busy machine.
    testTimeout: 30_000,
  },
})
