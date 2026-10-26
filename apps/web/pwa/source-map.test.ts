// @vitest-environment node
// Build-time code: no DOM.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixServiceWorkerSourceMap, SERVICE_WORKER_FILE } from './source-map.ts'

const WORKBOX_SOURCE = 'node_modules/.pnpm/workbox-core@7.4.1/node_modules/workbox-core/_version.js'
const CODE = 'self.__WB_DISABLE_DEV_LOGS=!0;\n'
/** How Workbox ends sw.js when it writes a source map: Rollup's pointer, then its own. */
const POINTERS = `//# sourceMappingURL=${SERVICE_WORKER_FILE}.map\n`.repeat(2)

let folders: string[] = []

afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
  folders = []
})

/**
 * A repository with sw.js and its map in a build folder, as Workbox writes them for a build that
 * runs in apps/web: the map's sources are relative to apps/web.
 */
function workboxOutput() {
  const root = mkdtempSync(join(tmpdir(), 'fxm-sw-map-'))
  folders.push(root)
  const cwd = join(root, 'apps', 'web')
  const outDir = join(root, 'dist', '.staging', 'parts', 'app')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  const script = join(outDir, SERVICE_WORKER_FILE)
  writeFileSync(script, CODE + POINTERS)
  writeFileSync(
    `${script}.map`,
    JSON.stringify({ version: 3, file: 'sw.js', sources: [`../../${WORKBOX_SOURCE}`, null] }),
  )
  return { root, cwd, script }
}

const readMap = (script: string) =>
  JSON.parse(readFileSync(`${script}.map`, 'utf8')) as { sources: (string | null)[] }

describe("the service worker's source map", () => {
  it('names its sources relative to the map, where make dist resolves them', () => {
    const { root, cwd, script } = workboxOutput()

    expect(fixServiceWorkerSourceMap(script, { cwd, hidden: false })).toBe(true)

    const [workbox, unnamed] = readMap(script).sources
    expect(resolve(dirname(script), workbox ?? '')).toBe(join(root, WORKBOX_SOURCE))
    expect(unnamed).toBeNull()
  })

  it('keeps a hidden map hidden, as Vite does for the chunks: sw.js no longer points at it', () => {
    const { cwd, script } = workboxOutput()

    fixServiceWorkerSourceMap(script, { cwd, hidden: true })

    expect(readFileSync(script, 'utf8')).toBe(CODE)
  })

  it('leaves the pointers to a map that is not hidden', () => {
    const { cwd, script } = workboxOutput()

    fixServiceWorkerSourceMap(script, { cwd, hidden: false })

    expect(readFileSync(script, 'utf8')).toBe(CODE + POINTERS)
  })

  it('changes nothing in a build without source maps', () => {
    const { cwd, script } = workboxOutput()
    rmSync(`${script}.map`)

    expect(fixServiceWorkerSourceMap(script, { cwd, hidden: true })).toBe(false)
    expect(readFileSync(script, 'utf8')).toBe(CODE + POINTERS)
  })
})
