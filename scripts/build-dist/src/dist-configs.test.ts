import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundleInventory, INVENTORY_VARIABLE } from './bundle-inventory.ts'
import { distAppConfig, distSiteConfig } from './dist-configs.ts'
import { readInventory } from './licenses.ts'
import { removeTempDirs, tempDir } from './testing.ts'

afterEach(() => {
  removeTempDirs()
  vi.unstubAllEnvs()
})

const plugin = (name: string) => ({ name })
const names = (plugins: readonly unknown[]) =>
  plugins.map((entry) => (entry as { name?: string }).name)

describe('the configs make dist builds with', () => {
  it('give the web app the inventory in its build and its workers’, and no .env files', () => {
    const config = distAppConfig({
      base: '/app/',
      plugins: [plugin('react')],
      worker: { format: 'es' as const, plugins: () => [plugin('worker-own')] },
    })
    expect(config.base).toBe('/app/')
    expect(config.envDir).toBe(false)
    expect(names(config.plugins)).toEqual([
      'react',
      'fxm:bundle-inventory',
      'fxm:worker-source-maps',
    ])
    expect(config.worker.format).toBe('es')
    expect(names(config.worker.plugins())).toEqual(['worker-own', 'fxm:bundle-inventory'])
    // An app without worker plugins of its own.
    expect(names(distAppConfig({}).worker.plugins())).toEqual(['fxm:bundle-inventory'])
  })

  it('build the embeddable player as the web app: the inventory, and no .env files', () => {
    // Read, not imported: importing the config files would load the apps' plugins.
    for (const file of ['app.vite.config.ts', 'embed.vite.config.ts']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      expect(source, file).toMatch(/^export default distAppConfig\(\w+\)$/m)
    }
  })

  it('give the site the inventory, hidden source maps and no .env files, keeping its own', () => {
    const config = distSiteConfig({
      site: 'https://example.com',
      vite: {
        plugins: [plugin('own')],
        build: { target: 'es2022' },
        server: { strictPort: true },
      },
    })
    expect(config.site).toBe('https://example.com')
    expect(config.vite.envDir).toBe(false)
    expect(config.vite.server).toEqual({ strictPort: true })
    expect(config.vite.build).toEqual({ target: 'es2022', sourcemap: 'hidden' })
    expect(names(config.vite.plugins)).toEqual(['own', 'fxm:bundle-inventory'])
  })

  it('label a worker’s inventory entries, which Vite builds in an environment it calls client', () => {
    const file = join(tempDir(), 'inventory.jsonl')
    vi.stubEnv(INVENTORY_VARIABLE, file)
    const context = { getModuleIds: () => ['/repo/a.ts'], environment: { name: 'client' } }
    const bundle = {
      'assets/worker.js': {
        type: 'chunk' as const,
        fileName: 'assets/worker.js',
        moduleIds: ['/repo/a.ts'],
      },
    }
    bundleInventory({ environment: 'worker' }).generateBundle.call(context, {}, bundle)
    bundleInventory().generateBundle.call(context, {}, bundle)
    expect(readInventory(file).map((entry) => [entry.environment, entry.chunks])).toEqual([
      ['worker', [{ fileName: 'assets/worker.js', modules: ['/repo/a.ts'] }]],
      ['client', [{ fileName: 'assets/worker.js', modules: ['/repo/a.ts'] }]],
    ])
  })

  it('list the chunks each chunk imports, for the performance budgets', () => {
    const file = join(tempDir(), 'inventory.jsonl')
    vi.stubEnv(INVENTORY_VARIABLE, file)
    const context = { getModuleIds: () => ['/repo/main.ts', '/repo/page.ts'] }
    const bundle = {
      'assets/index.js': {
        type: 'chunk' as const,
        fileName: 'assets/index.js',
        moduleIds: ['/repo/main.ts'],
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/page.js'],
      },
    }
    bundleInventory().generateBundle.call(context, {}, bundle)
    expect(readInventory(file)[0]?.chunks).toEqual([
      {
        fileName: 'assets/index.js',
        modules: ['/repo/main.ts'],
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/page.js'],
      },
    ])
  })
})
