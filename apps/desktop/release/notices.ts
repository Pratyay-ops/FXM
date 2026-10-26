/**
 * The desktop app's third-party notices: one text file with the licences of the Rust crates that
 * the app's executable includes, then make dist's notices for the web app it shows. Every release
 * bundles it (`bundle > resources` in `src-tauri/tauri.release.conf.json`), and Settings → About
 * shows it (`src-tauri/src/notices.rs`). The release workflow's notices job writes it once for all
 * five targets (`release.ts notices`).
 *
 * **Which crates.** `cargo metadata --filter-platform <triple>` for each release target, followed
 * from the app's crate along normal dependencies only: build and dev dependencies, and proc-macro
 * crates with everything only they use, run while the app compiles, and none of their code ends up
 * in it. Every crate must come from crates.io, whose copy of its source code the notices point to.
 *
 * **Licences.** The same policy as make dist's (`scripts/build-dist/src/licenses.ts`): GPL and
 * AGPL never, and a licence outside its ACCEPTED_LICENCES only after a review recorded in
 * CRATE_LICENCE_OVERRIDES. The crates that FXM may ship only under the MPL-2.0 are listed with
 * where crates.io serves their source code, as the MPL asks of executables (section 3.2).
 *
 * **Licence texts.** Each crate's licence, copying, copyright and notice files from its source
 * code as crates.io publishes it: those at its root (`LICENSE-MIT`, `COPYING`, `UNLICENSE`…), its
 * `license-file`, and those deeper in it, which cover code it took from elsewhere (ring's
 * once_cell polyfill, regex-syntax's Unicode tables), unless NESTED_EXCLUSIONS says why one doesn't
 * apply to the app. A crate that ships no licence text needs a review in REVIEWED_CRATE_TEXTS,
 * which says which licence its expression offers FXM and where that licence's text comes from;
 * the review holds as long as the crate's licence expression stays the same. Every text appears
 * once, with the crates it covers.
 *
 * Node runs this file directly (type stripping), which is why the imports spell out `.ts`.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import {
  ACCEPTED_LICENCES,
  evaluateLicense,
  isGplFamily,
  parseLicenseExpression,
} from '../../../scripts/build-dist/src/licenses.ts'
import { isRecord } from './actions.ts'
import { TARGETS, type TargetId } from './targets.ts'

/** The licence files that crates.io's copies of crates name the way npm packages do, and more. */
const LICENCE_FILE = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[-_.][\w.-]*)?$/i

/** Names that look like licence files but hold metadata or code: `LICENSE.spdx`, `license.rs`. */
const NOT_LICENCE_TEXT = /\.(?:spdx|json|toml|rs|[ch]|[ch]pp|py|sh|[cm]?[jt]sx?)$/i

/** A folder in REUSE's layout, whose every file is a licence text (`LICENSES/MIT.txt`). */
const LICENCES_FOLDER = /^licen[cs]es$/i

/** Folders of a crate whose code never goes into a library that depends on it. */
const UNSHIPPED_FOLDERS = new Set(['tests', 'benches', 'examples', 'fuzz', 'target', '.git'])

/** crates.io's index, as Cargo names a crate's source in `cargo metadata`. */
const CRATES_IO =
  /^(?:registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index|sparse\+https:\/\/index\.crates\.io\/)$/

/** A crate as `cargo metadata` describes it: the fields the notices read. */
export interface MetadataPackage {
  readonly id: string
  readonly name: string
  readonly version: string
  /** Its SPDX licence expression, or `null`. */
  readonly license: string | null
  /** Its `license-file`, relative to its folder, or `null`. */
  readonly license_file: string | null
  readonly repository: string | null
  /** Where Cargo got it (`registry+…`, `git+…`), or `null` for a path dependency. */
  readonly source: string | null
  /** Its Cargo.toml, whose folder holds its source code. */
  readonly manifest_path: string
  /** Its targets' kinds: `lib`, `proc-macro`, `bin`… */
  readonly targets: readonly { readonly kind: readonly string[] }[]
}

/** A node of the resolved dependency graph. */
export interface MetadataNode {
  readonly id: string
  readonly deps: readonly {
    readonly pkg: string
    /** `kind` is `null` for a normal dependency, `"build"` or `"dev"` otherwise. */
    readonly dep_kinds: readonly { readonly kind: string | null }[]
  }[]
  /** The features the build turns on. */
  readonly features: readonly string[]
}

