// @vitest-environment node
// The budgets' reading of make dist's output: no DOM.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brotli,
  chunkGraph,
  chunkReport,
  type InventoryBuild,
  MAIN_MODULE,
  stylesheetsOf,
  transferSize,
} from './chunks'

const ROOT = '/repo'
const id = (module: string) => `${ROOT}/${module}`

/** An app build: the entry and its imports, a lazy page with a shared chunk, a feature's code. */
const BUILDS: InventoryBuild[] = [
  {
    environment: 'worker',
    chunks: [{ fileName: 'assets/worker.js', modules: [id('apps/web/src/feature/worker.ts')] }],
  },
  {
    environment: 'client',
    chunks: [
      {
        fileName: 'assets/index.js',
        modules: [id(MAIN_MODULE), id('apps/web/src/shell.tsx')],
        imports: ['assets/react.js', 'assets/feature.js'],
        dynamicImports: ['assets/page.js', 'assets/provider.js'],
      },
      { fileName: 'assets/react.js', modules: [id('node_modules/react/index.js')] },
      {
        fileName: 'assets/feature.js',
        modules: [id('apps/web/src/feature/runtime.ts'), id('apps/web/src/feature/worker.ts')],
        imports: ['assets/react.js'],
      },
      {
        fileName: 'assets/page.js',
        modules: [id('apps/web/src/page.tsx')],
        imports: ['assets/react.js', 'assets/shared.js'],
      },
      { fileName: 'assets/shared.js', modules: [id('apps/web/src/shared.ts')] },
      {
        fileName: 'assets/provider.js',
        modules: [id('packages/provider/index.ts')],
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/library.js'],
      },
      {
        fileName: 'assets/library.js',
        modules: [id('node_modules/library/index.js')],
        imports: ['assets/library-core.js'],
      },
      { fileName: 'assets/library-core.js', modules: [id('node_modules/library/core.js')] },
    ],
  },
]

describe('chunkGraph', () => {
  it('finds the entry chunk and everything it imports, transitively', () => {
    const graph = chunkGraph(BUILDS, ROOT, [])
    expect(graph.entry).toBe('assets/index.js')
    expect(graph.initial).toEqual(['assets/feature.js', 'assets/index.js', 'assets/react.js'])
  })

  it('counts what a lazy group adds to the first load, not what the first load has', () => {
    const graph = chunkGraph(BUILDS, ROOT, [{ name: 'page', roots: ['apps/web/src/page.tsx'] }])
    expect(graph.groups.page).toEqual({
      files: ['assets/page.js', 'assets/shared.js'],
      initial: [],
    })
  })

  it("follows a dynamic group's import() calls, and their imports", () => {
    const groups = [
      { name: 'static', roots: ['packages/provider/index.ts'] },
      { name: 'dynamic', roots: ['packages/provider/index.ts'], dynamic: true },
    ]
    const graph = chunkGraph(BUILDS, ROOT, groups)
    expect(graph.groups.static?.files).toEqual(['assets/provider.js', 'assets/shared.js'])
    expect(graph.groups.dynamic?.files).toEqual([
      'assets/library-core.js',
      'assets/library.js',
      'assets/provider.js',
      'assets/shared.js',
    ])
  })

  it('refuses a root no chunk holds', () => {
    expect(() =>
      chunkGraph(BUILDS, ROOT, [{ name: 'gone', roots: ['apps/web/src/gone.ts'] }]),
    ).toThrow('gone: no chunk holds apps/web/src/gone.ts')
  })

  it('refuses a root in the first load: in the entry chunk, or in a chunk the entry imports', () => {
    expect(() =>
      chunkGraph(BUILDS, ROOT, [{ name: 'shell', roots: ['apps/web/src/shell.tsx'] }]),
    ).toThrow(
      'shell: apps/web/src/shell.tsx is in the first load (the entry chunk), so it no longer loads lazily',
    )
    // As when the shell imports a lazy page's module: Rolldown then puts it in a chunk of its own
    // that the entry imports, not into the entry chunk.
    expect(() =>
      chunkGraph(BUILDS, ROOT, [{ name: 'feature', roots: ['apps/web/src/feature/runtime.ts'] }]),
    ).toThrow(
      'feature: apps/web/src/feature/runtime.ts is in the first load (assets/feature.js), so it no longer loads lazily',
    )
  })

  it("counts a root the first load may hold (inFirstLoad), and says it's there", () => {
    const groups = [
      {
        name: 'feature',
        roots: ['apps/web/src/feature/runtime.ts', 'apps/web/src/feature/worker.ts'],
        inFirstLoad: ['apps/web/src/feature/runtime.ts', 'apps/web/src/feature/worker.ts'],
      },
    ]
    const graph = chunkGraph(BUILDS, ROOT, groups)
    // The worker's module is in the app's chunk too: the app's build is looked up first.
    expect(graph.groups.feature).toEqual({
      files: ['assets/feature.js'],
      initial: ['assets/feature.js'],
    })
  })

  it('refuses inFirstLoad for a root that loads lazily now, or for a module that is no root', () => {
    expect(() =>
      chunkGraph(BUILDS, ROOT, [
        {
          name: 'page',
          roots: ['apps/web/src/page.tsx'],
          inFirstLoad: ['apps/web/src/page.tsx'],
        },
      ]),
    ).toThrow("page: apps/web/src/page.tsx loads lazily now: take it off the group's inFirstLoad")
    expect(() =>
      chunkGraph(BUILDS, ROOT, [
        {
          name: 'page',
          roots: ['apps/web/src/page.tsx'],
          inFirstLoad: ['apps/web/src/shared.ts'],
        },
      ]),
    ).toThrow('page: apps/web/src/shared.ts is in inFirstLoad but not in its roots')
  })

  it("refuses an inventory without the app's entry", () => {
    expect(() => chunkGraph([BUILDS[0] as InventoryBuild], ROOT, [])).toThrow(
      `No chunk holds ${MAIN_MODULE}`,
    )
  })
})

