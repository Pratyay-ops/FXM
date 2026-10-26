/**
 * Stage 4.2's ffmpeg core in the deployed app: FXM's own LGPL, audio-only build of FFmpeg for
 * WebAssembly (tools/ffmpeg-wasm), served at `/app/ffmpeg/` next to the app, which loads it in
 * its conversion worker.
 *
 * The core is built from a pinned recipe, not taken from npm, so the licence check can't read it
 * from a package: instead the files must be the ones the build's manifest names, built from the
 * current recipe, each under 25 MiB, with an LGPL licence from FFmpeg's configure
 * (`coreProblems`). Its notice names every part, its source and hash, and the configure line.
 *
 * Building the core takes minutes, so `make check` never does: CI's ffmpeg-wasm job builds it
 * (cached by the recipe's hash) and hands it to `make dist`, and `make ffmpeg-wasm` builds it
 * locally and for releases. A dist composed without it (locally, outside CI) converts nothing and says so; in CI,
 * or with FXM_REQUIRE_FFMPEG_CORE=1, it fails instead.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CORE_FILES,
  coreDistDir,
  coreNotice,
  coreProblems,
  hasCore,
  readCoreManifest,
} from '../../../tools/ffmpeg-wasm/core-build.ts'
import type { Part } from './parts.ts'

/** The app's folder for the core: `/app/ffmpeg/`. */
export const CORE_FOLDER = 'ffmpeg'

export interface FfmpegCorePartOptions {
  /** Where the built core is. Default: `coreDistDir()` (FXM_FFMPEG_CORE_DIR, or `.tools/`). */
  readonly dir?: string
  /** Whether make dist fails without it. Default: in CI, or with FXM_REQUIRE_FFMPEG_CORE=1. */
  readonly required?: boolean
  /** The recipe hash the core must be built from. Default: the current recipe's. */
  readonly expectedRecipeHash?: string
}

/** The part that puts the built core into the app. */
export function createFfmpegCorePart(options: FfmpegCorePartOptions = {}): Part {
  const required =
    options.required ?? (process.env.CI === 'true' || process.env.FXM_REQUIRE_FFMPEG_CORE === '1')
  return {
    name: 'ffmpeg-core',
    mount: 'app',
    required,
    spa: false,
    sourceMaps: false,
    build(outDir, { log }) {
      const dir = options.dir ?? coreDistDir()
      if (!hasCore(dir)) {
        log(
          `ffmpeg-core: no core in ${dir}, so this dist can't convert downloads (make ffmpeg-wasm builds one)`,
        )
        return false
      }
      mkdirSync(join(outDir, CORE_FOLDER), { recursive: true })
      for (const name of Object.values(CORE_FILES)) {
        copyFileSync(join(dir, name), join(outDir, CORE_FOLDER, name))
      }
      log(`ffmpeg-core: ${dir}`)
      return true
    },
    prebuilt(outDir, repositoryUrl) {
      const dir = join(outDir, CORE_FOLDER)
      const problems = coreProblems(
        dir,
        options.expectedRecipeHash === undefined
          ? {}
          : { expectedRecipeHash: options.expectedRecipeHash },
      )
      let notice = ''
      try {
        notice = coreNotice(readCoreManifest(dir), repositoryUrl)
      } catch {
        // coreProblems reports the manifest it can't read.
      }
      return {
        files: Object.values(CORE_FILES).map((name) => `${CORE_FOLDER}/${name}`),
        problems,
        notice,
      }
    },
  }
}

/** The core part make dist uses. */
export const ffmpegCorePart: Part = createFfmpegCorePart()