/** `cargo metadata --format-version 1`, as far as the notices read it. */
export interface Metadata {
  readonly packages: readonly MetadataPackage[]
  readonly resolve: { readonly root: string | null; readonly nodes: readonly MetadataNode[] }
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Checks the parts of `cargo metadata`'s output that the notices read. */
export function parseMetadata(text: string): Metadata {
  const data: unknown = JSON.parse(text)
  const resolve = isRecord(data) ? data.resolve : undefined
  if (!isRecord(data) || !Array.isArray(data.packages) || !isRecord(resolve)) {
    throw new Error('cargo metadata printed no packages and resolved graph')
  }
  if (!Array.isArray(resolve.nodes)) throw new Error('cargo metadata printed no resolved graph')
  const packages = data.packages.map((value: unknown): MetadataPackage => {
    if (!isRecord(value)) throw new Error('cargo metadata printed a package that is no object')
    const { id, name, version, manifest_path: manifest, targets } = value
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof version !== 'string' ||
      typeof manifest !== 'string' ||
      !Array.isArray(targets)
    ) {
      throw new Error('cargo metadata printed a package without its id, name, version or targets')
    }
    return {
      id,
      name,
      version,
      license: stringOrNull(value.license),
      license_file: stringOrNull(value.license_file),
      repository: stringOrNull(value.repository),
      source: stringOrNull(value.source),
      manifest_path: manifest,
      targets: targets.map((target: unknown) => ({
        kind:
          isRecord(target) && Array.isArray(target.kind)
            ? target.kind.filter((kind): kind is string => typeof kind === 'string')
            : [],
      })),
    }
  })
  const nodes = resolve.nodes.map((value: unknown): MetadataNode => {
    if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.deps)) {
      throw new Error('cargo metadata printed a graph node without its id and dependencies')
    }
    return {
      id: value.id,
      deps: value.deps.map((dep: unknown) => {
        if (!isRecord(dep) || typeof dep.pkg !== 'string' || !Array.isArray(dep.dep_kinds)) {
          throw new Error(`cargo metadata printed a dependency of ${value.id} without its kinds`)
        }
        return {
          pkg: dep.pkg,
          dep_kinds: dep.dep_kinds.map((kind: unknown) => ({
            kind: isRecord(kind) ? stringOrNull(kind.kind) : null,
          })),
        }
      }),
      features: Array.isArray(value.features)
        ? value.features.filter((feature): feature is string => typeof feature === 'string')
        : [],
    }
  })
  return { packages, resolve: { root: stringOrNull(resolve.root), nodes } }
}

/** The kinds of a crate's library target, of which it has one at most. */
const LIBRARY_KINDS = new Set(['lib', 'rlib', 'dylib', 'cdylib', 'staticlib', 'proc-macro'])

/**
 * Whether a crate's library is a proc macro: its code runs in the compiler, never in the app. (Its
 * build script, a `custom-build` target, doesn't change that.)
 */
const isProcMacro = (pkg: MetadataPackage) =>
  pkg.targets
    .find((target) => target.kind.some((kind) => LIBRARY_KINDS.has(kind)))
    ?.kind.includes('proc-macro') ?? false

/** A crate the app's executable includes, with the features it is built with. */
export interface LinkedCrate {
  readonly pkg: MetadataPackage
  readonly features: readonly string[]
}

/**
 * The crates that the app's executable includes for one target: everything its crate reaches
 * along normal dependencies, without proc-macro crates and what only they use.
 */
export function linkedCrates(metadata: Metadata): LinkedCrate[] {
  const root = metadata.resolve.root
  if (root === null) throw new Error("cargo metadata has no root crate: run it on the app's crate")
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
  const seen = new Set([root])
  const queue = [root]
  const linked: LinkedCrate[] = []
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const node = nodes.get(id)
    if (node === undefined) throw new Error(`cargo metadata has no graph node for ${id}`)
    for (const dep of node.deps) {
      if (seen.has(dep.pkg) || !dep.dep_kinds.some((kind) => kind.kind === null)) continue
      const pkg = packages.get(dep.pkg)
      if (pkg === undefined) throw new Error(`cargo metadata has no package ${dep.pkg}`)
      if (isProcMacro(pkg)) continue
      seen.add(dep.pkg)
      queue.push(dep.pkg)
      linked.push({ pkg, features: nodes.get(dep.pkg)?.features ?? [] })
    }
  }
  return linked
}

