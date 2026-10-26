/**
 * `make dist`: builds every part, composes them into one folder for Cloudflare Pages, writes
 * the third-party notices and `_headers`, and refuses to finish when a check fails. Nothing
 * reaches the output folder until every check has passed.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { serializeHeaders } from './headers-file.ts'
import { scanPage } from './html.ts'
import {
  addPackagesFromBanners,
  addPackagesFromInventory,
  addPackagesFromRegions,
  addPackagesFromSourceMaps,
  type BundledPackage,
  binaryProblems,
  bundlerRuntimeChunks,
  type InventoryEntry,
  inlineCodeProblems,
  lgplProblems,
  licenceTextProblems,
  licenseProblems,
  readInventory,
  renderNotices,
} from './licenses.ts'
import type { BuildContext, Part } from './parts.ts'
import { privacyProblems } from './privacy.ts'
import { addDocumentPolicies, generateRules, listFiles } from './rules.ts'

/** Cloudflare Pages limits for a free project (ARCHITECTURE.md §3). */
export const MAX_FILES = 20_000
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** The notices file, at the root of the deployed folder. */
export const NOTICES_FILE = 'third-party-notices.txt'

/** Files that would turn the deployment into something other than static files. */
const FORBIDDEN = ['_worker.js', '_routes.json', '_redirects', 'functions']

export interface ComposeOptions {
  readonly root: string
  readonly parts: readonly Part[]
  /** Scratch space, emptied first and removed at the end. */
  readonly stagingDir: string
  /** The finished folder (dist/pages), replaced only when everything passed. */
  readonly outDir: string
  readonly run: BuildContext['run']
  readonly log: (message: string) => void
  readonly repositoryUrl: string
}

export interface ComposeResult {
  readonly built: readonly string[]
  readonly skipped: readonly string[]
  readonly files: number
  readonly bytes: number
  readonly rules: number
  readonly packages: readonly BundledPackage[]
}

/** Problems found while composing, reported together. */
export class DistError extends Error {
  readonly problems: readonly string[]
  constructor(title: string, problems: readonly string[]) {
    super(`${title}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'DistError'
    this.problems = problems
  }
}

export function compose(options: ComposeOptions): ComposeResult {
  const { root, parts, stagingDir, outDir, log } = options
  rmSync(stagingDir, { recursive: true, force: true })
  const pagesDir = join(stagingDir, 'pages')
  mkdirSync(pagesDir, { recursive: true })
  mkdirSync(join(stagingDir, 'inventory'), { recursive: true })
  const inventoryOf = (part: Part) => join(stagingDir, 'inventory', `${part.name}.jsonl`)

  const built: Part[] = []
  const skipped: string[] = []
  for (const part of parts) {
    const dir = join(stagingDir, 'parts', part.name)
    mkdirSync(dir, { recursive: true })
    log(`Building ${part.name}${part.mount ? ` for /${part.mount}/` : ' for /'}`)
    const context: BuildContext = { root, run: options.run, log, inventoryFile: inventoryOf(part) }
    if (!part.build(dir, context)) {
      if (part.required)
        throw new DistError(`Can't compose dist`, [`${part.name} is required but was not built`])
      log(`${part.name}: not built yet (a later stage adds it), skipped`)
      skipped.push(part.name)
      continue
    }
    if (listFiles(dir).length === 0)
      throw new DistError(`Can't compose dist`, [`${part.name} built no files`])
    built.push(part)
  }

  // Licences first: they need the source maps, which are not deployed.
  const packages = new Map<string, BundledPackage>()
  const inventories = new Map<string, InventoryEntry[]>()
  const problems: string[] = []
  for (const part of built) {
    const dir = join(stagingDir, 'parts', part.name)
    const files = listFiles(dir)
    const maps = files.filter((file) => file.endsWith('.map')).map((file) => join(dir, file))
    const inventory = readInventory(inventoryOf(part))
    inventories.set(part.name, inventory)
    const runtimeChunks = bundlerRuntimeChunks(inventory)
    for (const script of files.filter((file) => /\.m?js$/.test(file))) {
      if (!part.sourceMaps) {
        problems.push(
          `${part.name} ships ${script}, but builds no source maps to show which packages it contains`,
        )
        continue
      }
      if (files.includes(`${script}.map`)) continue
      // A chunk of the bundler's own runtime has no source map, and nothing from a package.
      const runtime = runtimeChunks.get(script)
      if (runtime) {
        const modules = runtime.map((id) => id.replace(/^\0/, '')).join(', ')
        log(`${part.name}: ${script} holds only the bundler's runtime (${modules})`)
      } else {
        problems.push(`${part.name}: ${script} has no source map, so its packages are unknown`)
      }
    }
    const scan = addPackagesFromSourceMaps(maps, part.name, root, packages)
    if (scan.generated.length > 0) {
      log(`${part.name}: generated modules accounted for: ${scan.generated.join(', ')}`)
    }
    for (const source of scan.unknown) {
      problems.push(
        `${part.name} ships code from ${source}, which is neither FXM's own file nor in node_modules: if a Vite plugin generates it, read the plugin's code and map the module to its package in VIRTUAL_MODULES (src/licenses.ts)`,
      )
    }
    // Stylesheets, fonts, images and WebAssembly the build took from packages.
    const origins = addPackagesFromInventory(inventory, part.name, packages)
    const stylesheets = files.filter((file) => file.endsWith('.css')).map((file) => join(dir, file))
    addPackagesFromBanners(stylesheets, part.name, root, packages)
    problems.push(...binaryProblems(part.name, dir, files, origins))
    if (!part.sourceMaps) {
      for (const document of files.filter((file) => file.endsWith('.html'))) {
        const page = scanPage(readFileSync(join(dir, document), 'utf8'))
        for (const code of [...page.inlineScripts, ...page.inlineStyles]) {
          problems.push(...inlineCodeProblems(part.name, document, code))
        }
        // Their bundles carry the bundler's module markers instead of a source map.
        problems.push(
          ...addPackagesFromRegions(page.inlineScripts, part.name, document, root, packages),
        )
      }
    }
  }
  problems.push(...licenseProblems(packages.values()))
  problems.push(...licenceTextProblems(packages.values()))
  problems.push(
    ...lgplProblems(packages.values(), (part) =>
      inventories.get(part)?.flatMap((entry) => entry.chunks ?? []),
    ),
  )
  if (problems.length > 0) throw new DistError('The build ships code FXM may not ship', problems)

