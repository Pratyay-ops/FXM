/**
 * Which npm packages end up in the files FXM deploys, under which licences.
 *
 * The site and the web app are built with hidden source maps (`make dist` never deploys them),
 * and every source a map names under `node_modules/` is a bundled package. A source that is no
 * file must be accounted for: a Vite plugin's virtual module maps to its package through
 * VIRTUAL_MODULES, and only Workbox's generated service worker entry and the bundler's own runtime
 * (BUNDLER_RUNTIME_MODULES) need no package. Anything else fails. What has no source map comes
 * from three more lists:
 *
 * - the bundler's module list (`bundle-inventory.ts`): stylesheets, fonts, images and
 *   WebAssembly that a build takes from a package;
 * - `/*! name vX.Y.Z | Licence` banners in stylesheets, which build tools such as Tailwind add
 *   when they copy their own code into the output;
 * - the `//#region <path>` markers bundlers leave in the unminified inline scripts of the parts
 *   without source maps (the sandbox documents).
 *
 * JavaScript without a source map fails, unless the module list shows that its chunk holds only
 * the bundler's own runtime (BUNDLER_RUNTIME_MODULES).
 *
 * From that list `make dist` writes the third-party notices file: each package's licence files
 * and the notices its bundled files add to them (`notices.ts`). It fails when a package's licence
 * is not one FXM accepts (ARCHITECTURE.md §17 and §18): GPL and AGPL never, and any other licence
 * only after a human review recorded in LICENCE_OVERRIDES. It also fails when a package ships no
 * licence text and no review in REVIEWED_LICENCE_TEXTS says what covers it, and when code under
 * the LGPL shares a chunk with other code.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageNotices } from './notices.ts'

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
  /** Its files the build bundles, as the source maps and region markers name them. */
  readonly files: Set<string>
}

/**
 * Licences a human confirmed for a package version, keyed by `name@version`, with the reason:
 * for a package whose package.json declares none FXM can read, or one outside
 * ACCEPTED_LICENCES that turned out fine to ship. GPL and AGPL stay refused. Empty today.
 */
export const LICENCE_OVERRIDES: Readonly<Record<string, { license: string; reason: string }>> = {}

/**
 * WebAssembly that no npm package supplies (copied from `public/`, or built by FXM), keyed by
 * its SHA-256 in hex, after a human reviewed its licence: 4.2's own LGPL build of the ffmpeg
 * core, for example. A changed binary needs a new review. Empty today.
 */
export const REVIEWED_BINARIES: Readonly<
  Record<string, { name: string; license: string; reason: string }>
> = {}

/** What covers a package that ships no licence text of its own (REVIEWED_LICENCE_TEXTS). */
export interface LicenceTextReview {
  /**
   * The licence FXM uses the package under, which its licence expression must offer, and whose
   * full text the notices file carries: `Apache-2.0`, FXM's own licence (the repository's
   * LICENSE). Another licence needs its text added to the notices first.
   */
  readonly license: 'Apache-2.0'
  /** Why that text, with the notices in the package's files, is all its licence asks for. */
  readonly reason: string
}

/**
 * Packages that ship no licence text of their own (no licence file, or only SPDX metadata such as
 * `LICENSE.spdx`), keyed by `name@version`, after a human checked what covers them. Their
 * notices name the licence and carry the copyright and licence comments of their files. A new
 * version needs a new review.
 */
export const REVIEWED_LICENCE_TEXTS: Readonly<Record<string, LicenceTextReview>> = {
  '@bufbuild/protobuf@2.16.0': {
    license: 'Apache-2.0',
    reason:
      "Licensed (Apache-2.0 AND BSD-3-Clause), with no licence file. Its files carry Buf's Apache-2.0 header. The BSD-3-Clause part is the varint code it took from Google's protobuf, whose file (dist/esm/wire/varint.js) keeps the whole BSD-3-Clause notice, which the notices reproduce. Reviewed 2026-10-26.",
  },
  '@tauri-apps/plugin-http@2.8.2': {
    license: 'Apache-2.0',
    reason:
      'Licensed MIT OR Apache-2.0. Its npm package ships only LICENSE.spdx (the crate of the same version has LICENSE_MIT and LICENSE_APACHE-2.0), so FXM uses it under Apache-2.0, with the copyright header of its files. Reviewed 2026-10-26.',
  },
}

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