/** A crate of the notices: what the app's executable includes on one or more targets. */
export interface ShippedCrate {
  readonly name: string
  readonly version: string
  /** Its licence expression as SPDX writes it (`MIT/Apache-2.0` becomes `MIT OR Apache-2.0`). */
  readonly license: string | undefined
  readonly repository: string | undefined
  /** The folder of its source code, as crates.io publishes it. */
  readonly dir: string
  /** Its `license-file`, relative to `dir`. */
  readonly licenseFile: string | undefined
  /** The features it is built with, on any target. */
  readonly features: ReadonlySet<string>
  /** The targets whose executables include it, in the order of TARGETS. */
  readonly targets: readonly TargetId[]
}

/** Cargo's old `A/B` licence syntax, which means `A OR B`, as SPDX writes it. */
export function spdxExpression(license: string | null): string | undefined {
  const trimmed = license?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\s*\/\s*/g, ' OR ')
}

/** Whether `a` sorts before `b`, by code unit, so the file is the same on every machine. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The crates of every target, each once, with the targets that include it. Throws on a crate that
 * doesn't come from crates.io: the notices point to crates.io's copy of each crate's source code.
 */
export function shippedCrates(perTarget: ReadonlyMap<TargetId, Metadata>): ShippedCrate[] {
  const crates = new Map<
    string,
    { pkg: MetadataPackage; features: Set<string>; targets: Set<TargetId> }
  >()
  for (const [target, metadata] of perTarget) {
    for (const { pkg, features } of linkedCrates(metadata)) {
      if (pkg.source === null || !CRATES_IO.test(pkg.source)) {
        throw new Error(
          `${pkg.name} ${pkg.version} comes from ${pkg.source ?? 'a folder'}, not crates.io: ` +
            "the notices point to crates.io for every crate's source code, so say in " +
            "apps/desktop/release/notices.ts where this one's is",
        )
      }
      const key = `${pkg.name}@${pkg.version}`
      const entry = crates.get(key) ?? { pkg, features: new Set(), targets: new Set() }
      for (const feature of features) entry.features.add(feature)
      entry.targets.add(target)
      crates.set(key, entry)
    }
  }
  return [...crates.values()]
    .map(({ pkg, features, targets }) => ({
      name: pkg.name,
      version: pkg.version,
      license: spdxExpression(pkg.license),
      repository: pkg.repository?.trim() || undefined,
      dir: dirname(pkg.manifest_path),
      licenseFile: pkg.license_file ?? undefined,
      features,
      targets: TARGETS.map((known) => known.id).filter((id) => targets.has(id)),
    }))
    .sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version))
}

/** A licence a human reviewed for a crate whose expression is outside ACCEPTED_LICENCES. */
export interface CrateLicenceOverride {
  /** The licence expression reviewed, as the crate gives it. */
  readonly expression: string
  readonly reason: string
}

/**
 * Crates whose licence is outside ACCEPTED_LICENCES and turned out fine to ship, keyed by crate
 * name. The review holds while the crate's licence expression stays the same.
 */
export const CRATE_LICENCE_OVERRIDES: Readonly<Record<string, CrateLicenceOverride>> = {
  'webpki-roots': {
    expression: 'CDLA-Permissive-2.0',
    reason:
      'Mozilla’s list of trusted root certificates, as data. The Community Data License Agreement – Permissive 2.0 lets anyone use and share the data, and asks only that its text go with it, which its LICENSE file brings into the notices. Reviewed 2026-10-26 (version 1.0.9).',
  },
}

/** Where the licence text of a crate that ships none comes from (REVIEWED_CRATE_TEXTS). */
export type ReviewedText =
  /** FXM's own licence, the Apache License 2.0: the repository's LICENSE. */
  | { readonly apache: true }
  /** The licence files of another crate the app includes, from the same project. */
  | { readonly crate: string }
  /** A file in `release/licences/`, copied from the crate's repository at `source`. */
  | { readonly file: string; readonly source: string; readonly sha256: string }

/** What covers a crate that ships no licence text of its own. */
export interface CrateTextReview {
  /** The version a human reviewed. */
  readonly version: string
  /** Its licence expression in that version. */
  readonly expression: string
  /** The licence FXM uses it under, which the expression must offer. */
  readonly license: string
  readonly text: ReviewedText
  readonly reason: string
}

