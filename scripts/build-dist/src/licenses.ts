/**
 * Which npm packages end up in the files FXM deploys, under which licences.
 *
 * The site and the web app are built with hidden source maps (`make dist` never deploys them),
 * and every source a map names under `node_modules/` is a bundled package. What has no source
 * map comes from two more lists:
 *
 * - the bundler's module list (`bundle-inventory.ts`): stylesheets, fonts, images and
 *   WebAssembly that a build takes from a package;
 * - `/*! name vX.Y.Z | Licence` banners in stylesheets, which build tools such as Tailwind add
 *   when they copy their own code into the output.
 *
 * JavaScript without a source map fails, unless the module list shows that its chunk holds only
 * the bundler's own runtime (BUNDLER_RUNTIME_MODULES).
 *
 * From that list `make dist` writes the third-party notices file, and fails when a package's
 * licence is not one FXM accepts (ARCHITECTURE.md §17 and §18): GPL and AGPL never, and any
 * other licence only after a human review recorded in LICENCE_OVERRIDES.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface BundledPackage {
  readonly name: string
  readonly version: string
  /** The package's folder. */
  readonly dir: string
  /** The SPDX expression from package.json (or LICENCE_OVERRIDES), if any. */
  readonly license: string | undefined
  /** The licence comes from LICENCE_OVERRIDES: a human reviewed it. */
  readonly reviewed: boolean
  readonly homepage: string | undefined
  /** The parts of the site that contain it: site, app, embed, sandbox. */
  readonly usedIn: Set<string>
}

/**
 * Licences a human confirmed for a package version, keyed by `name@version`, with the reason:
 * for a package whose package.json declares none FXM can read, or one outside
 * ACCEPTED_LICENCES that turned out fine to ship. GPL and AGPL stay refused. Empty today.
 */
export const LICENCE_OVERRIDES: Readonly<Record<string, { license: string; reason: string }>> = {}

/**
 * WebAssembly that no npm package supplies (copied from `public/`, say), keyed by its SHA-256 in
 * hex, after a human reviewed its licence. A changed binary needs a new review. Empty today:
 * 4.2's LGPL ffmpeg core is checked by its own recipe's checks instead (`Part.prebuilt`,
 * src/ffmpeg-core.ts).
 */
export const REVIEWED_BINARIES: Readonly<
  Record<string, { name: string; license: string; reason: string }>
> = {}

/**
 * The licences FXM ships third-party code under, as SPDX ids (matched case-insensitively, as
 * SPDX specifies): permissive ones, the weak copylefts that apply per file or per library
 * (MPL, LGPL), and licences for fonts, data and text. Anything else, such as the non-SPDX
 * "GPLv3" or "BSD", network copyleft (SSPL-1.0), strong copyleft (OSL-3.0, EUPL-1.2),
 * source-available (BUSL-1.1) or non-commercial (CC-BY-NC-4.0), fails until reviewed.
 */
export const ACCEPTED_LICENCES: ReadonlySet<string> = new Set(
  [
    '0BSD',
    'Apache-2.0',
    'BlueOak-1.0.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'BSL-1.0',
    'CC-BY-3.0',
    'CC-BY-4.0',
    'CC0-1.0',
    'ISC',
    'LGPL-2.1',
    'LGPL-2.1+',
    'LGPL-2.1-only',
    'LGPL-2.1-or-later',
    'LGPL-3.0',
    'LGPL-3.0+',
    'LGPL-3.0-only',
    'LGPL-3.0-or-later',
    'MIT',
    'MIT-0',
    'MPL-2.0',
    'OFL-1.1',
    'Python-2.0',
    'Unicode-3.0',
    'Unicode-DFS-2016',
    'Unlicense',
    'Zlib',
  ].map((id) => id.toLowerCase()),
)