/** Hosts of the `provider:owner/repo` shorthands npm accepts in `repository`. */
const SHORTHAND_HOSTS: Readonly<Record<string, string>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
}

/**
 * A repository as a link people can open: npm's shorthands (`owner/repo`, `github:owner/repo`,
 * `gitlab:…`, `bitbucket:…`, `gist:id`) and git URLs (`git://`, `git+https://`, `git+ssh://`,
 * `git@host:owner/repo`) become `https://` addresses, without `.git`. Anything else stays as it is.
 */
export function repositoryLink(repository: string): string {
  const value = repository.trim()
  const gist = /^gist:([\w-]+)$/.exec(value)
  if (gist) return `https://gist.github.com/${gist[1]}`
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(value)
  if (shorthand) {
    const [, provider = 'github', owner, repo] = shorthand
    return `https://${SHORTHAND_HOSTS[provider]}/${owner}/${repo}`
  }
  const url = value.replace(/^git\+/, '')
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  const remote = /^(?:git|ssh|https?):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(
    url,
  )
  if (remote) return `https://${remote[1]}/${remote[2]}`
  return value
}

function homepageOf(pkg: PackageJson): string | undefined {
  const homepage = stringOf(pkg.homepage)
  if (homepage) return homepage
  const { repository } = pkg
  const url = stringOf(isObject(repository) ? repository.url : repository)
  return url === undefined ? undefined : repositoryLink(url)
}

function addPackage(
  into: Map<string, BundledPackage>,
  dir: string,
  part: string,
  file?: string,
): void {
  const existing = into.get(dir)
  if (existing) {
    existing.usedIn.add(part)
    if (file !== undefined) existing.files.add(file)
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
    files: new Set(file === undefined ? [] : [file]),
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
  addPackage(into, dir, part, file)
  return dir
}

/**
 * A module a Vite plugin generates under a virtual name, which a source map names as no file,
 * and the npm package whose code it is.
 */
export interface VirtualModule {
  /** The source's path as the map resolves it, such as `/@vite-plugin-pwa/virtual:pwa-register`. */
  readonly source: string
  /** The package whose code the module is. */
  readonly package: string
  /** The workspace package that depends on it, relative to the repository root: where to find it. */
  readonly from: string
}

/**
 * Virtual modules mapped to the packages whose code they are, after a human read the plugin's
 * code: each package then gets its notice like any other. make dist fails on a virtual module
 * that isn't listed, so a new plugin's client code can't ship unattributed.
 */
export const VIRTUAL_MODULES: readonly VirtualModule[] = [
  {
    // vite-plugin-pwa 2.0's load hook returns its own dist/client/build/register.js with the
    // service worker's URL, scope and type filled in (read 2026-10-26): `registerSW` in main.tsx.
    source: '/@vite-plugin-pwa/virtual:pwa-register',
    package: 'vite-plugin-pwa',
    from: 'apps/web',
  },
]

/** The folder of `name` as Node finds it from `from` (inside `root`), as a real path. */
export function findPackageFrom(root: string, from: string, name: string): string | undefined {
  let dir = resolve(root, from)
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dir === root || dirname(dir) === dir) return undefined
    dir = dirname(dir)
  }
}

/**
 * Whether a source is the service worker entry Workbox generates (vite-plugin-pwa's
 * `generateSW`): Workbox writes its `sw.js` template, filled in, to a new folder in the system's
 * temporary folder (named with 32 hexadecimal digits) and bundles it with the Workbox packages it
 * imports, which the map names as files of their own.
 */
export function isWorkboxEntry(
  mapFile: string,
  path: string,
  temporary: string = realpathSync(tmpdir()),
): boolean {
  return (
    basename(mapFile) === 'sw.js.map' &&
    basename(path) === 'sw.js' &&
    /^[0-9a-f]{32}$/.test(basename(dirname(path))) &&
    dirname(dirname(path)) === temporary
  )
}