/** Trio-licensed crates of the objc2 project, which ship no licence file of their own. */
function objc2Trio(version: string): CrateTextReview {
  return {
    version,
    expression: 'Zlib OR Apache-2.0 OR MIT',
    license: 'Apache-2.0',
    text: { apache: true },
    reason:
      'Licensed Zlib OR Apache-2.0 OR MIT, as its repository’s LICENSE.md says (https://github.com/madsmtm/objc2/blob/ee9a7ada2131f5944b8750428e265c15632f2a19/LICENSE.md), with no licence file in the crate, so FXM uses it under the Apache License 2.0, FXM’s own. Reviewed 2026-10-26.',
  }
}

/** The MIT-licensed crates of the objc2 project, whose licence text is the repository's. */
function objc2Mit(version: string): CrateTextReview {
  return {
    version,
    expression: 'MIT',
    license: 'MIT',
    text: {
      file: 'objc2-LICENSE-MIT.txt',
      source:
        'https://github.com/madsmtm/objc2/blob/ee9a7ada2131f5944b8750428e265c15632f2a19/LICENSE-MIT.txt',
      sha256: 'f6a2e783669a0dd7a2c3b8a4f76db40ae49033e66e1bdc30f3aa25fe5577b070',
    },
    reason:
      'Licensed MIT, with no licence file in the crate. Its repository’s LICENSE.md puts it under the MIT license of LICENSE-MIT.txt, copied into release/licences/. Reviewed 2026-10-26.',
  }
}

/** Crates under MIT OR Apache-2.0 that ship no licence file: FXM uses them under Apache-2.0. */
function apacheOrMit(version: string, expression: string, project: string): CrateTextReview {
  return {
    version,
    expression,
    license: 'Apache-2.0',
    text: { apache: true },
    reason: `Licensed ${expression}, with no licence file in the crate (${project} keeps them at the root of its repository), so FXM uses it under the Apache License 2.0, FXM’s own. Reviewed 2026-10-26.`,
  }
}

/**
 * Crates that ship no licence text of their own, keyed by crate name, after a human checked what
 * covers them. A later version passes while its licence expression stays the same; when it
 * changes, the release stops until a human reviews the crate again.
 */
export const REVIEWED_CRATE_TEXTS: Readonly<Record<string, CrateTextReview>> = {
  'alloc-stdlib': {
    version: '0.3.0',
    expression: 'BSD-3-Clause',
    license: 'BSD-3-Clause',
    text: { crate: 'alloc-no-stdlib' },
    reason:
      'Licensed BSD-3-Clause, with no licence file in the crate. It comes from the same repository as alloc-no-stdlib (https://github.com/dropbox/rust-alloc-no-stdlib), whose LICENSE is that repository’s BSD-3-Clause licence, with Dropbox’s copyright. Reviewed 2026-10-26.',
  },
  block2: objc2Mit('0.6.2'),
  'defmt-parser': apacheOrMit('1.0.0', 'MIT OR Apache-2.0', 'The defmt project'),
  dispatch2: objc2Trio('0.3.1'),
  dlopen2: {
    version: '0.8.2',
    expression: 'MIT',
    license: 'MIT',
    text: {
      file: 'dlopen2-LICENSE.txt',
      source:
        'https://github.com/OpenByteDev/dlopen2/blob/d0304f3bcd2ceae6688277091ee7473aa7480e51/LICENSE',
      sha256: '39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2',
    },
    reason:
      'Licensed MIT, with no licence file in the crate. Its repository’s LICENSE, copied into release/licences/, is the MIT license with its three copyright holders. Reviewed 2026-10-26.',
  },
  'libappindicator-sys': apacheOrMit(
    '0.9.0',
    'Apache-2.0 OR MIT',
    'The libappindicator-rs project',
  ),
  objc2: objc2Mit('0.6.5'),
  'objc2-app-kit': objc2Trio('0.3.2'),
  'objc2-core-foundation': objc2Trio('0.3.2'),
  'objc2-core-graphics': objc2Trio('0.3.2'),
  'objc2-encode': objc2Mit('4.1.0'),
  'objc2-exception-helper': objc2Trio('0.1.1'),
  'objc2-foundation': objc2Mit('0.3.2'),
  'objc2-io-surface': objc2Trio('0.3.2'),
  'objc2-osa-kit': objc2Trio('0.3.2'),
  'objc2-quartz-core': objc2Trio('0.3.2'),
  'objc2-web-kit': objc2Trio('0.3.2'),
  selectors: {
    version: '0.38.0',
    expression: 'MPL-2.0',
    license: 'MPL-2.0',
    text: { crate: 'cssparser' },
    reason:
      'Licensed MPL-2.0, with no licence file in the crate; every source file carries the MPL-2.0 header that points to https://mozilla.org/MPL/2.0/. The licence text is the MPL-2.0’s, which cssparser, from the same Servo project, ships as its LICENSE. Reviewed 2026-10-26.',
  },
  'webview2-com': webview2('0.39.1'),
  'webview2-com-sys': webview2('0.39.1'),
}

