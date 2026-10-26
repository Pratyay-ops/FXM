/**
 * Builds the YouTube module: `entry.ts` and everything it uses (the YouTube providers,
 * youtubei.js, `@fxm/core`) as one self-contained ES module, `youtube-module-<api>.js`, which
 * exports `youtubeModule`. It has no imports, no chunks and no assets, so it runs from a `blob:`
 * URL. It opens with the licence notices of everything bundled into it, so the file carries them
 * wherever it goes. The same sources and lockfile give the same bytes, so anyone can rebuild a
 * published module and compare. `scripts/sign-module.sh` builds and signs it; tests build it to
 * check the real bundle.
 *
 * Plain JavaScript with types in `build.d.mts`, because the YouTube code's own TypeScript setup
 * has no Node types. Node runs it with type stripping, which also lets it read `version.ts`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
// The licence helpers make dist's third-party notices use too, so both read packages alike.
import { packageNotices } from '../../../../../scripts/build-dist/src/notices.ts'
import { YOUTUBE_MODULE_API, YOUTUBE_MODULE_FILE, YOUTUBE_MODULE_VERSION } from './version.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** FXM's licence, the Apache License 2.0, which also covers the bundled Apache-licensed code. */
const FXM_LICENSE = fileURLToPath(new URL('../../../../../LICENSE', import.meta.url))
const SOURCE = 'https://github.com/Pratyay-ops/FXM'
const NODE_MODULES = '/node_modules/'

/**
 * A plugin that gives the module another version. Only tests use it: a published module takes
 * its version from `version.ts`.
 *
 * @param {number} version
 * @returns {import('vite').Plugin}
 */
function versionOverride(version) {
  return {
    name: 'fxm-youtube-module-version',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/youtube/module/version.ts')) return undefined
      const pattern = /export const YOUTUBE_MODULE_VERSION = \d+/u
      if (!pattern.test(code)) throw new Error('version.ts has no YOUTUBE_MODULE_VERSION to change')
      return code.replace(pattern, `export const YOUTUBE_MODULE_VERSION = ${version}`)
    },
  }
}

/**
 * Tests only: a plugin that breaks one parser on purpose, the one that reads the audio formats
 * of a `/player` answer, so that it finds none. It stands in for a YouTube change that broke the
 * shipped parser, for the tests that show a module update fixing it without an app update.
 *
 * @returns {import('vite').Plugin}
 */
export function brokenFormatParser() {
  return {
    name: 'fxm-broken-format-parser',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/youtube/stream/formats.ts')) return undefined
      const start = 'export function streamOptionsOf('
      if (!code.includes(start)) throw new Error('formats.ts has no streamOptionsOf to break')
      return code.replace(
        start,
        'export function streamOptionsOf(..._args: unknown[]): never[] {\n  return []\n}\nfunction workingStreamOptionsOf(',
      )
    },
  }
}

/**
 * The bundled npm packages, by folder: each with the bundled files from it, in order.
 *
 * @param {readonly string[]} moduleIds
 * @returns {Map<string, string[]>}
 */
function bundledPackages(moduleIds) {
  const packages = new Map()
  for (const raw of [...moduleIds].sort()) {
    if (raw.startsWith('\0')) continue
    const id = raw.split('?')[0] ?? raw
    const at = id.lastIndexOf(NODE_MODULES)
    if (at === -1) continue
    const parts = id.slice(at + NODE_MODULES.length).split('/')
    const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    const root = `${id.slice(0, at)}${NODE_MODULES}${name}`
    packages.set(root, [...(packages.get(root) ?? []), id])
  }
  return packages
}

/**
 * A package's licence notices: its licence files, then the copyright and licence comments of its
 * bundled files that add to them (scripts/build-dist/src/notices.ts). That keeps the notices of
 * code a package took from elsewhere, such as Google's in `@bufbuild/protobuf`'s varint code, and
 * gives a package that ships no licence file (`@bufbuild/protobuf` again) its files' notices.
 *
 * @param {string} root
 * @param {readonly string[]} files
 */
