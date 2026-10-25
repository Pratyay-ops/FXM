/**
 * Which npm packages end up in the files FXM deploys, under which licences.
 *
 * The site and the web app are built with hidden source maps (`make dist` deletes them before
 * deploying), and every source a map names under `node_modules/` is a bundled package. Some
 * build tools also copy their own code into the output without a source map, such as
 * Tailwind's base styles; they mark it with a `/*! name vX.Y.Z | Licence` banner comment,
 * which the CSS scan picks up. From that list `make dist` writes the third-party notices file and fails
 * when a package is GPL or AGPL, or has no licence it can read (ARCHITECTURE.md §17 and §18).
 */
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
  readonly homepage: string | undefined
  /** The parts of the site that contain it: site, app, embed, sandbox. */
  readonly usedIn: Set<string>
}

/**
 * Licences confirmed by hand for packages whose package.json has none FXM can read, keyed by
 * `name@version`, with the reason. Empty today.
 */
export const LICENCE_OVERRIDES: Readonly<Record<string, { license: string; reason: string }>> = {}

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

interface PackageJson {
  name?: string
  version?: string
  license?: string | { type?: string }
  licenses?: { type?: string }[]
  homepage?: string
  repository?: string | { url?: string }
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
}

/** package.json's licence as one SPDX expression; legacy `licenses` arrays mean a choice. */
export function licenseOf(pkg: PackageJson): string | undefined {
  if (typeof pkg.license === 'string') return pkg.license.trim() || undefined
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type
  const types = (pkg.licenses ?? [])
    .map((entry) => entry.type)
    .filter((type): type is string => !!type)
  if (types.length === 1) return types[0]
  if (types.length > 1) return `(${types.join(' OR ')})`
  return undefined
}

function homepageOf(pkg: PackageJson): string | undefined {
  if (pkg.homepage) return pkg.homepage
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return url?.replace(/^git\+/, '').replace(/\.git$/, '')
}

function addPackage(into: Map<string, BundledPackage>, dir: string, part: string): void {
  const existing = into.get(dir)
  if (existing) {
    existing.usedIn.add(part)
    return
  }
  const pkg = readPackageJson(dir)
  if (!pkg.name || !pkg.version) throw new Error(`${dir}/package.json has no name or version`)
  const override = LICENCE_OVERRIDES[`${pkg.name}@${pkg.version}`]
  into.set(dir, {
    name: pkg.name,
    version: pkg.version,
    dir,
    license: override?.license ?? licenseOf(pkg),
    homepage: homepageOf(pkg),
    usedIn: new Set([part]),
  })
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
    const map = JSON.parse(readFileSync(mapFile, 'utf8')) as {
      sources?: string[]
      sourceRoot?: string
    }
    for (const source of map.sources ?? []) {
      // Vite plugins name sub-modules with a query, such as Astro's `Header.astro?astro&type=script`.
      const file = source.replace(/\?.*$/, '')
      const path = file.startsWith('file://')
        ? fileURLToPath(file)
        : resolve(dirname(mapFile), map.sourceRoot ?? '', file)
      const dir = packageDirOf(path)
      if (dir) {
        if (!existsSync(join(dir, 'package.json'))) {
          throw new Error(`${basename(mapFile)} names ${source}, but ${dir} has no package.json`)
        }
        addPackage(into, dir, part)
      } else if (!(path.startsWith(root + sep) && existsSync(path))) {
        unattributed.push(source)
      }
    }
  }
  return unattributed
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

type LicenseNode =
  | { type: 'license'; id: string }
  | { type: 'and' | 'or'; left: LicenseNode; right: LicenseNode }

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
    if (
      !/^[A-Za-z0-9.+:-]+$/.test(token) ||
      ['AND', 'OR', 'WITH', ')'].includes(token.toUpperCase())
    ) {
      throw new Error(`unexpected ${token}`)
    }
    let id = token
    if (peek() === 'WITH') {
      take()
      const exception = take()
      if (!exception || !/^[A-Za-z0-9.+:-]+$/.test(exception))
        throw new Error('missing exception after WITH')
      id = `${token} WITH ${exception}`
    }
    return { type: 'license', id }
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

/** GPL and AGPL in any version or variant, with or without exceptions; LGPL is fine. */
export function isGplFamily(id: string): boolean {
  return /^A?GPL(-|$)/i.test(id)
}

const NOT_A_LICENCE = new Set(['UNLICENSED', 'NONE', 'NOASSERTION'])

/** Whether FXM may ship a package under this licence expression, and why not. */
export function evaluateLicense(
  expression: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!expression) return { ok: false, reason: 'its package.json declares no licence' }
  if (/^SEE LICEN[CS]E IN /i.test(expression)) {
    return {
      ok: false,
      reason: `it has a custom licence (${expression}): review it and add an override`,
    }
  }
  let tree: LicenseNode
  try {
    tree = parseLicenseExpression(expression)
  } catch (error) {
    return {
      ok: false,
      reason: `"${expression}" is not an SPDX expression (${(error as Error).message})`,
    }
  }
  const custom = (id: string) => /^(LicenseRef|DocumentRef)-/i.test(id)
  const acceptable = (node: LicenseNode): boolean => {
    if (node.type === 'license') {
      const id = node.id.split(' WITH ')[0] as string
      return !isGplFamily(id) && !NOT_A_LICENCE.has(id.toUpperCase()) && !custom(id)
    }
    return node.type === 'and'
      ? acceptable(node.left) && acceptable(node.right)
      : acceptable(node.left) || acceptable(node.right)
  }
  if (acceptable(tree)) return { ok: true }
  if (/GPL/i.test(expression.replace(/LGPL/gi, ''))) {
    return {
      ok: false,
      reason: `${expression} is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)`,
    }
  }
  if (/(LicenseRef|DocumentRef)-/i.test(expression)) {
    return {
      ok: false,
      reason: `it has a custom licence (${expression}): review it and add an override`,
    }
  }
  return { ok: false, reason: `${expression} is not a licence FXM can ship under` }
}

/** Why the bundled packages can't ship, one line each (an empty list when they can). */
export function licenseProblems(packages: Iterable<BundledPackage>): string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    const verdict = evaluateLicense(pkg.license)
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

/** The third-party notices file for everything FXM deploys. */
export function renderNotices(packages: Iterable<BundledPackage>, repositoryUrl: string): string {
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
  return `${lines.join('\n')}\n`
}
