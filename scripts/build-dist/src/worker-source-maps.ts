/**
 * Source maps of the app's workers (the downloads' storage worker, 4.2's conversion worker) that
 * make dist can read. Vite bundles each worker on its own and generates it without an output
 * folder, so its map names the sources relative to a folder of Vite's choosing rather than to
 * where the map is written (`<outDir>/assets/`): read as the format says, they point at files
 * that don't exist, and the licence check can't tell which npm packages a worker ships (4.2's
 * worker bundles mp4box.js). This plugin rewrites each worker source relative to the map's real
 * folder as the worker is generated.
 */
import { dirname, relative, resolve, sep } from 'node:path'

/** `source` (relative to the map Rolldown thought of) relative to the map's real folder. */
export function relocateSource(source: string, sourcemapPath: string, mapDir: string): string {
  return relative(mapDir, resolve(dirname(sourcemapPath), source))
    .split(sep)
    .join('/')
}

/** The parts of Vite's config the plugin reads. */
interface ResolvedConfigLike {
  readonly root: string
  readonly build: { readonly outDir: string; readonly assetsDir: string }
}

/** A Vite plugin: workers' source maps name their sources relative to the maps' real folder. */
export function workerSourceMaps() {
  let mapDir: string | undefined
  return {
    name: 'fxm:worker-source-maps',
    apply: 'build' as const,
    config() {
      return {
        worker: {
          rolldownOptions: {
            output: {
              sourcemapPathTransform(source: string, sourcemapPath: string): string {
                return mapDir === undefined ? source : relocateSource(source, sourcemapPath, mapDir)
              },
            },
          },
        },
      }
    },
    configResolved(config: ResolvedConfigLike) {
      mapDir = resolve(config.root, config.build.outDir, config.build.assetsDir)
    },
  }
}