/** What a part's source maps name besides its files and its packages' files. */
export interface SourceMapScan {
  /** Sources that are no file but are accounted for: virtual modules, Workbox's entry, the runtime. */
  readonly generated: string[]
  /** Sources that are neither FXM's files, nor in node_modules, nor accounted for: make dist fails. */
  readonly unknown: string[]
}

/**
 * Adds every package the source maps point into, and the packages of the virtual modules they
 * name (VIRTUAL_MODULES). Every other source must be one of FXM's own files, Workbox's generated
 * entry or a module of the bundler's runtime; the rest come back as `unknown`.
 */
export function addPackagesFromSourceMaps(
  mapFiles: readonly string[],
  part: string,
  root: string,
  into: Map<string, BundledPackage>,
  { temporary }: { temporary?: string } = {},
): SourceMapScan {
  const scan: SourceMapScan = { generated: [], unknown: [] }
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
      if (BUNDLER_RUNTIME_MODULES.has(`\0${source.replace(/^\0/, '')}`)) {
        scan.generated.push(source)
        continue
      }
      // Vite plugins name sub-modules with a query, such as Astro's `Header.astro?astro&type=script`.
      const file = source.replace(/\?.*$/, '')
      const path = file.startsWith('file://')
        ? fileURLToPath(file)
        : resolve(dirname(mapFile), sourceRoot, file)
      if (addPackageOf(path, part, into, basename(mapFile))) continue
      if (path.startsWith(root + sep) && existsSync(path)) continue
      const posix = path
        .replace(/^[A-Za-z]:/, '')
        .split(sep)
        .join('/')
      const virtual = VIRTUAL_MODULES.find((module) => module.source === posix)
      if (virtual) {
        const dir = findPackageFrom(root, virtual.from, virtual.package)
        if (!dir) {
          throw new Error(
            `${basename(mapFile)} holds ${virtual.source}, ${virtual.package}'s code, but ${virtual.package} isn't installed for ${virtual.from}`,
          )
        }
        addPackage(into, dir, part)
        scan.generated.push(source)
      } else if (isWorkboxEntry(mapFile, path, temporary)) {
        scan.generated.push(source)
      } else {
        scan.unknown.push(source)
      }
    }
  }
  return scan
}

/**
 * The paths a bundler's `//#region <path>` markers name in an unminified script: the modules it
 * holds, relative to the folder the bundler ran in.
 */