describe('stylesheetsOf', () => {
  it("lists the app's stylesheets, not other links", () => {
    const html =
      '<link rel="manifest" href="/app/manifest.webmanifest"><link rel="stylesheet" crossorigin href="/app/assets/index.css"><link rel="stylesheet" href="https://elsewhere.example/a.css">'
    expect(stylesheetsOf(html)).toEqual(['assets/index.css'])
  })
})

describe('sizes', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('compresses as Cloudflare Pages does for Chromium, and back', () => {
    const text = new TextEncoder().encode('export const a = 1;\n'.repeat(500))
    expect(brotliDecompressSync(brotli(text))).toEqual(Buffer.from(text))
    expect(transferSize(text)).toBeLessThan(text.length / 10)
  })

  it('reports the files on disk and as transferred', () => {
    dir = mkdtempSync(join(tmpdir(), 'fxm-chunks-'))
    const app = join(dir, 'app')
    mkdirSync(join(app, 'assets'), { recursive: true })
    const files: Record<string, string> = {
      'index.html': '<link rel="stylesheet" href="/app/assets/index.css">',
      'assets/index.css': 'body { color: red }\n'.repeat(50),
    }
    for (const chunk of BUILDS.flatMap((build) => build.chunks ?? [])) {
      files[chunk.fileName] = `console.log(${JSON.stringify(chunk.fileName)})\n`.repeat(20)
    }
    for (const [file, content] of Object.entries(files)) writeFileSync(join(app, file), content)
    const inventory = join(dir, 'app.jsonl')
    writeFileSync(inventory, BUILDS.map((build) => JSON.stringify(build)).join('\n'))

    const report = chunkReport(app, inventory, ROOT, [
      { name: 'page', roots: ['apps/web/src/page.tsx'] },
    ])
    const size = (file: string) => (files[file] ?? '').length
    expect(report.entry.files).toEqual(['assets/index.js'])
    expect(report.entry.raw).toBe(size('assets/index.js'))
    expect(report.initial.files).toEqual([
      'assets/feature.js',
      'assets/index.js',
      'assets/react.js',
      'assets/index.css',
    ])
    expect(report.initial.raw).toBe(report.initial.files.reduce((sum, file) => sum + size(file), 0))
    expect(report.initial.transfer).toBeLessThan(report.initial.raw)
    expect(report.groups.page.raw).toBe(size('assets/page.js') + size('assets/shared.js'))
    // Every file counted, once, the largest download first.
    expect(Object.keys(report.sizes).sort()).toEqual([
      'assets/feature.js',
      'assets/index.css',
      'assets/index.js',
      'assets/page.js',
      'assets/react.js',
      'assets/shared.js',
    ])
    const transfers = Object.values(report.sizes).map((file) => file.transfer)
    expect(transfers).toEqual([...transfers].sort((a, b) => b - a))
    expect(report.sizes['assets/index.css']?.raw).toBe(size('assets/index.css'))
  })
})
