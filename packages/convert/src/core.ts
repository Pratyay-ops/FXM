/**
 * FXM's ffmpeg core (tools/ffmpeg-wasm) in a worker or in Node: loading it from the site, checking
 * it, and running one conversion at a time.
 *
 * The core is three files served together, by default from the app's `ffmpeg/` folder:
 * `ffmpeg-core.json` (what the build is, with each file's SHA-256), `ffmpeg-core.js`
 * (Emscripten's module factory) and `ffmpeg-core.wasm`. Before anything runs, the WebAssembly
 * must match the manifest's hash, and the libraries inside must report an LGPL licence.
 *
 * @module
 */

import type { CoreJob } from './plan'
import { ConvertError, type ConvertErrorCode } from './types'

/** The file names of a built core. */
export const CORE_FILES = Object.freeze({
  script: 'ffmpeg-core.js',
  wasm: 'ffmpeg-core.wasm',
  manifest: 'ffmpeg-core.json',
})

/** What FFmpeg's libraries may report as their licence. */
const LGPL = /^LGPL version (2\.1|3) or later$/

/** What the core says about itself (`fxm_version`). */
export interface CoreVersion {
  /** FFmpeg's version, e.g. `9.0.2`. */
  readonly ffmpeg: string
  /** The libraries' licence, e.g. `LGPL version 2.1 or later`. */
  readonly license: string
  /** FFmpeg's configure line. */
  readonly configuration: string
}

/** What the core found in an input (`fxm_probe`). */
export interface CoreProbe {
  readonly format: string
  readonly codec: string
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerRawSample: number
  readonly bitRate: number
  readonly durationSeconds: number
  readonly sampleFormat: string
  /** How many streams the input has: an MP3's embedded cover counts as one. */
  readonly streams: number
}

/** A loaded core: runs one conversion at a time, synchronously inside a worker. */
export interface FfmpegCore {
  readonly version: CoreVersion
  /**
   * Converts `input` (named `input.<inputExtension>`, which helps the core recognise it) as
   * `job` says, and returns the output file. `onProgress` gets the fraction converted, 0 to 1.
   */
  convert(
    input: Blob | Uint8Array,
    job: CoreJob,
    options: {
      inputExtension: string
      outputExtension: string
      onProgress?: (done: number) => void
    },
  ): Promise<Uint8Array>
  /** What the core finds in `input`. */
  probe(input: Blob | Uint8Array, inputExtension: string): Promise<CoreProbe>
}

/** The core's manifest, as far as loading it needs. */
interface CoreManifest {
  readonly schema: 1
  readonly ffmpegLicense: string
  readonly files: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>
}

/** What FXM uses of the core's Emscripten file system. */
export interface CoreFileSystem {
  mkdir(path: string): void
  mount(type: unknown, options: unknown, mountpoint: string): void
  unmount(mountpoint: string): void
  writeFile(path: string, data: Uint8Array): void
  readFile(path: string): Uint8Array
  unlink(path: string): void
  analyzePath(path: string): { exists: boolean }
  readonly filesystems: Readonly<Record<string, unknown>>
}
/** What FXM uses of the core's Emscripten module (see tools/ffmpeg-wasm/recipe/build.sh). */
export interface CoreModule {
  readonly FS: CoreFileSystem
  ccall(name: string, returns: 'number' | 'string', types: string[], args: unknown[]): unknown
  /** Called by fxm_convert.c with the seconds converted and the input's length. */
  onConvertProgress?: ((done: number, total: number) => void) | undefined
}

/** The default export of `ffmpeg-core.js`: Emscripten's module factory. */
export type CoreModuleFactory = (options: Record<string, unknown>) => Promise<CoreModule>

