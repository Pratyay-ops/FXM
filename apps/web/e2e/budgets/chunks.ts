import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

// The web app's chunks as `make dist` built them: which files the first load needs, and what
// each lazy feature adds. make dist's bundle inventory (scripts/build-dist/src/bundle-inventory.ts)
// lists the modules in every chunk and the chunks each one imports, and make dist keeps it in
// dist/inventory/app.jsonl, beside dist/pages, never deployed.

/** A chunk, as the bundle inventory lists it. */
export interface InventoryChunk {
  /** The file, relative to the app's folder (`assets/index-….js`). */
  readonly fileName: string
  /** The modules in it, as absolute paths (or the bundler's virtual ids). */
  readonly modules: readonly string[]
  /** The chunks it imports statically, which load before it runs. */
  readonly imports?: readonly string[]
  /** The chunks it imports with `import()`. */
  readonly dynamicImports?: readonly string[]
}

/** One build's line of the inventory: the app's (`client`), or a worker's (`worker`). */
export interface InventoryBuild {
  readonly environment: string
  readonly chunks?: readonly InventoryChunk[]
}

/** Reads an inventory file: one JSON object per line, one line per build. */
export function readInventory(file: string): InventoryBuild[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as InventoryBuild)
}

/**
 * A file compressed as Cloudflare Pages compresses it for Chromium: brotli at quality 4. Pages
 * compresses on the fly, and on 2026-10-26 the app's 442,397-byte entry chunk came from
 * develop.fxmusic.pages.dev as 137,475 bytes of brotli; quality 4 gives 137,452 (quality 5:
 * 129,199; gzip -9: 138,391).
 */
export function brotli(bytes: Uint8Array): Buffer {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 4,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  })
}

/** The bytes Chromium downloads for a file from Cloudflare Pages: see {@link brotli}. */
export function transferSize(bytes: Uint8Array): number {
  return brotli(bytes).length
}

/** A feature whose code loads lazily, found by the modules that start it. */
export interface ChunkGroup<Name extends string = string> {
  readonly name: Name
  /** Modules that start the feature, relative to the repository root. */
  readonly roots: readonly string[]
  /**
   * Whether the chunks the roots' chunks load with `import()` count too, for a feature that
   * loads part of its code on first use (the YouTube provider and youtubei.js).
   */
  readonly dynamic?: boolean
  /**
   * The roots the first load holds today, as an exception: every other root must stay out of it,
   * and these must stay in it until they load lazily, when they come off this list. So a root
   * can't join the first load, in the entry chunk or in a chunk the entry imports, unnoticed.
   */
  readonly inFirstLoad?: readonly string[]
}

/** A file's size on disk and as downloaded (see {@link transferSize}), in bytes. */
export interface FileSize {
  readonly raw: number
  readonly transfer: number
}

/** A set of files and their sizes. */
export interface Files {
  readonly files: readonly string[]
  /** Bytes on disk. */
  readonly raw: number
  /** Bytes downloaded: see {@link transferSize}. */
  readonly transfer: number
}

/** A lazy feature's files and sizes. */
export interface GroupFiles extends Files {
  /** Its files that the first load already needs: they cost the feature nothing more. */
  readonly initial: readonly string[]
}

/** The first load's chunks, and each lazy feature's. */
export interface ChunkReport<Name extends string = string> {
  /** The entry chunk alone, the script `index.html` starts. */
  readonly entry: Files
  /** What `index.html` loads before the app runs: the entry chunk, its imports, its styles. */
  readonly initial: Files
  /** Each group: its roots' chunks, and the chunks they import that the first load doesn't. */
  readonly groups: Readonly<Record<Name, GroupFiles>>
  /** Every file counted above and its size, the largest download first: what grew. */
  readonly sizes: Readonly<Record<string, FileSize>>
}

/** The module every page of the app starts from. */
export const MAIN_MODULE = 'apps/web/src/main.tsx'

/**
 * The chunks the first load needs (`entry` and the chunks it imports, transitively) and those of
 * each group, from one app build's inventory: a group has the chunks of its roots (from the
 * app's build or a worker's), plus the chunks those import that the first load doesn't, and, if
 * it is `dynamic`, the chunks they load with `import()` and theirs. Throws when a root is in no
 * chunk, or in the first load without being one of the group's `inFirstLoad` (it would no longer
 * load lazily), or out of it while it is one of them: the budgets need a look.
 */