/** The crates of the webview2-rs project, whose licence text is the repository's. */
function webview2(version: string): CrateTextReview {
  return {
    version,
    expression: 'MIT',
    license: 'MIT',
    text: {
      file: 'webview2-rs-LICENSE.txt',
      source:
        'https://github.com/wravery/webview2-rs/blob/f55627c8759254dd50c0c02663544f95e94f59ae/LICENSE',
      sha256: '0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73',
    },
    reason:
      'Licensed MIT, with no licence file in the crate. Its repository’s LICENSE, copied into release/licences/, is the MIT license with Bill Avery’s copyright. Reviewed 2026-10-26.',
  }
}

/** Licence files deeper in a crate that don't apply to the app, and why. */
export interface NestedExclusion {
  /** The folder they are in, relative to the crate's folder, with a trailing `/`. */
  readonly folder: string
  /** They apply after all when the build turns this feature of the crate on. */
  readonly unlessFeature: string
  readonly reason: string
}

/** Licence files deeper in crates that don't cover code the app includes, keyed by crate name. */
export const NESTED_EXCLUSIONS: Readonly<Record<string, readonly NestedExclusion[]>> = {
  'libdbus-sys': [
    {
      folder: 'vendor/',
      unlessFeature: 'vendored',
      reason:
        'The source code of the D-Bus library, which libdbus-sys compiles only with its `vendored` feature. Without it, the app uses the system’s libdbus. Reviewed 2026-10-26.',
    },
  ],
}

/** A licence text of a crate, and where it comes from. */
export interface CrateText {
  /** Where the text comes from, for the notices: `LICENSE-MIT`, `src/spin/LICENSE`. */
  readonly label: string
  /** The text, trimmed, with Unix line endings. */
  readonly text: string
}

/**
 * Text with Unix line endings, without a byte order mark, blank lines around it or spaces at its
 * end. The first line keeps its indentation: the Apache License centres its title with spaces.
 */
const unixText = (text: string) =>
  text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()

/** Whether a file in a crate holds a licence text, by its name (or its folder's, for REUSE). */
export function isCrateLicenceFile(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  if (NOT_LICENCE_TEXT.test(name) && !parts.slice(0, -1).some((part) => LICENCES_FOLDER.test(part)))
    return false
  return LICENCE_FILE.test(name) || parts.slice(0, -1).some((part) => LICENCES_FOLDER.test(part))
}

/** The files under `dir` whose names say they hold a licence text, relative to `dir`, sorted. */
function licenceFilePaths(dir: string): string[] {
  const found: string[] = []
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      const rel = relative(dir, path).split(sep).join('/')
      if (entry.isDirectory()) {
        if (folder === dir && UNSHIPPED_FOLDERS.has(entry.name)) continue
        walk(path)
      } else if (entry.isFile() && isCrateLicenceFile(rel)) found.push(rel)
    }
  }
  walk(dir)
  // The crate's own files first, then those deeper in it.
  const deeper = (path: string) => (path.includes('/') ? 1 : 0)
  return found.sort((a, b) => deeper(a) - deeper(b) || compare(a, b))
}

/**
 * A crate's own licence texts: its licence files, root first, then its `license-file`, without
 * the nested ones that NESTED_EXCLUSIONS leaves out.
 */
export function crateTexts(
  crate: ShippedCrate,
  exclusions: Readonly<Record<string, readonly NestedExclusion[]>> = NESTED_EXCLUSIONS,
): CrateText[] {
  const excluded = (Object.hasOwn(exclusions, crate.name) ? exclusions[crate.name] : []) ?? []
  const paths = licenceFilePaths(crate.dir).filter(
    (path) =>
      !excluded.some(
        (exclusion) =>
          path.startsWith(exclusion.folder) && !crate.features.has(exclusion.unlessFeature),
      ),
  )
  const licenseFile = crate.licenseFile?.split(sep).join('/')
  if (
    licenseFile !== undefined &&
    !paths.includes(licenseFile) &&
    existsSync(join(crate.dir, licenseFile)) &&
    lstatSync(join(crate.dir, licenseFile)).isFile()
  ) {
    paths.push(licenseFile)
  }
  return paths
    .map((path) => ({ label: path, text: unixText(readFileSync(join(crate.dir, path), 'utf8')) }))
    .filter((text) => text.text !== '')
}