/** SPDX licence exceptions, which only add permissions to the licence they follow. */
const KNOWN_EXCEPTIONS: ReadonlySet<string> = new Set(
  [
    'Autoconf-exception-3.0',
    'Bison-exception-2.2',
    'Classpath-exception-2.0',
    'Font-exception-2.0',
    'GCC-exception-3.1',
    'LLVM-exception',
    'OpenJDK-assembly-exception-1.0',
    'Qt-LGPL-exception-1.1',
    'Swift-exception',
    'WxWindows-exception-3.1',
  ].map((id) => id.toLowerCase()),
)

const NODE_MODULES = `${sep}node_modules${sep}`

/** The folder of the package a file belongs to, or undefined outside node_modules. */
export function packageDirOf(file: string): string | undefined {
  const at = file.lastIndexOf(NODE_MODULES)
  if (at === -1) return undefined
  const base = file.slice(0, at + NODE_MODULES.length)
  const [first, second] = file.slice(base.length).split(sep)
  if (!first) return undefined
  if (first.startsWith('@')) return second ? join(base, first, second) : undefined
  return join(base, first)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** A package.json, read as plain JSON: its fields are checked where they are used. */
type PackageJson = Readonly<Record<string, unknown>>

function readPackageJson(dir: string): PackageJson {
  const file = join(dir, 'package.json')
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} can't be read: ${(error as Error).message}`)
  }
  if (!isObject(pkg)) throw new Error(`${file} is not a JSON object`)
  return pkg
}

/**
 * package.json's licence as one SPDX expression: the `license` string, or the legacy
 * `license: { type }`, `licenses: { type }` or `licenses: [{ type }, …]` (a choice). Anything
 * malformed counts as no licence, so the check fails and names the package.
 */
export function licenseOf(pkg: PackageJson): string | undefined {
  const { license, licenses } = pkg
  if (typeof license === 'string') return stringOf(license)
  if (isObject(license)) return stringOf(license.type)
  const entries = Array.isArray(licenses) ? licenses : isObject(licenses) ? [licenses] : []
  const types = entries.map((entry) => (isObject(entry) ? stringOf(entry.type) : undefined))
  if (types.length === 0 || types.some((type) => type === undefined)) return undefined
  return types.length === 1 ? types[0] : `(${types.join(' OR ')})`
}

function homepageOf(pkg: PackageJson): string | undefined {
  const homepage = stringOf(pkg.homepage)
  if (homepage) return homepage
  const { repository } = pkg
  const url = stringOf(isObject(repository) ? repository.url : repository)
  return url?.replace(/^git\+/, '').replace(/\.git$/, '')
}

function addPackage(into: Map<string, BundledPackage>, dir: string, part: string): void {
  const existing = into.get(dir)
  if (existing) {
    existing.usedIn.add(part)
    return
  }
  const pkg = readPackageJson(dir)
  const name = stringOf(pkg.name)
  const version = stringOf(pkg.version)
  if (!name || !version) throw new Error(`${join(dir, 'package.json')} has no name or version`)
  const override = LICENCE_OVERRIDES[`${name}@${version}`]
  into.set(dir, {
    name,
    version,
    dir,
    license: override?.license ?? licenseOf(pkg),
    reviewed: override !== undefined,
    homepage: homepageOf(pkg),
    usedIn: new Set([part]),
  })
}

/** Adds the package that holds `file`, when it is in node_modules. Returns its folder. */
function addPackageOf(
  file: string,
  part: string,
  into: Map<string, BundledPackage>,
  source: string,
): string | undefined {
  const dir = packageDirOf(file)
  if (!dir) return undefined
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`${source} names ${file}, but ${dir} has no package.json`)
  }
  addPackage(into, dir, part)
  return dir
}

/**
 * Adds every package the source maps point into. Returns the sources that are neither FXM's
 * own files nor in node_modules (bundler helpers with virtual names), for the log.
 */
