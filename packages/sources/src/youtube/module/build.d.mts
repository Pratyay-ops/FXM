/**
 * Types for `build.mjs`, so TypeScript tests can build the module without Vite's (Node) types
 * reaching the YouTube code's TypeScript setup.
 */

/** A Vite plugin; only tests pass any. */
export type ModulePlugin = object

/** Options for {@link buildYouTubeModule}. */
export interface BuildOptions {
  /** Also write the file into this folder. Default: build in memory only. */
  readonly outDir?: string
  /** Minify the output. Default `true`. */
  readonly minify?: boolean
  /** Tests only: build with another `YOUTUBE_MODULE_VERSION`. */
  readonly version?: number
  /** Tests only: extra Vite plugins, e.g. one that breaks a parser on purpose. */
  readonly plugins?: readonly ModulePlugin[]
}

/** The built module. */
export interface BuiltModule {
  /** Its file name, `youtube-module-<api>.js`. */
  readonly fileName: string
  /** Its app-module contract version. */
  readonly api: number
  /** Its version. */
  readonly version: number
  /** Its code. */
  readonly code: string
  /** Its code as UTF-8 bytes, as they are signed and published. */
  readonly bytes: Uint8Array<ArrayBuffer>
}

/**
 * Tests only: a plugin that breaks the parser of a `/player` answer's audio formats on purpose,
 * so it finds none.
 */
export function brokenFormatParser(): ModulePlugin

/** Builds the YouTube module as one self-contained ES module. */
export function buildYouTubeModule(options?: BuildOptions): Promise<BuiltModule>
