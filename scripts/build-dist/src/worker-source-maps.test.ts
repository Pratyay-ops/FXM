import { describe, expect, it } from 'vitest'
import { relocateSource, workerSourceMaps } from './worker-source-maps.ts'

describe('workerSourceMaps', () => {
  it('rewrites a worker’s sources relative to the folder its map really goes to', () => {
    // Vite generates the worker as if into apps/web/dist/assets; make dist writes it elsewhere.
    expect(
      relocateSource(
        '../../../../node_modules/.pnpm/mp4box@2.4.1/node_modules/mp4box/dist/mp4box.all.mjs',
        '/repo/apps/web/dist/assets/worker-1.js.map',
        '/repo/dist/.staging/parts/app/assets',
      ),
    ).toBe('../../../../../node_modules/.pnpm/mp4box@2.4.1/node_modules/mp4box/dist/mp4box.all.mjs')
    expect(
      relocateSource(
        '../../src/features/downloads/save/worker.ts',
        '/repo/apps/web/dist/assets/worker-1.js.map',
        '/repo/dist/.staging/parts/app/assets',
      ),
    ).toBe('../../../../../apps/web/src/features/downloads/save/worker.ts')
  })

  it('sets the transform on worker builds once it knows the output folder', () => {
    const plugin = workerSourceMaps()
    const transform = plugin.config().worker.rolldownOptions.output.sourcemapPathTransform
    expect(transform('../a.ts', '/x/y/z.js.map')).toBe('../a.ts')
    plugin.configResolved({
      root: '/repo/apps/web',
      build: { outDir: '/repo/out', assetsDir: 'assets' },
    })
    expect(transform('../../src/a.ts', '/repo/apps/web/dist/assets/w.js.map')).toBe(
      '../../apps/web/src/a.ts',
    )
  })
})