export function addPackagesFromSourceMaps(
  mapFiles: readonly string[],
  part: string,
  root: string,
  into: Map<string, BundledPackage>,
): string[] {
  const unattributed: string[] = []
  for (const mapFile of mapFiles) {
    let map: unknown
    try {
      map = JSON.parse(readFileSync(mapFile, 'utf8'))
    } catch (error) {
      throw new Error(`${mapFile} can't be read: ${(error as Error).message}`)
    }
    if (!isObject(map) || !Array.isArray(map.sources)) {
      throw new Error(`${mapFile} is not a source map with a sources list`)
    }
    const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
    for (const source of map.sources) {
      // The source map format allows null for a source without a name.
      if (typeof source !== 'string') continue
      // Vite plugins name sub-modules with a query, such as Astro's `Header.astro?astro&type=script`.
      const file = source.replace(/\?.*$/, '')
      const path = file.startsWith('file://')
        ? fileURLToPath(file)
        : resolve(dirname(mapFile), sourceRoot, file)
      if (addPackageOf(path, part, into, basename(mapFile))) continue
      if (!(path.startsWith(root + sep) && existsSync(path))) unattributed.push(source)
    }
  }
  return unattributed
}

/** What `bundle-inventory.ts` records for one build of one environment. */
export interface InventoryEntry {
  /** The environment: client, ssr, prerender, … */
  readonly environment: string
  /** Every module the bundler loaded, as absolute paths (queries kept). */
  readonly modules: readonly string[]
  /** The files the build emitted that are not chunks, with the source files they came from. */
  readonly assets: readonly { readonly fileName: string; readonly sources: readonly string[] }[]
  /** The chunks the build emitted, with the modules in each. */
  readonly chunks?: readonly { readonly fileName: string; readonly modules: readonly string[] }[]
}

/** Reads a part's inventory file: one JSON object per line, one line per build. */
export function readInventory(file: string): InventoryEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const entry: unknown = JSON.parse(line)
      const strings = (value: unknown) =>
        Array.isArray(value) && value.every((item) => typeof item === 'string')
      if (
        !isObject(entry) ||
        typeof entry.environment !== 'string' ||
        !strings(entry.modules) ||
        !Array.isArray(entry.assets) ||
        !entry.assets.every(
          (asset) =>
            isObject(asset) && typeof asset.fileName === 'string' && strings(asset.sources),
        ) ||
        (entry.chunks !== undefined &&
          !(
            Array.isArray(entry.chunks) &&
            entry.chunks.every(
              (chunk) =>
                isObject(chunk) && typeof chunk.fileName === 'string' && strings(chunk.modules),
            )
          ))
      ) {
        throw new Error(`${file}, line ${index + 1}: not an inventory entry`)
      }
      return entry as unknown as InventoryEntry
    })
}

/**
 * The modules the bundler writes itself, from no source file: Rolldown's runtime (its
 * CommonJS and namespace helpers) and Vite's preload helper and polyfill. Builds usually keep
 * them inside other chunks. When the bundler gives them a chunk of their own, that chunk has no
 * source map, and needs none: it holds no dependency's code. Any other chunk without a source
 * map still fails.
 */
export const BUNDLER_RUNTIME_MODULES: ReadonlySet<string> = new Set([
  '\0rolldown/runtime.js',
  '\0vite/preload-helper.js',
  '\0vite/modulepreload-polyfill.js',
])

/** The chunks that hold only the bundler's runtime, by output file name, with their modules. */
export function bundlerRuntimeChunks(
  entries: readonly InventoryEntry[],
): Map<string, readonly string[]> {
  const runtime = new Map<string, readonly string[]>()
  for (const entry of entries) {
    for (const chunk of entry.chunks ?? []) {
      if (
        chunk.modules.length > 0 &&
        chunk.modules.every((id) => BUNDLER_RUNTIME_MODULES.has(id))
      ) {
        runtime.set(chunk.fileName, chunk.modules)
      }
    }
  }
  return runtime
}