export function regionPaths(code: string): string[] {
  return [...code.matchAll(/^[ \t]*\/\/#region (.+?)\s*$/gm)].map(([, path]) => path as string)
}

/**
 * Adds the packages that the inline scripts of a part without source maps bundle, from the
 * `//#region` markers Rolldown leaves in an unminified bundle (the sandbox documents, such as
 * 1.11's `eval.html` with bgutils-js). A marker's path is relative to the folder the bundler ran
 * in, which the document doesn't say; a path through `node_modules/` is looked up in the
 * repository's own `node_modules/`, where pnpm keeps every package. Returns why a marker can't
 * be attributed (an empty list when every one can).
 */
export function addPackagesFromRegions(
  scripts: readonly string[],
  part: string,
  document: string,
  root: string,
  into: Map<string, BundledPackage>,
): string[] {
  const problems: string[] = []
  for (const script of scripts) {
    for (const region of regionPaths(script)) {
      const at = region.indexOf('node_modules/')
      if (at === -1) continue
      const file = join(root, region.slice(at))
      if (!existsSync(file)) {
        problems.push(
          `${part}: ${document} bundles ${region}, which make dist can't find in ${join(root, 'node_modules')}`,
        )
        continue
      }
      addPackageOf(file, part, into, `${part}/${document}`)
    }
  }
  return problems
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

/** The licence ids an SPDX expression names, or none when it isn't one. */
function licenceIds(expression: string | undefined): string[] {
  if (!expression) return []
  let tree: LicenseNode
  try {
    tree = parseLicenseExpression(expression)
  } catch {
    return []
  }
  const ids = (node: LicenseNode): string[] =>
    node.type === 'license' ? [node.id] : [...ids(node.left), ...ids(node.right)]
  return ids(tree)
}

/**
 * Why a bundled package's notice would lack a licence text (an empty list when none would): a
 * package needs licence files of its own (SPDX metadata such as `LICENSE.spdx` doesn't count), or
 * a review in REVIEWED_LICENCE_TEXTS naming a licence its expression offers.
 */
export function licenceTextProblems(
  packages: Iterable<BundledPackage>,
  reviewed: Readonly<Record<string, LicenceTextReview>> = REVIEWED_LICENCE_TEXTS,
): string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    if (packageNotices(pkg.dir, []).licenceFiles.length > 0) continue
    const label = `${pkg.name}@${pkg.version} (in ${[...pkg.usedIn].sort().join(', ')})`
    const review = reviewed[`${pkg.name}@${pkg.version}`]
    if (review === undefined) {
      problems.push(
        `${label} ships no licence text: check what covers it (its licence is ${pkg.license ?? 'unknown'}) and record that in REVIEWED_LICENCE_TEXTS in src/licenses.ts`,
      )
    } else if (
      !licenceIds(pkg.license).some((id) => id.toLowerCase() === review.license.toLowerCase())
    ) {
      problems.push(
        `${label}: REVIEWED_LICENCE_TEXTS names ${review.license}, which its licence (${pkg.license ?? 'unknown'}) doesn't offer`,
      )
    }
  }
  return problems
}

/** LGPL in any version or spelling: `LGPL-2.1-only`, `LGPL-3.0+`, `LGPLv3`. */
export function isLgplFamily(id: string): boolean {
  return /LGPL/i.test(id)
}

/**
 * Whether FXM may ship a package under this licence only by following the LGPL: the expression
 * is acceptable with the LGPL, and not without it (`MIT OR LGPL-3.0` is MIT's to take).
 */
export function needsLgpl(expression: string | undefined, { reviewed = false } = {}): boolean {
  if (!expression || !/LGPL/i.test(expression)) return false
  let tree: LicenseNode
  try {
    tree = parseLicenseExpression(expression)
  } catch {
    return false
  }
  const allowed = (node: LicenseNode, lgpl: boolean): boolean => {
    if (node.type === 'license') {
      if (isLgplFamily(node.id)) return lgpl
      if (isGplFamily(node.id)) return false
      return reviewed || ACCEPTED_LICENCES.has(node.id.toLowerCase())
    }
    const sides = [allowed(node.left, lgpl), allowed(node.right, lgpl)]
    return node.type === 'or' ? sides.includes(true) : sides.every(Boolean)
  }
  return allowed(tree, true) && !allowed(tree, false)
}

/** A module's file, from its id in the bundler's module list. */
const moduleFile = (id: string) => id.replace(/^\0/, '').split('?')[0] ?? ''

/**
 * Why code under the LGPL can't ship the way it is bundled (an empty list when it can). The LGPL
 * lets FXM ship a library only where people can replace it, so a package that FXM may ship only
 * under the LGPL (needsLgpl) must sit in chunks of its own, which the bundler's module list
 * shows: chunks holding nothing but its modules and the bundler's runtime. A Vite `manualChunks`
 * entry puts it there. `chunksOf` gives a part's chunks, or nothing for a part without that list
 * (the sandbox documents inline their code, so LGPL code can't ship there at all).
 */
export function lgplProblems(
  packages: Iterable<BundledPackage>,
  chunksOf: (
    part: string,
  ) => readonly { fileName: string; modules: readonly string[] }[] | undefined,
): string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    if (!needsLgpl(pkg.license, { reviewed: pkg.reviewed })) continue
    for (const part of [...pkg.usedIn].sort()) {
      const label = `${pkg.name}@${pkg.version} (in ${part}) is under the LGPL, so it must sit in chunks of its own`
      const ownsModule = (id: string) => packageDirOf(moduleFile(id)) === pkg.dir
      const chunks = (chunksOf(part) ?? []).filter((chunk) => chunk.modules.some(ownsModule))
      if (chunks.length === 0) {
        problems.push(`${label}, but no chunk of the ${part} build shows where it is`)
        continue
      }
      for (const chunk of chunks) {
        const others = chunk.modules.filter(
          (id) => !ownsModule(id) && !BUNDLER_RUNTIME_MODULES.has(id),
        )
        if (others.length > 0) {
          problems.push(
            `${label}, but ${chunk.fileName} also holds ${others.length} other module(s), such as ${moduleFile(others[0] ?? '')}: give it a chunk of its own (manualChunks)`,
          )
        }
      }
    }
  }
  return problems
}

