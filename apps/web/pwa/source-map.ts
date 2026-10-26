/**
 * The service worker's source map, for `make dist` (stage 2.8, scripts/build-dist): it lists the
 * npm packages each script ships from the source map next to it, refuses a script without one,
 * and deploys no source maps. Vite writes the app's maps hidden (`--sourcemap hidden`), and
 * vite-plugin-pwa then has Workbox bundle `sw.js` on its own. Workbox names that map's sources
 * relative to the folder the build runs in instead of to the map, and points `sw.js` at the map.
 * {@link serviceWorkerSourceMap} fixes both once the service worker is written. A build without
 * source maps (`vite build`, as in `make check`) has no `sw.js.map`, and nothing changes.
 *
 * @module
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

/** The service worker vite-plugin-pwa writes into the build folder (`generateSW`). */
export const SERVICE_WORKER_FILE = 'sw.js'

/** The lines that point a script at its source map (Workbox adds one, and Rollup another). */
const SOURCE_MAPPING_URL = /^\/\/# sourceMappingURL=.*\n?/gm

interface SourceMapJson {
  sources: (string | null)[]
  sourceRoot?: string
}

function isSourceMap(value: unknown): value is SourceMapJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { sources?: unknown }).sources)
  )
}

/**
 * Makes the source map of `script` name its sources relative to the map, as the format says and
 * make dist reads them, where Workbox names them relative to `cwd`. With `hidden`, also removes
 * the script's pointers to the map, as Vite does for the app's own chunks. Returns false when the
 * script has no source map.
 */
export function fixServiceWorkerSourceMap(
  script: string,
  { cwd, hidden }: { cwd: string; hidden: boolean },
): boolean {
  const mapFile = `${script}.map`
  if (!existsSync(mapFile)) return false
  const map: unknown = JSON.parse(readFileSync(mapFile, 'utf8'))
  if (!isSourceMap(map)) throw new Error(`${mapFile} is not a source map with a sources list`)
  const base = resolve(cwd, map.sourceRoot ?? '')
  const fixed: SourceMapJson = {
    ...map,
    sources: map.sources.map((source) =>
      source === null
        ? null
        : relative(dirname(mapFile), resolve(base, source)).split(sep).join('/'),
    ),
  }
  delete fixed.sourceRoot
  writeFileSync(mapFile, JSON.stringify(fixed))
  if (hidden) writeFileSync(script, readFileSync(script, 'utf8').replace(SOURCE_MAPPING_URL, ''))
  return true
}

/** Runs {@link fixServiceWorkerSourceMap} on the build's service worker, once it is written. */
export function serviceWorkerSourceMap(): Plugin {
  let script = ''
  let hidden = false
  return {
    name: 'fxm:service-worker-source-map',
    apply: 'build',
    configResolved(config) {
      script = join(resolve(config.root, config.build.outDir), SERVICE_WORKER_FILE)
      hidden = config.build.sourcemap === 'hidden'
    },
    // After vite-plugin-pwa's own closeBundle, which writes the service worker.
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        fixServiceWorkerSourceMap(script, { cwd: process.cwd(), hidden })
      },
    },
  }
}