/** Modules whose code reaches the output through the source maps: scripts without a query. */
const SCRIPT_MODULE = /\.(?:[cm]?[jt]sx?|json|astro|vue|svelte)$/i

/**
 * Adds the packages a build took files from that its source maps don't show: stylesheets,
 * fonts, images and WebAssembly, and files imported with a query such as `?url` or `?raw`.
 * Returns, for each emitted asset, whether a package supplied it (by its output file name).
 */
export function addPackagesFromInventory(
  entries: readonly InventoryEntry[],
  part: string,
  into: Map<string, BundledPackage>,
): Map<string, 'package' | 'own'> {
  const label = `the ${part} build's module list`
  for (const entry of entries) {
    for (const id of entry.modules) {
      const [path = '', query] = id.replace(/^\0/, '').split('?')
      if (query === undefined && SCRIPT_MODULE.test(path)) continue
      addPackageOf(path, part, into, label)
    }
  }
  const origins = new Map<string, 'package' | 'own'>()
  for (const entry of entries) {
    for (const asset of entry.assets) {
      // Every source, not only the first from a package: each package gets its notice.
      const packages = asset.sources.map((source) => addPackageOf(source, part, into, label))
      const fromPackage = packages.some((dir) => dir !== undefined)
      if (fromPackage || !origins.has(asset.fileName)) {
        origins.set(asset.fileName, fromPackage ? 'package' : 'own')
      }
    }
  }
  return origins
}

const BANNER = /\/\*!\s*(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)\s+v(\d+\.\d+\.\d+[\w.+-]*)/gi

/** Finds the installed copy of name@version in pnpm's store layout under root. */
export function findInstalledPackage(
  root: string,
  name: string,
  version: string,
): string | undefined {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  const prefix = `${name.replace('/', '+')}@${version}`
  for (const entry of readdirSync(store).sort()) {
    if (entry !== prefix && !entry.startsWith(`${prefix}_`)) continue
    const dir = join(store, entry, 'node_modules', name)
    if (existsSync(join(dir, 'package.json')) && readPackageJson(dir).version === version)
      return dir
  }
  return undefined
}

/** Adds the packages named in `/*! name vX.Y.Z … *\/` banners of the given stylesheets. */
export function addPackagesFromBanners(
  cssFiles: readonly string[],
  part: string,
  root: string,
  into: Map<string, BundledPackage>,
): void {
  for (const file of cssFiles) {
    for (const [, name, version] of readFileSync(file, 'utf8').matchAll(BANNER)) {
      const dir = findInstalledPackage(root, name as string, version as string)
      if (!dir) {
        throw new Error(`${basename(file)} contains ${name} ${version}, which is not installed`)
      }
      addPackage(into, dir, part)
    }
  }
}

/**
 * Why shipped WebAssembly can't be attributed (an empty list when it can): each `.wasm` file
 * must come from an npm package, which the licence check then covers, or be listed by its hash
 * in REVIEWED_BINARIES. Binaries have no source map, and the stock ffmpeg core is GPL
 * (ARCHITECTURE.md §17), so one copied into `public/` must not ship unnoticed.
 */
export function binaryProblems(
  part: string,
  dir: string,
  files: readonly string[],
  origins: ReadonlyMap<string, 'package' | 'own'>,
  reviewed: Readonly<Record<string, unknown>> = REVIEWED_BINARIES,
): string[] {
  const problems: string[] = []
  for (const file of files.filter((name) => /\.wasm$/i.test(name))) {
    if (origins.get(file) === 'package') continue
    const hash = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex')
    if (Object.hasOwn(reviewed, hash)) continue
    problems.push(
      `${part} ships ${file}, WebAssembly from no npm package: review its licence and add its SHA-256 (${hash}) to REVIEWED_BINARIES in src/licenses.ts`,
    )
  }
  return problems
}

/**
 * Why an inline script or style of a part without source maps may hold third-party code (an
 * empty list when nothing suggests it): licence banners, or a size only a bundle reaches.
 * Such a part (the sandbox documents) must then be built with source maps instead.
 */