/** The licence ids an SPDX expression offers, in any combination, or none when it isn't one. */
function offeredIds(expression: string | undefined): string[] {
  if (expression === undefined) return []
  try {
    const ids = (node: ReturnType<typeof parseLicenseExpression>): string[] =>
      node.type === 'license' ? [node.id] : [...ids(node.left), ...ids(node.right)]
    return ids(parseLicenseExpression(expression))
  } catch {
    return []
  }
}

/** An SPDX expression in one spelling, so that `(A OR B)` and `A or B` compare equal. */
function canonical(expression: string | undefined): string | undefined {
  if (expression === undefined) return undefined
  try {
    const spell = (node: ReturnType<typeof parseLicenseExpression>): string =>
      node.type === 'license'
        ? `${node.id}${node.exception === undefined ? '' : ` WITH ${node.exception}`}`.toLowerCase()
        : `(${spell(node.left)} ${node.type.toUpperCase()} ${spell(node.right)})`
    return spell(parseLicenseExpression(expression))
  } catch {
    return expression.trim()
  }
}

/**
 * Whether FXM may ship a crate only by following a licence of `family`: the expression is
 * acceptable with it and not without it (`MPL-2.0` is, `MIT OR MPL-2.0` is MIT's to take).
 */
export function onlyUnder(expression: string | undefined, family: RegExp): boolean {
  if (expression === undefined) return false
  let tree: ReturnType<typeof parseLicenseExpression>
  try {
    tree = parseLicenseExpression(expression)
  } catch {
    return false
  }
  const allowed = (node: typeof tree, withFamily: boolean): boolean => {
    if (node.type === 'license') {
      if (family.test(node.id)) return withFamily
      return !isGplFamily(node.id) && ACCEPTED_LICENCES.has(node.id.toLowerCase())
    }
    const sides = [allowed(node.left, withFamily), allowed(node.right, withFamily)]
    return node.type === 'or' ? sides.includes(true) : sides.every(Boolean)
  }
  return allowed(tree, true) && !allowed(tree, false)
}

/** The licences that ask for the source code of what FXM ships in executable form. */
const SOURCE_LICENCES = /^MPL-/i

/** What the notices are written from, besides the crates. */
export interface CrateNoticeOptions {
  /** Reads the text of the Apache License 2.0, FXM's own (the repository's LICENSE). */
  readonly apacheLicense: () => string
  /** Reads a file of `release/licences/`. */
  readonly reviewedFile: (name: string) => string
  /** Default: CRATE_LICENCE_OVERRIDES. */
  readonly overrides?: Readonly<Record<string, CrateLicenceOverride>>
  /** Default: REVIEWED_CRATE_TEXTS. */
  readonly reviews?: Readonly<Record<string, CrateTextReview>>
  /** Default: NESTED_EXCLUSIONS. */
  readonly exclusions?: Readonly<Record<string, readonly NestedExclusion[]>>
}

/** A licence text and the crates it covers, each with where its copy comes from. */
export interface TextGroup {
  readonly text: string
  readonly covers: { readonly crate: ShippedCrate; readonly label: string }[]
}

