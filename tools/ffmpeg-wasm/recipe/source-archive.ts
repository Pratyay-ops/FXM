/**
 * FXM's recipe for the ffmpeg core as one archive, which the core carries next to the release
 * tarballs of its parts (`source/fxm-ffmpeg-core-recipe.tar`): this tool's folder,
 * tools/ffmpeg-wasm, the two scripts build.sh runs, scripts/env.sh and scripts/lib.sh, FXM's
 * licence and the checkout's Node version (.nvmrc). With those tarballs it is what the LGPL asks
 * to come with the core: the libraries' source, and what builds the core from it and links FXM's
 * converter with them. Unpacked, `tools/ffmpeg-wasm/recipe/build.sh` builds the core again
 * (tools/ffmpeg-wasm/README.md, "Building"). build.sh writes it:
 *
 *   node --experimental-strip-types source-archive.ts <out file> <checkout>
 *
 * It is a plain ustar archive, which every tar reads, and the same bytes for the same files on
 * every machine: its entries sorted by path under one folder, `fxm-ffmpeg-core-recipe/`, each
 * dated 1980-01-01, owned by user and group 0 without names, with mode 0755 for folders and for
 * files git keeps executable, else 0644. Files whose names start with a dot (an editor's, the
 * Finder's) stay out.
 *
 * @module
 */
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The folder every entry of the archive is in. */
export const RECIPE_ARCHIVE_ROOT = 'fxm-ffmpeg-core-recipe'

/** What the archive holds, by path in the checkout: folders whole, and single files. */
export const RECIPE_ARCHIVE_PATHS: readonly string[] = [
  'tools/ffmpeg-wasm',
  'scripts/env.sh',
  'scripts/lib.sh',
  'LICENSE',
  '.nvmrc',
]

/** 1980-01-01T00:00:00Z, the date of every entry, as zip files of reproducible builds use. */
export const ARCHIVE_MTIME = 315_532_800

/** One entry: a folder, or a file and its bytes. */
export interface ArchiveEntry {
  /** Its path in the archive, with `/` and no leading or trailing slash. */
  readonly path: string
  readonly mode: number
  /** A file's bytes; undefined for a folder. */
  readonly data?: Uint8Array
}

/**
 * The entries for `paths` of `root`: every file under them but dot files, and every folder on
 * the way, sorted by path, under {@link RECIPE_ARCHIVE_ROOT}.
 */
export function collectEntries(
  root: string,
  paths: readonly string[] = RECIPE_ARCHIVE_PATHS,
): ArchiveEntry[] {
  const entries = new Map<string, ArchiveEntry>()
  const folder = (path: string) => {
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/')
      if (!entries.has(at)) entries.set(at, { path: at, mode: 0o755 })
    }
  }
  const add = (path: string) => {
    const full = join(root, path)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      folder(`${RECIPE_ARCHIVE_ROOT}/${path}`)
      for (const name of readdirSync(full).sort()) {
        if (!name.startsWith('.')) add(`${path}/${name}`)
      }
      return
    }
    if (!stat.isFile()) throw new Error(`${path} is neither a file nor a folder`)
    const at = `${RECIPE_ARCHIVE_ROOT}/${path}`
    folder(at.slice(0, at.lastIndexOf('/')))
    entries.set(at, { path: at, mode: stat.mode & 0o111 ? 0o755 : 0o644, data: readFileSync(full) })
  }
  for (const path of paths) add(path)
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** An octal field of `width` bytes: digits, then a NUL. */
function octal(value: number, width: number): string {
  const digits = value.toString(8).padStart(width - 1, '0')
  if (digits.length > width - 1) throw new Error(`${value} doesn't fit in a ${width}-byte field`)
  return `${digits}\0`
}

/** The ustar header of one entry. */
function header(entry: ArchiveEntry): Uint8Array {
  const block = new Uint8Array(512)
  const put = (offset: number, text: string, width: number) => {
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > width) throw new Error(`"${text}" doesn't fit in a ${width}-byte field`)
    block.set(bytes, offset)
  }
  const path = entry.data === undefined ? `${entry.path}/` : entry.path
  // A path longer than 100 bytes goes into the prefix field, split at a slash.
  let name = path
  let prefix = ''
  if (Buffer.byteLength(path) > 100) {
    const at = path.lastIndexOf('/', path.length - 2)
    prefix = path.slice(0, at)
    name = path.slice(at + 1)
  }
  put(0, name, 100)
  put(100, octal(entry.mode, 8), 8)
  put(108, octal(0, 8), 8)
  put(116, octal(0, 8), 8)
  put(124, octal(entry.data?.length ?? 0, 12), 12)
  put(136, octal(ARCHIVE_MTIME, 12), 12)
  put(148, '        ', 8)
  put(156, entry.data === undefined ? '5' : '0', 1)
  put(257, 'ustar\0', 6)
  put(263, '00', 2)
  put(329, octal(0, 8), 8)
  put(337, octal(0, 8), 8)
  put(345, prefix, 155)
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `, 8)
  return block
}

/** The archive of `entries`, ended by two empty blocks and padded to 10 KiB records, as tar does. */
export function ustar(entries: readonly ArchiveEntry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    chunks.push(header(entry))
    if (entry.data !== undefined) {
      chunks.push(entry.data)
      const rest = entry.data.length % 512
      if (rest > 0) chunks.push(new Uint8Array(512 - rest))
    }
  }
  chunks.push(new Uint8Array(1024))
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const record = 10_240
  if (size % record > 0) chunks.push(new Uint8Array(record - (size % record)))
  return Buffer.concat(chunks)
}

function main(args: readonly string[]): number {
  const [out, root] = args
  if (!out || !root) {
    console.error('usage: source-archive.ts <out file> <checkout>')
    return 2
  }
  writeFileSync(out, ustar(collectEntries(resolve(root))))
  return 0
}

/**
 * Whether this file runs as a script (`node <file> …`) rather than as an import. Both paths are
 * resolved to their real paths, so it also runs from a folder behind a symbolic link, such as
 * macOS's /tmp.
 */
function runAsScript(): boolean {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (runAsScript()) {
  process.exitCode = main(process.argv.slice(2))
}