  // Compose: each part's files under its mount, never two writers for one path.
  const owners = new Map<string, string>()
  for (const part of built) {
    const dir = join(stagingDir, 'parts', part.name)
    for (const file of listFiles(dir)) {
      if (file.endsWith('.map')) continue
      const target = part.mount ? `${part.mount}/${file}` : file
      const owner = owners.get(target)
      if (owner) problems.push(`${owner} and ${part.name} both write ${target}`)
      owners.set(target, part.name)
      mkdirSync(dirname(join(pagesDir, target)), { recursive: true })
      copyFileSync(join(dir, file), join(pagesDir, target))
    }
    if (part.spa) {
      const index = join(pagesDir, part.mount, 'index.html')
      const fallback = join(pagesDir, part.mount, '404.html')
      if (!existsSync(index)) problems.push(`${part.name} has no index.html`)
      else if (existsSync(fallback))
        problems.push(`${part.name} has its own 404.html; make dist writes it`)
      else copyFileSync(index, fallback)
    }
  }
  for (const generated of [NOTICES_FILE, '_headers']) {
    if (existsSync(join(pagesDir, generated))) {
      problems.push(`a part writes ${generated}; make dist writes it`)
    }
  }
  for (const name of FORBIDDEN) {
    if (existsSync(join(pagesDir, name)))
      problems.push(`the output has ${name}: FXM deploys static files only`)
  }
  if (problems.length > 0) throw new DistError(`Can't compose dist`, problems)
  writeFileSync(
    join(pagesDir, NOTICES_FILE),
    renderNotices(packages.values(), {
      repositoryUrl: options.repositoryUrl,
      // FXM's licence, the Apache License 2.0, which also covers some packages (licenses.ts).
      apacheLicense: () => readFileSync(join(root, 'LICENSE'), 'utf8'),
    }),
  )

  const files = listFiles(pagesDir)
  let bytes = 0
  for (const file of files) {
    const size = statSync(join(pagesDir, file)).size
    bytes += size
    if (size > MAX_FILE_BYTES)
      problems.push(`${file} is ${size} bytes, over Cloudflare Pages' 25 MiB per file`)
  }
  if (files.length + 1 > MAX_FILES)
    problems.push(`${files.length + 1} files, over Cloudflare Pages' ${MAX_FILES}`)
  if (problems.length > 0) throw new DistError(`Can't deploy dist`, problems)

  const rules = generateRules(pagesDir)
  // The same policies in each page, for the paths Pages serves it at that no rule reaches.
  addDocumentPolicies(pagesDir, rules)
  const headers = serializeHeaders(rules, [
    'Generated by make dist (scripts/build-dist): do not edit by hand.',
    'One Content-Security-Policy per path; the policies are in scripts/build-dist/src/policies.ts.',
  ])
  writeFileSync(join(pagesDir, '_headers'), headers)

  const privacyFile = join(pagesDir, 'privacy.html')
  const privacy = privacyProblems(
    rules,
    existsSync(privacyFile) ? readFileSync(privacyFile, 'utf8') : undefined,
  )
  if (privacy.length > 0) throw new DistError('The privacy page is out of date', privacy)

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(dirname(outDir), { recursive: true })
  renameSync(pagesDir, outDir)
  rmSync(stagingDir, { recursive: true, force: true })
  return {
    built: built.map((part) => part.name),
    skipped,
    files: files.length + 1,
    bytes: bytes + Buffer.byteLength(headers),
    rules: rules.length,
    packages: [...packages.values()],
  }
}
