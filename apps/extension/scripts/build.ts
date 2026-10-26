/**
 * Builds FXM Connect for Chromium-based browsers and Firefox:
 *
 *   dist/chromium/  dist/firefox/                         unpacked extensions
 *   dist/fxm-connect-chromium-<version>.zip  (and firefox)  packages for a release
 *
 * FXM_EXTENSION_DEV=1 builds the development variant, which also allows the localhost FXM
 * origins, into dist/dev/ instead (dist/dev/chromium/, dist/dev/fxm-connect-chromium-<version>
 * -dev.zip and so on), apart from the release files. Only it keeps the options page's
 * development parts (scripts/options-page.ts). Every build carries the repository's LICENSE and
 * FXM Connect's NOTICE.
 *
 * Run with `pnpm --filter @fxm/extension build` or `make extension`. Node runs this file
 * directly (type stripping), which is why the imports spell out `.ts`.
 */
import { realpathSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { fxmOrigins } from '../src/config.ts'
import { type Browser, buildManifest, ICON_SIZES, packageVersion } from '../src/manifest.ts'
import { buildRulesets } from '../src/rules.ts'
import { iconPng, iconSvg } from './icons.ts'
import { optionsPage } from './options-page.ts'
import { isDevVariant, outputNames, stagingFolder } from './variant.ts'
import { createZip, type ZipEntry } from './zip.ts'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPOSITORY_DIR = join(PACKAGE_DIR, '..', '..')
const DIST = join(PACKAGE_DIR, 'dist')
const BROWSERS: readonly Browser[] = ['chromium', 'firefox']

/** Script bundles: output name → entry. Each becomes one self-contained classic script. */
const ENTRIES = {
  background: 'src/background.ts',
  content: 'src/content.ts',
  options: 'src/options/options.ts',
} as const

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function text(name: string, value: string): ZipEntry {
  return { name, data: new TextEncoder().encode(value) }
}

/**
 * The files both browsers' builds ship besides the bundled scripts and the manifest: the
 * options page and its stylesheet, the icons, the rulesets, and the repository's LICENSE with
 * FXM Connect's NOTICE, which say under which licence it ships and that it bundles no
 * third-party code.
 */
export async function staticFiles(dev: boolean): Promise<ZipEntry[]> {
  const html = await readFile(join(PACKAGE_DIR, 'src/options/options.html'), 'utf8')
  return [
    text('options.html', optionsPage(html, dev)),
    { name: 'options.css', data: await readFile(join(PACKAGE_DIR, 'src/options/options.css')) },
    ...ICON_SIZES.map((size) => ({ name: `icons/icon-${size}.png`, data: iconPng(size) })),
    text('icons/icon.svg', iconSvg()),
    ...buildRulesets(fxmOrigins(dev)).map((ruleset) => text(ruleset.path, json(ruleset.rules))),
    { name: 'LICENSE', data: await readFile(join(REPOSITORY_DIR, 'LICENSE')) },
    { name: 'NOTICE', data: await readFile(join(PACKAGE_DIR, 'NOTICE')) },
  ]
}

async function bundle(outDir: string, define: Record<string, string>): Promise<void> {
  for (const [name, entry] of Object.entries(ENTRIES)) {
    await build({
      configFile: false,
      root: PACKAGE_DIR,
      publicDir: false,
      logLevel: 'warn',
      define,
      build: {
        outDir,
        emptyOutDir: false,
        // Readable output: store reviewers read what ships, and there is no remote code.
        minify: false,
        sourcemap: false,
        target: 'es2022',
        reportCompressedSize: false,
        lib: {
          entry: join(PACKAGE_DIR, entry),
          formats: ['iife'],
          name: `fxmConnect${name[0]?.toUpperCase()}${name.slice(1)}`,
          fileName: () => `${name}.js`,
        },
      },
    })
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

export interface BuildOptions {
  /** The development build, which also allows the localhost FXM origins. */
  readonly dev: boolean
  /** Where the builds go: dist/ in this package unless a test builds elsewhere. */
  readonly dist?: string
  readonly log?: (message: string) => void
}

/** Builds both browsers' extensions and their zips into `dist` (see the top of this file). */
export async function buildExtension({
  dev,
  dist = DIST,
  log = console.log,
}: BuildOptions): Promise<void> {
  const version = packageVersion(
    JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8')),
  )
  const origins = fxmOrigins(dev)
  const staging = join(dist, stagingFolder(dev))

  await rm(staging, { recursive: true, force: true })
  for (const browser of BROWSERS) {
    const names = outputNames(browser, version, dev)
    await rm(join(dist, names.folder), { recursive: true, force: true })
    await rm(join(dist, names.zip), { force: true })
  }

  // Shared by both browsers: scripts, options page, icons, rulesets and the licence files.
  await bundle(staging, {
    __FXM_VERSION__: JSON.stringify(version),
    __FXM_DEV__: JSON.stringify(dev),
    __FXM_ORIGINS__: JSON.stringify(origins),
  })
  for (const file of await staticFiles(dev)) {
    await mkdir(dirname(join(staging, file.name)), { recursive: true })
    await writeFile(join(staging, file.name), file.data)
  }

  for (const browser of BROWSERS) {
    const names = outputNames(browser, version, dev)
    const folder = join(dist, names.folder)
    await cp(staging, folder, { recursive: true })
    await writeFile(join(folder, 'manifest.json'), json(buildManifest({ browser, version, dev })))
    const files = await listFiles(folder)
    const entries = await Promise.all(
      files.map(async (name) => ({ name, data: await readFile(join(folder, name)) })),
    )
    await mkdir(dirname(join(dist, names.zip)), { recursive: true })
    await writeFile(join(dist, names.zip), createZip(entries))
    log(`FXM Connect ${version}${dev ? ' (dev)' : ''}: dist/${names.folder}, dist/${names.zip}`)
  }
  await rm(staging, { recursive: true, force: true })
}

/** True when Node runs this file (`node scripts/build.ts`), not when a test imports it. */
function isMain(): boolean {
  const script = process.argv[1]
  return (
    script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  )
}

if (isMain()) await buildExtension({ dev: isDevVariant(process.env.FXM_EXTENSION_DEV) })