function noticesOf(root, files) {
  const { licenceFiles, fileNotices } = packageNotices(root, files)
  const texts = [...licenceFiles.map((file) => file.text), ...fileNotices]
  if (texts.length === 0) throw new Error(`No licence notice found for the bundled ${root}`)
  return texts.join('\n\n')
}

/**
 * The licence banner the module opens with: what it is, then the notices of each bundled
 * package, then FXM's licence. A `/*!` comment, which minifiers keep.
 *
 * @param {readonly string[]} moduleIds
 * @param {number} version
 */
async function licenseBanner(moduleIds, version) {
  const sections = []
  for (const [root, files] of bundledPackages(moduleIds)) {
    const {
      name,
      version: packageVersion,
      license,
    } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    sections.push(`== ${name} ${packageVersion}: ${license} ==\n\n${noticesOf(root, files)}`)
  }
  sections.sort()
  const text = [
    `FXM YouTube resolver module, version ${version}, contract ${YOUTUBE_MODULE_API}: ${SOURCE}`,
    'FXM’s own code in this file (its packages/core and packages/sources) is licensed under the Apache License 2.0, whose text ends this notice. The file also contains the software below, each under the notices that follow its name.',
    ...sections,
    `== Apache License 2.0 ==\n\n${(await readFile(FXM_LICENSE, 'utf8')).trim()}`,
  ].join('\n\n')
  const body = text
    .replaceAll('*/', '* /')
    .split('\n')
    .map((line) => ` * ${line}`.trimEnd())
    .join('\n')
  return `/*!\n${body}\n */\n`
}

/**
 * Builds the module and returns its code. With `outDir`, also writes it there.
 *
 * @param {import('./build.d.mts').BuildOptions} [options]
 * @returns {Promise<import('./build.d.mts').BuiltModule>}
 */
export async function buildYouTubeModule(options = {}) {
  const version = options.version ?? YOUTUBE_MODULE_VERSION
  const plugins = [
    ...(options.version === undefined ? [] : [versionOverride(options.version)]),
    ...(options.plugins ?? []),
  ]
  const result = await build({
    configFile: false,
    root: HERE,
    logLevel: 'warn',
    publicDir: false,
    plugins,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      write: false,
      copyPublicDir: false,
      sourcemap: false,
      reportCompressedSize: false,
      // Vite leaves whitespace alone in an ES library; Rolldown's own minifier doesn't.
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./entry.ts', import.meta.url)),
        formats: ['es'],
        fileName: () => YOUTUBE_MODULE_FILE,
      },
      rolldownOptions: { output: { codeSplitting: false, minify: options.minify ?? true } },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) =>
    'output' in entry ? entry.output : [],
  )
  const chunks = outputs.filter((output) => output.type === 'chunk')
  if (chunks.length !== 1 || outputs.length !== 1) {
    throw new Error(`The module must build to one file, not ${outputs.length}`)
  }
  const [chunk] = chunks
  // The YouTube code loads youtubei.js lazily with `import()`. Here that import is inlined, and
  // Rolldown then lists the file itself among its dynamic imports, which loads nothing.
  const imported = [
    ...chunk.imports,
    ...chunk.dynamicImports.filter((name) => name !== chunk.fileName),
  ]
  if (imported.length > 0) {
    throw new Error(`The module must not import anything: ${imported.join(', ')}`)
  }
  if (!chunk.exports.includes('youtubeModule')) {
    throw new Error('The module must export youtubeModule')
  }
  const code = `${await licenseBanner(chunk.moduleIds, version)}${chunk.code}`
  const bytes = new TextEncoder().encode(code)
  if (options.outDir !== undefined) {
    await mkdir(options.outDir, { recursive: true })
    await writeFile(join(options.outDir, YOUTUBE_MODULE_FILE), bytes)
  }
  return { fileName: YOUTUBE_MODULE_FILE, api: YOUTUBE_MODULE_API, version, code, bytes }
}