const RULE = '='.repeat(78)

/** How the notices name the parts of the deployment, in this order. */
export const PART_NAMES: Readonly<Record<string, string>> = {
  site: 'website',
  app: 'web app',
  embed: 'embeddable player',
  sandbox: 'sandbox documents',
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** What the notices file is written from, besides the packages. */
export interface NoticesOptions {
  /** FXM's repository, named at the top. */
  readonly repositoryUrl: string
  /**
   * Reads the text of the Apache License 2.0, FXM's own (the repository's LICENSE): the notices
   * end with it when REVIEWED_LICENCE_TEXTS covers a package with it.
   */
  readonly apacheLicense: () => string
  /** The reviews of packages without a licence text. Default: REVIEWED_LICENCE_TEXTS. */
  readonly reviewed?: Readonly<Record<string, LicenceTextReview>>
}

/**
 * The third-party notices file for everything FXM deploys: each bundled package with its
 * licence, the parts that contain it, its licence files and the notices of its bundled files
 * that add to them (`notices.ts`).
 */
export function renderNotices(packages: Iterable<BundledPackage>, options: NoticesOptions): string {
  const reviewed = options.reviewed ?? REVIEWED_LICENCE_TEXTS
  const sorted = [...packages].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
  const parts = new Set(sorted.flatMap((pkg) => [...pkg.usedIn]))
  const names = [
    ...Object.keys(PART_NAMES).filter((part) => parts.has(part)),
    ...[...parts].filter((part) => !Object.hasOwn(PART_NAMES, part)).sort(),
  ].map((part) => PART_NAMES[part] ?? part)
  const lines = [
    'FXM third-party notices',
    '',
    `FXM is open source under the Apache License 2.0: ${options.repositoryUrl}`,
  ]
  if (sorted.length === 0) lines.push('', 'This build includes no third-party packages.')
  else {
    lines.push(
      `Its ${listOf(names)} include code from the open-source packages below, each under its own licence.`,
      '',
      'make dist writes this file from what the build it deploys contains.',
    )
  }
  let apache = false
  for (const pkg of sorted) {
    lines.push('', RULE, `${pkg.name} ${pkg.version}`, `Licence: ${pkg.license ?? 'unknown'}`)
    lines.push(`Used in: ${[...pkg.usedIn].sort().join(', ')}`)
    if (pkg.homepage) lines.push(pkg.homepage)
    const { licenceFiles, fileNotices } = packageNotices(pkg.dir, pkg.files)
    const review = reviewed[`${pkg.name}@${pkg.version}`]
    if (licenceFiles.length === 0) {
      if (review?.license === 'Apache-2.0') {
        apache = true
        lines.push(
          '',
          'The package ships no licence text. FXM uses it under the Apache License 2.0, whose text ends this file, with the notices of its files below.',
        )
      } else
        lines.push('', `The package ships no licence text; its package.json says ${pkg.license}.`)
    }
    for (const file of licenceFiles) {
      if (licenceFiles.length > 1) lines.push('', `--- ${file.name}`)
      lines.push('', file.text)
    }
    if (fileNotices.length > 0) {
      lines.push('', '--- Notices in its files')
      for (const notice of fileNotices) lines.push('', notice)
    }
  }
  if (apache) lines.push('', RULE, 'The Apache License 2.0', '', options.apacheLicense().trim())
  return `${lines.join('\n')}\n`
}
