/**
 * A Vite plugin that records what a build takes from where, for the licence check
 * (licenses.ts): every module the bundler loaded, the source files of every file it emits
 * other than chunks, and the modules of every chunk. That shows the stylesheets, fonts, images
 * and WebAssembly a build takes from npm packages, which source maps don't, and the chunks that
 * hold only the bundler's own runtime, which have no source map.
 *
 * Each build of each environment (Astro builds a prerender and a client environment) appends
 * one JSON line to the file named by FXM_BUNDLE_INVENTORY, which make dist sets for the parts
 * it builds (parts.ts), and so does each worker Vite bundles, when the plugin is in the config's
 * `worker.plugins` too (dist-configs.ts). Without that variable the plugin does nothing. It uses
 * only the parts of the Rollup plugin interface that Vite and Rolldown share, so it needs no Vite
 * types.
 */
import { appendFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** The environment variable naming the file to append to. */
export const INVENTORY_VARIABLE = 'FXM_BUNDLE_INVENTORY'

interface BundleOutput {
  readonly type: 'asset' | 'chunk'
  readonly fileName: string
  /** Rollup and Rolldown: the source files an emitted asset came from, relative to the root. */
  readonly originalFileNames?: readonly string[]
  /** Rollup and Rolldown: the modules in an emitted chunk. */
  readonly moduleIds?: readonly string[]
}

interface PluginContext {
  getModuleIds(): Iterable<string>
  readonly environment?: { readonly name?: string }
}

/**
 * The plugin. `environment` names the entries it writes, for builds whose own environment
 * doesn't say what they are: Vite bundles a worker in an environment it also calls `client`.
 */
export function bundleInventory(options: { readonly environment?: string } = {}) {
  let root = process.cwd()
  return {
    name: 'fxm:bundle-inventory',
    apply: 'build' as const,
    configResolved(config: { readonly root: string }) {
      root = config.root
    },
    generateBundle(
      this: PluginContext,
      _options: unknown,
      bundle: Readonly<Record<string, BundleOutput>>,
    ) {
      const file = process.env[INVENTORY_VARIABLE]
      if (!file) return
      const assets = Object.values(bundle)
        .filter((output) => output.type === 'asset' && !output.fileName.endsWith('.map'))
        .map((asset) => ({
          fileName: asset.fileName,
          sources: (asset.originalFileNames ?? []).map((name) =>
            isAbsolute(name) ? name : resolve(root, name),
          ),
        }))
      const chunks = Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .map((chunk) => ({ fileName: chunk.fileName, modules: [...(chunk.moduleIds ?? [])] }))
      const entry = {
        environment: options.environment ?? this.environment?.name ?? 'client',
        modules: [...this.getModuleIds()],
        assets,
        chunks,
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`)
    },
  }
}
