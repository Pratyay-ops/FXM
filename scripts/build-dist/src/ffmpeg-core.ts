/**
 * Stage 4.2's ffmpeg core in the deployed app: FXM's own LGPL, audio-only build of FFmpeg for
 * WebAssembly (tools/ffmpeg-wasm), served at `/app/ffmpeg/` next to the app, which loads it in
 * its conversion worker.
 *
 * The core is built from a pinned recipe, not taken from npm, so the licence check can't read it
 * from a package: instead the files must be the ones the build's manifest names, built from the
 * current recipe, each under 25 MiB, with an LGPL licence from FFmpeg's configure and the
 * licence texts of its parts (`coreProblems`). Its notice names every part, its source and hash,
 * the configure line, the recipe at the commit being built, and carries those licence texts in
 * full (`coreNotice`).
 *
 * Building the core takes minutes, so `make check` never does: CI's ffmpeg-wasm job builds it
 * (cached by the recipe's hash) and hands it to `make dist`, and `make ffmpeg-wasm` builds it
 * locally and for releases. A dist composed without it (locally, outside CI) converts nothing and says so; in CI,
 * or with FXM_REQUIRE_FFMPEG_CORE=1, it fails instead.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CORE_DIST_FILES,
  coreDistDir,
  coreNotice,
  coreProblems,
  currentCommit,
  hasCore,
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
  /**
   * The commit the dist is built from, which the notice links the recipe at. Default:
   * `currentCommit()` (GITHUB_SHA in CI, else git's HEAD).
   */
  readonly commit?: string | (() => string | undefined)
}

/** The part that puts the built core into the app. */
export function createFfmpegCorePart(options: FfmpegCorePartOptions = {}): Part {
  const required =
    options.required ?? (process.env.CI === 'true' || process.env.FXM_REQUIRE_FFMPEG_CORE === '1')
  const commit = () =>
    typeof options.commit === 'function' ? options.commit() : (options.commit ?? currentCommit())
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
      // Each file the core has; coreProblems reports any that is missing.
      for (const name of CORE_DIST_FILES) {
        const from = join(dir, name)
        const to = join(outDir, CORE_FOLDER, name)
        mkdirSync(dirname(to), { recursive: true })
        try {
          copyFileSync(from, to)
        } catch {
          // Missing: the checks below name it.
        }
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
      if (problems.length === 0) {
        const at = commit()
        if (at === undefined) {
          problems.push(
            "can't tell which commit this dist is built from (no GITHUB_SHA, no git): the core's notice links its recipe at that commit",
          )
        } else {
          try {
            notice = coreNotice(dir, { repositoryUrl, commit: at })
          } catch (error) {
            problems.push(`the core's notice can't be written: ${(error as Error).message}`)
          }
          // The core never ships without its notice.
          if (notice.trim() === '' && problems.length === 0) {
            problems.push("the core's notice is empty")
          }
        }
      }
      return {
        files: CORE_DIST_FILES.map((name) => `${CORE_FOLDER}/${name}`),
        problems,
        notice,
      }
    },
  }
}

/** The core part make dist uses. */
export const ffmpegCorePart: Part = createFfmpegCorePart()