export function inlineCodeProblems(part: string, file: string, code: string): string[] {
  const problems: string[] = []
  const banner = /@license|@preserve|\/\*!|SPDX-License-Identifier|\bcopyright\b/i.exec(code)
  if (banner) {
    problems.push(
      `${part}: ${file} inlines code with a licence notice ("${banner[0]}"), but builds no source maps to show which packages it contains`,
    )
  }
  if (Buffer.byteLength(code) > MAX_INLINE_BYTES) {
    problems.push(
      `${part}: ${file} inlines ${Buffer.byteLength(code)} bytes of code, more than FXM's own code in a document needs (${MAX_INLINE_BYTES}): build it with source maps so the licence check sees what it contains`,
    )
  }
  return problems
}

/** The most inline code a document of a part without source maps may hold. */
export const MAX_INLINE_BYTES = 64 * 1024

type LicenseNode =
  | { type: 'license'; id: string; exception?: string }
  | { type: 'and' | 'or'; left: LicenseNode; right: LicenseNode }

const SPDX_ID = /^[A-Za-z0-9.+:-]+$/

/** Parses an SPDX licence expression. Throws on anything else. */
export function parseLicenseExpression(expression: string): LicenseNode {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? []
  let position = 0
  const peek = () => tokens[position]?.toUpperCase()
  const take = () => tokens[position++]
  const atom = (): LicenseNode => {
    const token = take()
    if (token === undefined) throw new Error('unexpected end')
    if (token === '(') {
      const node = or()
      if (take() !== ')') throw new Error('missing )')
      return node
    }
    if (!SPDX_ID.test(token) || ['AND', 'OR', 'WITH', ')'].includes(token.toUpperCase())) {
      throw new Error(`unexpected ${token}`)
    }
    if (peek() !== 'WITH') return { type: 'license', id: token }
    take()
    const exception = take()
    if (!exception || !SPDX_ID.test(exception)) throw new Error('missing exception after WITH')
    return { type: 'license', id: token, exception }
  }
  const and = (): LicenseNode => {
    let node = atom()
    while (peek() === 'AND') {
      take()
      node = { type: 'and', left: node, right: atom() }
    }
    return node
  }
  const or = (): LicenseNode => {
    let node = and()
    while (peek() === 'OR') {
      take()
      node = { type: 'or', left: node, right: and() }
    }
    return node
  }
  const node = or()
  if (position !== tokens.length) throw new Error(`unexpected ${tokens[position]}`)
  return node
}

/**
 * GPL and AGPL in any version, variant or spelling (`GPL-3.0`, `GPLv3`, `AGPL3`, `GPL-2.0+`),
 * with or without exceptions. LGPL is not: it applies to the library alone.
 */
export function isGplFamily(id: string): boolean {
  return /(^|[^L])GPL/i.test(id)
}

const NOT_A_LICENCE = new Set(['UNLICENSED', 'NONE', 'NOASSERTION'])

type Verdict = 'ok' | 'gpl' | 'unknown'

/**
 * Whether FXM may ship a package under this licence expression, and why not. `reviewed`: the
 * expression comes from LICENCE_OVERRIDES, so any licence but GPL and AGPL is accepted.
 */
