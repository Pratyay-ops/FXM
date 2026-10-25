/**
 * Fakes for the tests: temporary folders, npm packages, bundles with source maps, and parts
 * that write files instead of running a build. fakeEmbedPart() and fakeSandboxPart() stand in
 * for the stages behind later-stages.ts (5.2, 1.10, 1.11).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { serializePolicy, sha256Source } from './csp.ts'
import type { InventoryEntry } from './licenses.ts'
import type { Part } from './parts.ts'
import { APP_SERVICES, isSandboxDocument, SANDBOX_DOCUMENTS } from './policies.ts'

const made: string[] = []

/** A fresh folder (a real path, so source map paths resolve), removed by removeTempDirs(). */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fxm-dist-test-')))
  made.push(dir)
  return dir
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
}

export interface FakePackage {
  name: string
  version: string
  /** package.json's license field; left out when undefined. */
  license?: string
  /** Files next to package.json, such as LICENSE. */
  files?: Record<string, string>
}

/** Installs a package the way pnpm lays it out; returns its main file. */
export function installPackage(root: string, pkg: FakePackage): string {
  const dir = join(
    root,
    'node_modules',
    '.pnpm',
    `${pkg.name.replace('/', '+')}@${pkg.version}`,
    'node_modules',
    pkg.name,
  )
  writeFiles(dir, {
    'package.json': JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      ...(pkg.license === undefined ? {} : { license: pkg.license }),
      homepage: `https://example.com/${pkg.name}`,
    }),
    'index.js': 'export default 1\n',
    ...pkg.files,
  })
  return join(dir, 'index.js')
}

/** A hidden source map at outDir/mapFile naming the given source files. */
export function sourceMap(
  outDir: string,
  mapFile: string,
  sources: readonly string[],
): Record<string, string> {
  const mapDir = dirname(join(outDir, mapFile))
  return {
    [mapFile]: JSON.stringify({
      version: 3,
      file: mapFile
        .split('/')
        .pop()
        ?.replace(/\.map$/, ''),
      sources: sources.map((source) => relative(mapDir, source)),
      mappings: '',
    }),
  }
}

/** A bundle at outDir/file with its hidden source map. */
export function bundle(
  outDir: string,
  file: string,
  sources: readonly string[],
): Record<string, string> {
  return { [file]: 'console.log(1)\n', ...sourceMap(outDir, `${file}.map`, sources) }
}

/**
 * A part that writes files: `files` gets the part's output folder. `inventory` is what its
 * bundler would record (src/bundle-inventory.ts).
 */
