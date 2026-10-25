/**
 * Builds the YouTube module: `entry.ts` and everything it uses (the YouTube providers,
 * youtubei.js, `@fxm/core`) as one self-contained ES module, `youtube-module-<api>.js`, which
 * exports `youtubeModule`. It has no imports, no chunks and no assets, so it runs from a `blob:`
 * URL. `scripts/sign-module.sh` builds and signs it; tests build it to check the real bundle.
 *
 * Plain JavaScript with types in `build.d.mts`, because the YouTube code's own TypeScript setup
 * has no Node types. Node runs it with type stripping, which also lets it read `version.ts`.
 */
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { YOUTUBE_MODULE_API, YOUTUBE_MODULE_FILE, YOUTUBE_MODULE_VERSION } from './version.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))

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
      outDir: options.outDir ?? 'dist',
      emptyOutDir: false,
      write: options.outDir !== undefined,
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
  if (chunk.imports.length > 0 || chunk.dynamicImports.length > 0) {
    throw new Error(`The module must not import anything: ${chunk.imports.join(', ')}`)
  }
  if (!chunk.exports.includes('youtubeModule')) {
    throw new Error('The module must export youtubeModule')
  }
  return {
    fileName: YOUTUBE_MODULE_FILE,
    api: YOUTUBE_MODULE_API,
    version,
    code: chunk.code,
    bytes: new TextEncoder().encode(chunk.code),
  }
}