export function evaluateLicense(
  expression: string | undefined,
  { reviewed = false } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!expression) return { ok: false, reason: 'its package.json declares no licence' }
  if (/^SEE LICEN[CS]E IN /i.test(expression)) {
    return {
      ok: false,
      reason: `it has a custom licence (${expression}): review it and add it to LICENCE_OVERRIDES`,
    }
  }
  let tree: LicenseNode
  try {
    tree = parseLicenseExpression(expression)
  } catch (error) {
    if (isGplFamily(expression)) return gplVerdict(expression)
    return {
      ok: false,
      reason: `"${expression}" is not an SPDX expression (${(error as Error).message}): review the licence and add it to LICENCE_OVERRIDES`,
    }
  }
  const verdict = (node: LicenseNode): Verdict => {
    if (node.type === 'license') {
      if (isGplFamily(node.id)) return 'gpl'
      if (NOT_A_LICENCE.has(node.id.toUpperCase())) return 'unknown'
      const exception = node.exception?.toLowerCase()
      if (exception !== undefined && !KNOWN_EXCEPTIONS.has(exception) && !reviewed) return 'unknown'
      return reviewed || ACCEPTED_LICENCES.has(node.id.toLowerCase()) ? 'ok' : 'unknown'
    }
    const sides = [verdict(node.left), verdict(node.right)]
    if (node.type === 'or') {
      if (sides.includes('ok')) return 'ok'
      return sides.includes('unknown') ? 'unknown' : 'gpl'
    }
    if (sides.includes('gpl')) return 'gpl'
    return sides.includes('unknown') ? 'unknown' : 'ok'
  }
  const result = verdict(tree)
  if (result === 'ok') return { ok: true }
  if (result === 'gpl') return gplVerdict(expression)
  if (/(LicenseRef|DocumentRef)-/i.test(expression)) {
    return {
      ok: false,
      reason: `it has a custom licence (${expression}): review it and add it to LICENCE_OVERRIDES`,
    }
  }
  if (NOT_A_LICENCE.has(expression.toUpperCase())) {
    return { ok: false, reason: `${expression} is not a licence FXM can ship under` }
  }
  return {
    ok: false,
    reason: `${expression} is not a licence FXM accepts (ACCEPTED_LICENCES in src/licenses.ts): review it and add it to LICENCE_OVERRIDES`,
  }
}

function gplVerdict(expression: string): { ok: false; reason: string } {
  return {
    ok: false,
    reason: `${expression} is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)`,
  }
}

/** Why the bundled packages can't ship, one line each (an empty list when they can). */
export function licenseProblems(packages: Iterable<BundledPackage>): string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    const verdict = evaluateLicense(pkg.license, { reviewed: pkg.reviewed })
    if (!verdict.ok) {
      problems.push(
        `${pkg.name}@${pkg.version} (in ${[...pkg.usedIn].sort().join(', ')}): ${verdict.reason}`,
      )
    }
  }
  return problems
}

/** The licence, copying and notice files a package ships, with their contents. */
export function licenseFiles(dir: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((name) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }))
}

const RULE = '='.repeat(78)

/**
 * The third-party notices file for everything FXM deploys: the bundled packages, then the
 * entries of files FXM builds from its own recipes (`prebuilt`, such as the ffmpeg core).
 */
export function renderNotices(
  packages: Iterable<BundledPackage>,
  repositoryUrl: string,
  prebuilt: readonly string[] = [],
): string {
  const sorted = [...packages].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
  const lines = [
    'FXM third-party notices',
    '',
    `FXM is open source under the Apache License 2.0: ${repositoryUrl}`,
    'Its website, web app and embed include code from the open-source packages below,',
    'each under its own licence.',
    '',
    'make dist writes this file from the source maps of the build it deploys.',
  ]
  if (sorted.length === 0) lines.push('', 'This build includes no third-party packages.')
  for (const pkg of sorted) {
    lines.push('', RULE, `${pkg.name} ${pkg.version}`, `Licence: ${pkg.license ?? 'unknown'}`)
    lines.push(`Used in: ${[...pkg.usedIn].sort().join(', ')}`)
    if (pkg.homepage) lines.push(pkg.homepage)
    const files = licenseFiles(pkg.dir)
    if (files.length === 0)
      lines.push('', `The package ships no licence file; its package.json says ${pkg.license}.`)
    for (const file of files) {
      if (files.length > 1) lines.push('', `--- ${file.name}`)
      lines.push('', file.text)
    }
  }
  for (const notice of prebuilt) lines.push('', RULE, notice)
  return `${lines.join('\n')}\n`
}