/** What the notices say about the crates: their licence texts, once each, or why they can't. */
export interface CrateNotices {
  readonly crates: readonly ShippedCrate[]
  /** The licence texts, each once, in the order the crates first use them. */
  readonly groups: readonly TextGroup[]
  /** The crates FXM may ship only under a licence that asks for their source code. */
  readonly sourceCrates: readonly ShippedCrate[]
  /** Why the notices can't be written, one line each: empty when they can. */
  readonly problems: readonly string[]
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A crate as the notices name it. */
const crateName = (crate: ShippedCrate) => `${crate.name} ${crate.version}`

/** A crate's key: its name and version. */
const keyOf = (crate: Pick<ShippedCrate, 'name' | 'version'>) => `${crate.name}@${crate.version}`

/** Why FXM can't ship a crate under its licence, or `undefined` when it can. */
function licenceProblem(
  crate: ShippedCrate,
  overrides: Readonly<Record<string, CrateLicenceOverride>>,
): string | undefined {
  const name = crateName(crate)
  const review = 'record the review in CRATE_LICENCE_OVERRIDES in apps/desktop/release/notices.ts'
  if (crate.license === undefined) {
    const file = crate.licenseFile === undefined ? '' : `, only the file ${crate.licenseFile}`
    return `${name} declares no licence in its Cargo.toml${file}: check what covers it and ${review}`
  }
  const override = Object.hasOwn(overrides, crate.name) ? overrides[crate.name] : undefined
  const reviewed =
    override !== undefined && canonical(override.expression) === canonical(crate.license)
  const verdict = evaluateLicense(crate.license, { reviewed })
  if (verdict.ok) return undefined
  if (/\bGPL or AGPL\b/.test(verdict.reason)) return `${name}: ${verdict.reason}`
  if (override !== undefined) {
    return `${name}: its licence is ${crate.license}, but CRATE_LICENCE_OVERRIDES reviewed ${override.expression}: check it again and update the review`
  }
  return `${name}: ${crate.license} is not a licence FXM accepts (ACCEPTED_LICENCES in scripts/build-dist/src/licenses.ts): check it and ${review}`
}

/**
 * The crates' licence texts, each once, and the problems that stop the release: a licence FXM
 * doesn't accept, a crate without licence text and without a review that still holds.
 */
export function crateNotices(
  crates: readonly ShippedCrate[],
  options: CrateNoticeOptions,
): CrateNotices {
  const overrides = options.overrides ?? CRATE_LICENCE_OVERRIDES
  const reviews = options.reviews ?? REVIEWED_CRATE_TEXTS
  const problems: string[] = []
  const own = new Map(crates.map((crate) => [keyOf(crate), crateTexts(crate, options.exclusions)]))
  /** The licence texts of the crate named `name` that the app includes, in any version. */
  const textsOfCrate = (name: string) =>
    crates
      .filter((crate) => crate.name === name)
      .map((crate) => own.get(keyOf(crate)) ?? [])
      .find((texts) => texts.length > 0) ?? []
  const groups = new Map<string, TextGroup>()
  const add = (crate: ShippedCrate, label: string, text: string) => {
    const group = groups.get(text) ?? { text, covers: [] }
    group.covers.push({ crate, label })
    groups.set(text, group)
  }
  for (const crate of crates) {
    const problem = licenceProblem(crate, overrides)
    if (problem !== undefined) problems.push(problem)
    const texts = own.get(keyOf(crate)) ?? []
    if (texts.length > 0) {
      for (const text of texts) add(crate, text.label, text.text)
      continue
    }
    const name = crateName(crate)
    const again =
      'check what covers it and update REVIEWED_CRATE_TEXTS in apps/desktop/release/notices.ts'
    const review = Object.hasOwn(reviews, crate.name) ? reviews[crate.name] : undefined
    if (review === undefined) {
      problems.push(
        `${name} ships no licence text (its licence is ${crate.license ?? 'unknown'}): ${again}`,
      )
      continue
    }
    if (canonical(review.expression) !== canonical(crate.license)) {
      problems.push(
        `${name}: its licence is ${crate.license ?? 'unknown'}, but REVIEWED_CRATE_TEXTS reviewed ${review.expression} (version ${review.version}): ${again}`,
      )
      continue
    }
    if (
      !offeredIds(crate.license).some((id) => id.toLowerCase() === review.license.toLowerCase())
    ) {
      problems.push(
        `${name}: REVIEWED_CRATE_TEXTS names ${review.license}, which its licence (${crate.license}) doesn't offer: ${again}`,
      )
      continue
    }
    const source = review.text
    if ('apache' in source) {
      add(
        crate,
        'no licence file: the Apache License 2.0, FXM’s own',
        unixText(options.apacheLicense()),
      )
    } else if ('crate' in source) {
      const texts = textsOfCrate(source.crate)
      if (texts.length === 0) {
        problems.push(
          `${name}: REVIEWED_CRATE_TEXTS takes its licence text from ${source.crate}, which the app doesn't include, or which ships none: ${again}`,
        )
        continue
      }
      for (const text of texts) {
        add(crate, `no licence file: ${review.license}, as ${source.crate} ships it`, text.text)
      }
    } else {
      const text = options.reviewedFile(source.file)
      if (sha256(text) !== source.sha256) {
        problems.push(
          `${name}: release/licences/${source.file} isn't the file REVIEWED_CRATE_TEXTS reviewed (its SHA-256 changed): ${again}`,
        )
        continue
      }
      add(crate, `no licence file: its repository’s, ${source.source}`, unixText(text))
    }
  }
  const sourceCrates = crates.filter((crate) => onlyUnder(crate.license, SOURCE_LICENCES))
  return { crates, groups: [...groups.values()], sourceCrates, problems }
}

const RULE = '='.repeat(78)
const THIN_RULE = '-'.repeat(78)

/** `text` broken into lines of at most `width` characters, at spaces, each after `indent`. */
function wrap(text: string, width = 100, indent = ''): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && indent.length + line.length + 1 + word.length > width) {
      lines.push(`${indent}${line}`)
      line = word
    } else line = line === '' ? word : `${line} ${word}`
  }
  if (line !== '') lines.push(`${indent}${line}`)
  return lines
}