export function chunkGraph<Name extends string>(
  builds: readonly InventoryBuild[],
  root: string,
  groups: readonly ChunkGroup<Name>[],
): {
  entry: string
  initial: string[]
  groups: Record<Name, { files: string[]; initial: string[] }>
} {
  // The app's own build first: a module a worker shares is looked up in the app's chunks.
  const chunks = [...builds]
    .sort((a, b) => Number(b.environment === 'client') - Number(a.environment === 'client'))
    .flatMap((build) => build.chunks ?? [])
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const prefix = root.endsWith('/') ? root : `${root}/`
  const chunkOf = (module: string) =>
    chunks.find((chunk) => chunk.modules.some((id) => id === `${prefix}${module}`))
  const closure = (start: readonly string[]): Set<string> => {
    const seen = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const imported of byFile.get(file)?.imports ?? []) visit(imported)
    }
    for (const file of start) visit(file)
    return seen
  }

  const entry = chunkOf(MAIN_MODULE)
  if (entry === undefined)
    throw new Error(`No chunk holds ${MAIN_MODULE}: is this the app's inventory?`)
  const initial = closure([entry.fileName])
  const result = {} as Record<Name, { files: string[]; initial: string[] }>
  for (const group of groups) {
    const allowed = new Set(group.inFirstLoad ?? [])
    for (const module of allowed) {
      if (!group.roots.includes(module)) {
        throw new Error(`${group.name}: ${module} is in inFirstLoad but not in its roots`)
      }
    }
    const starts = group.roots.map((module) => {
      const chunk = chunkOf(module)
      if (chunk === undefined) {
        throw new Error(`${group.name}: no chunk holds ${module}; update the budgets' roots`)
      }
      const where = chunk === entry ? 'the entry chunk' : chunk.fileName
      if (initial.has(chunk.fileName) && !allowed.has(module)) {
        throw new Error(
          `${group.name}: ${module} is in the first load (${where}), so it no longer loads lazily: load it with import(), or list it in the group's inFirstLoad (budgets.ts)`,
        )
      }
      if (!initial.has(chunk.fileName) && allowed.has(module)) {
        throw new Error(
          `${group.name}: ${module} loads lazily now: take it off the group's inFirstLoad (budgets.ts), so it stays lazy`,
        )
      }
      return chunk.fileName
    })
    const lazy = group.dynamic
      ? starts.flatMap((file) => byFile.get(file)?.dynamicImports ?? [])
      : []
    const files = [...closure([...starts, ...lazy])].filter(
      (file) => starts.includes(file) || !initial.has(file),
    )
    result[group.name] = {
      files: files.sort(),
      initial: files.filter((file) => initial.has(file)).sort(),
    }
  }
  return { entry: entry.fileName, initial: [...initial].sort(), groups: result }
}

/** The stylesheets `index.html` links, as files relative to the app's folder. */
export function stylesheetsOf(html: string, base = '/app/'): string[] {
  const links = html.match(/<link\b[^>]*>/gu) ?? []
  return links
    .filter((link) => /\brel="stylesheet"/u.test(link))
    .map((link) => /\bhref="([^"]+)"/u.exec(link)?.[1] ?? '')
    .filter((href) => href.startsWith(base))
    .map((href) => href.slice(base.length))
}

/**
 * The chunk report of the app in `appDir` (dist/pages/app), from its build's inventory and the
 * repository root the build ran in.
 */
export function chunkReport<Name extends string>(
  appDir: string,
  inventoryFile: string,
  root: string,
  groups: readonly ChunkGroup<Name>[],
): ChunkReport<Name> {
  const graph = chunkGraph(readInventory(inventoryFile), root, groups)
  const sizes = new Map<string, FileSize>()
  const files = (list: readonly string[]): Files => {
    let raw = 0
    let transfer = 0
    for (const file of list) {
      let size = sizes.get(file)
      if (size === undefined) {
        const bytes = readFileSync(join(appDir, file))
        size = { raw: bytes.length, transfer: transferSize(bytes) }
        sizes.set(file, size)
      }
      raw += size.raw
      transfer += size.transfer
    }
    return { files: [...list], raw, transfer }
  }
  const styles = stylesheetsOf(readFileSync(join(appDir, 'index.html'), 'utf8'))
  const grouped = {} as Record<Name, GroupFiles>
  for (const { name } of groups) {
    grouped[name] = { ...files(graph.groups[name].files), initial: graph.groups[name].initial }
  }
  const entry = files([graph.entry])
  const initial = files([...graph.initial, ...styles])
  return {
    entry,
    initial,
    groups: grouped,
    sizes: Object.fromEntries([...sizes].sort(([, a], [, b]) => b.transfer - a.transfer)),
  }
}