/** How {@link loadFfmpegCore} reaches the files; tests and Node pass their own. */
export interface CoreLoaderOptions {
  /** Fetches the manifest and the WebAssembly. Default: the global `fetch`. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Imports the module factory. Default: a dynamic `import()` of its URL. */
  importScript?: (url: string) => Promise<{ default: CoreModuleFactory }>
  /** Where the core's warnings go. Default: nowhere. */
  log?: (line: string) => void
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function unavailable(message: string, cause?: unknown): ConvertError {
  return new ConvertError('core-unavailable', message, cause === undefined ? undefined : { cause })
}

function isManifest(value: unknown): value is CoreManifest {
  const manifest = value as Partial<CoreManifest> | null
  return (
    typeof manifest === 'object' &&
    manifest !== null &&
    manifest.schema === 1 &&
    typeof manifest.ffmpegLicense === 'string' &&
    typeof manifest.files === 'object' &&
    manifest.files !== null
  )
}

/** Percent-encodes what the options format needs: `%` and line breaks. */
function optionValue(value: string | number): string {
  return String(value).replace(/%/g, '%25').replace(/\n/g, '%0A').replace(/\r/g, '%0D')
}

/** The `key=value` lines `fxm_convert` reads (fxm_convert.c). */
export function coreOptions(job: CoreJob): string {
  const lines = [`format=${job.format}`, `codec=${job.codec}`]
  if (job.bitRate !== undefined) lines.push(`bitrate=${Math.round(job.bitRate)}`)
  if (job.compressionLevel !== undefined) {
    lines.push(`compression_level=${job.compressionLevel}`)
  }
  for (const [key, value] of Object.entries(job.metadata ?? {})) {
    if (/^[A-Za-z0-9_-]+$/.test(key) && value !== '') {
      lines.push(`metadata.${key}=${optionValue(value)}`)
    }
  }
  return lines.join('\n')
}

/** FFmpeg's error tags (FFERRTAG), as the core returns them. */
function errorTag(a: number, b: string, c: string, d: string): number {
  return -(a | (b.charCodeAt(0) << 8) | (c.charCodeAt(0) << 16) | (d.charCodeAt(0) << 24))
}
const AVERROR_INVALIDDATA = errorTag(0x49, 'N', 'D', 'A')
const UNSUPPORTED_CODES = new Set([
  errorTag(0xf8, 'D', 'E', 'C'), // decoder not found
  errorTag(0xf8, 'D', 'E', 'M'), // demuxer not found
  errorTag(0xf8, 'S', 'T', 'R'), // stream not found
  errorTag(0xf8, 'E', 'N', 'C'), // encoder not found
])
/** ENOMEM: 12 in POSIX numbering, 48 in Emscripten's (WASI) numbering. */
const OUT_OF_MEMORY = new Set([-12, -48])

/** The error code for an FFmpeg result code. */
export function errorCodeOf(code: number): ConvertErrorCode {
  if (code === AVERROR_INVALIDDATA) return 'corrupt-input'
  if (UNSUPPORTED_CODES.has(code)) return 'unsupported-input'
  if (OUT_OF_MEMORY.has(code)) return 'out-of-memory'
  return 'failed'
}

/**
 * Loads the core from `base` (a URL ending in `/`): fetches and checks the manifest, fetches the
 * WebAssembly and checks its SHA-256 against it, imports the module factory, instantiates it, and
 * refuses a core whose libraries don't report an LGPL licence.
 *
 * @throws ConvertError `core-unavailable` when any of that fails.
 */
export async function loadFfmpegCore(
  base: string,
  options: CoreLoaderOptions = {},
): Promise<FfmpegCore> {
  const fetchFile = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const importScript =
    options.importScript ??
    ((url: string) => import(/* @vite-ignore */ url) as Promise<{ default: CoreModuleFactory }>)
  const url = (name: string, version?: string) =>
    new URL(version ? `${name}?v=${version}` : name, base).href

  let manifest: CoreManifest
  try {
    const response = await fetchFile(url(CORE_FILES.manifest), { cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!isManifest(value)) throw new Error('not an ffmpeg core manifest')
    manifest = value
  } catch (error) {
    throw unavailable(`The ffmpeg core isn't available here: ${(error as Error).message}`, error)
  }
  if (!LGPL.test(manifest.ffmpegLicense)) {
    throw unavailable(`The ffmpeg core reports the licence "${manifest.ffmpegLicense}"`)
  }
  const wasmInfo = manifest.files[CORE_FILES.wasm]
  const scriptInfo = manifest.files[CORE_FILES.script]
  if (!wasmInfo || !scriptInfo) throw unavailable('The ffmpeg core manifest lists no files')

  // The query keeps a browser from mixing a cached old file with a new one.
  let wasm: ArrayBuffer | undefined
  for (const cache of ['default', 'reload'] as const) {
    try {
      const response = await fetchFile(url(CORE_FILES.wasm, wasmInfo.sha256.slice(0, 16)), {
        cache,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = await response.arrayBuffer()
      if ((await sha256Hex(bytes)) === wasmInfo.sha256) {
        wasm = bytes
        break
      }
    } catch (error) {
      if (cache === 'reload') {
        throw unavailable(`The ffmpeg core can't be downloaded: ${(error as Error).message}`, error)
      }
    }
  }
  if (wasm === undefined) throw unavailable("The ffmpeg core doesn't match its manifest")

  let module: CoreModule
  try {
    const factory = (await importScript(url(CORE_FILES.script, scriptInfo.sha256.slice(0, 16))))
      .default
    module = await factory({
      wasmBinary: wasm,
      print: () => {},
      printErr: (line: string) => options.log?.(line),
    })
  } catch (error) {
    throw unavailable(`The ffmpeg core can't start: ${(error as Error).message}`, error)
  }
  const version = JSON.parse(module.ccall('fxm_version', 'string', [], []) as string) as CoreVersion
  if (!LGPL.test(version.license)) {
    throw unavailable(`The ffmpeg core's libraries report the licence "${version.license}"`)
  }
  return createCore(module, version)
}

const INPUT_DIR = '/fxm-input'
const OUTPUT_DIR = '/fxm-output'

/** A {@link FfmpegCore} on an instantiated module. */
export function createCore(module: CoreModule, version: CoreVersion): FfmpegCore {
  const { FS } = module
  for (const dir of [INPUT_DIR, OUTPUT_DIR]) {
    if (!FS.analyzePath(dir).exists) FS.mkdir(dir)
  }
  const workerFs = FS.filesystems.WORKERFS
  // WORKERFS reads a Blob lazily, with FileReaderSync, which only workers have.
  const canMount =
    workerFs !== undefined &&
    typeof (globalThis as { FileReaderSync?: unknown }).FileReaderSync === 'function'

  /** Puts `input` at a path the core reads; returns it and how to clean up. */
  const place = async (input: Blob | Uint8Array, name: string) => {
    const path = `${INPUT_DIR}/${name}`
    if (input instanceof Blob && canMount) {
      FS.mount(workerFs, { blobs: [{ name, data: input }] }, INPUT_DIR)
      return { path, release: () => FS.unmount(INPUT_DIR) }
    }
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input
    FS.writeFile(path, bytes)
    return { path, release: () => FS.unlink(path) }
  }

  const lastError = () => {
    const message = module.ccall('fxm_last_error', 'string', [], []) as string
    const log = (module.ccall('fxm_log', 'string', [], []) as string).trim()
    return log ? `${message}\n${log}` : message
  }

  return {
    version,
    async convert(input, job, { inputExtension, outputExtension, onProgress }) {
      const { path, release } = await place(input, `input.${inputExtension}`)
      const output = `${OUTPUT_DIR}/output.${outputExtension}`
      module.onConvertProgress = (done, total) => {
        if (total > 0) onProgress?.(Math.min(1, Math.max(0, done / total)))
      }
      let code: number
      try {
        code = module.ccall(
          'fxm_convert',
          'number',
          ['string', 'string', 'string'],
          [path, output, coreOptions(job)],
        ) as number
      } catch (error) {
        // A trap (out of memory, a crash): this module can't be trusted any more.
        throw new ConvertError(
          /memory|OOM/i.test(String(error)) ? 'out-of-memory' : 'failed',
          `The ffmpeg core stopped: ${(error as Error).message}`,
          { cause: error },
        )
      } finally {
        delete module.onConvertProgress
        release()
      }
      try {
        if (code < 0) throw new ConvertError(errorCodeOf(code), lastError())
        return FS.readFile(output)
      } finally {
        if (FS.analyzePath(output).exists) FS.unlink(output)
      }
    },
    async probe(input, inputExtension) {
      const { path, release } = await place(input, `input.${inputExtension}`)
      try {
        const json = module.ccall('fxm_probe', 'string', ['string'], [path]) as string | null
        if (!json) throw new ConvertError('unsupported-input', lastError())
        return JSON.parse(json) as CoreProbe
      } finally {
        release()
      }
    },
  }
}