/** The targets of a crate, as the notices name them: `all`, or their ids. */
const targetsOf = (crate: ShippedCrate) =>
  crate.targets.length === TARGETS.length ? 'all' : crate.targets.join(', ')

/** Where crates.io serves a crate's source code, as published. */
export function crateDownload(crate: Pick<ShippedCrate, 'name' | 'version'>): string {
  return `https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate`
}

/** What the desktop notices are written from. */
export interface DesktopNoticesOptions {
  /** The version of the app they go with. */
  readonly version: string
  readonly repositoryUrl: string
  /** The Rust release the app is compiled with, whose standard library it includes. */
  readonly rustVersion: string
  readonly crates: CrateNotices
  /** make dist's third-party notices, for the web app. */
  readonly web: string
}

/**
 * The desktop app's third-party notices file: the crates (part 1), then make dist's notices for
 * the web app (part 2), as they are.
 */
export function renderDesktopNotices(options: DesktopNoticesOptions): string {
  const { crates, groups, sourceCrates } = options.crates
  const lines = [
    'FXM desktop app: third-party notices',
    `Version ${options.version}`,
    '',
    `FXM is open source under the Apache License 2.0: ${options.repositoryUrl}`,
    '',
    ...wrap(
      'The desktop app includes open-source code from others, each under its own licence, in two parts: the Rust crates compiled into its executable (part 1), and the web app it shows (part 2, the notices that make dist writes for FXM’s website, which hold the web app’s packages). The release workflow writes this file (apps/desktop/release/notices.ts) and puts it into every installer.',
    ),
    '',
    RULE,
    'Part 1: Rust crates',
    '',
    ...wrap(
      `The app’s executable includes the ${crates.length} crates below, from crates.io, unmodified, and the standard library of Rust ${options.rustVersion} (MIT OR Apache-2.0, https://github.com/rust-lang/rust). crates.io publishes the source code of each crate version at https://crates.io/crates/<name>/<version>. Each crate is in the installers of the targets listed with it: macos-arm64, macos-x64, windows-x64, linux-x64 and linux-arm64, or all of them.`,
    ),
  ]
  if (sourceCrates.length > 0) {
    lines.push(
      '',
      ...wrap(
        'These crates are under the Mozilla Public License 2.0, and the app includes them in executable form, unmodified. Their source code is available from crates.io (MPL-2.0, section 3.2):',
      ),
      '',
    )
    for (const crate of sourceCrates) {
      lines.push(`  ${crateName(crate)}: ${crateDownload(crate)}`)
      if (crate.repository) lines.push(`    (repository: ${crate.repository})`)
    }
  }
  lines.push('', 'The crates, each with its licence and the targets that include it:', '')
  for (const crate of crates) {
    lines.push(`  ${crateName(crate)}: ${crate.license ?? 'unknown'}, ${targetsOf(crate)}`)
    if (crate.repository) lines.push(`    ${crate.repository}`)
  }
  lines.push('', 'Their licence texts follow, each once, with the crates it comes with.')
  for (const group of groups) {
    // The crates whose copies of the text come from the same place, together: "a 1.0, b 2.0
    // (LICENSE-MIT), c 3.0 (COPYING)".
    const byLabel = new Map<string, string[]>()
    for (const { crate, label } of group.covers) {
      byLabel.set(label, [...(byLabel.get(label) ?? []), crateName(crate)])
    }
    const covers = [...byLabel].map(([label, names]) => `${names.join(', ')} (${label})`)
    lines.push('', THIN_RULE, ...wrap(`For ${covers.join(', ')}:`), '', group.text)
  }
  lines.push('', RULE, 'Part 2: The web app', '', unixText(options.web))
  return `${lines.join('\n')}\n`
}