export function fakePart(
  part: Pick<Part, 'name' | 'mount'> & Partial<Omit<Part, 'build'>>,
  files: (outDir: string) => Record<string, string>,
  inventory?: (outDir: string) => readonly InventoryEntry[],
): Part {
  return {
    required: false,
    spa: false,
    sourceMaps: true,
    ...part,
    build(outDir, { inventoryFile }) {
      writeFiles(outDir, files(outDir))
      const entries = inventory?.(outDir) ?? []
      if (entries.length > 0) {
        writeFileSync(inventoryFile, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
      }
      return true
    },
  }
}

/** A part that doesn't exist yet. */
export function absentPart(
  part: Pick<Part, 'name' | 'mount'> & Partial<Omit<Part, 'build'>>,
): Part {
  return { required: false, spa: false, sourceMaps: true, ...part, build: () => false }
}

/** A privacy page listing the given services the way the site renders them. */
export function privacyPage(
  names: readonly string[] = APP_SERVICES.map((service) => service.privacyName),
): string {
  const entries = names
    .map(
      (name) =>
        `<div data-astro-cid-x><dt data-astro-cid-x><a href="https://example.com" data-astro-cid-x>${name}</a></dt><dd>Use.</dd></div>`,
    )
    .join('')
  return `<!doctype html><html lang="en"><head><title>Privacy</title><link rel="stylesheet" href="/_astro/site.css"></head><body><h1>Privacy</h1><dl class="services">${entries}</dl></body></html>`
}

export const SITE_SCRIPT = 'menu()'
export const SITE_STYLE = 'h1{color:red}'

/** The landing page: three documents, a stylesheet, robots.txt and a .well-known file. */
export function fakeSitePart(root: string, options: { privacy?: string } = {}): Part {
  writeFiles(root, { 'apps/site/src/header.ts': 'export {}\n' })
  return fakePart({ name: 'site', mount: '', required: true }, (outDir) => ({
    'index.html': `<!doctype html><html lang="en"><head><title>FXM</title><link rel="stylesheet" href="/_astro/site.css"><style>${SITE_STYLE}</style></head><body><h1>FXM</h1><script type="module">${SITE_SCRIPT}</script></body></html>`,
    'privacy.html': options.privacy ?? privacyPage(),
    '404.html':
      '<!doctype html><html lang="en"><head><title>Not found</title></head><body><h1>Not found</h1></body></html>',
    '_astro/site.css': 'body{margin:0}',
    'robots.txt': 'User-agent: *\n',
    '.well-known/security.txt': 'Contact: https://example.com\n',
    // Astro inlines small scripts and keeps only their source maps.
    ...sourceMap(outDir, '_astro/header.js.map', [join(root, 'apps/site/src/header.ts')]),
  }))
}

export const APP_THEME_SCRIPT = "document.documentElement.dataset.theme = 'dark'"

/** A single-page app (the web app, or the embed) bundling the given packages. */
export function fakeAppPart(
  root: string,
  options: {
    name?: 'app' | 'embed'
    packages?: readonly FakePackage[]
    cssPackage?: FakePackage
  } = {},
): Part {
  const name = options.name ?? 'app'
  writeFiles(root, { [`apps/web/src/${name}.ts`]: 'export {}\n' })
  const sources = [
    join(root, `apps/web/src/${name}.ts`),
    ...(options.packages ?? []).map((pkg) => installPackage(root, pkg)),
  ]
  const css = options.cssPackage
  if (css) installPackage(root, css)
  return fakePart({ name, mount: name, required: name === 'app', spa: true }, (outDir) => ({
    'index.html': `<!doctype html><html lang="en"><head><title>FXM</title><script>${APP_THEME_SCRIPT}</script><script type="module" crossorigin src="/${name}/assets/index.js"></script><link rel="stylesheet" href="/${name}/assets/index.css"></head><body><div id="root"></div></body></html>`,
    ...bundle(outDir, 'assets/index.js', sources),
    'assets/index.css': `${css ? `/*! ${css.name} v${css.version} | ${css.license} License | https://example.com */\n` : ''}body{margin:0}`,
  }))
}

/** The script of a fake sandbox document: inert unless its origin is opaque, as later-stages.ts asks. */
export const sandboxScript = (name: string) =>
  `if (self.origin === 'null') addEventListener('message', () => {}) // ${name}`

/**
 * A sandbox document the way 1.10 builds them: one inline script, and its policy without
 * `sandbox` in a meta element before it (`meta: false` leaves the meta element out).
 */
export function sandboxDocument(
  name: string,
  script = sandboxScript(name),
  { meta = true } = {},
): string {
  if (!isSandboxDocument(name)) throw new Error(`${name} is not a sandbox document`)
  const policy = SANDBOX_DOCUMENTS[name]([sha256Source(script)]).filter(
    ([directive]) => directive !== 'sandbox',
  )
  const element = meta
    ? `<meta http-equiv="Content-Security-Policy" content="${serializePolicy(policy)}">`
    : ''
  return `<!doctype html><meta charset="utf-8">${element}<title>${name}</title><script>${script}</script>`
}

/** 1.10 and 1.11's sandbox documents. */
export function fakeSandboxPart(
  names: readonly string[] = ['innertube.html', 'userhost.html', 'eval.html'],
): Part {
  return fakePart({ name: 'sandbox', mount: 'sandbox', sourceMaps: false }, () =>
    Object.fromEntries(names.map((name) => [name, sandboxDocument(name)])),
  )
}

/** 5.2's embed. */
export function fakeEmbedPart(root: string, packages: readonly FakePackage[] = []): Part {
  return fakeAppPart(root, { name: 'embed', packages })
}
