/**
 * FXM's ffmpeg core, as built by recipe/build.sh: where a build lives, what its manifest
 * (ffmpeg-core.json) says, and the checks every build must pass before anything ships it: the
 * WebAssembly file is smaller than 25 MiB (Cloudflare Pages' limit per file), FFmpeg's
 * configure reported an LGPL licence, and the files are the ones the manifest names.
 *
 * Used by build.sh, by CI's ffmpeg-wasm job, by `make dist` (scripts/build-dist) and by the web
 * app's dev server. Plain Node with type stripping, no dependencies:
 *
 *   node --experimental-strip-types tools/ffmpeg-wasm/core-build.ts hash
 *   node --experimental-strip-types tools/ffmpeg-wasm/core-build.ts libs-hash
 *   node --experimental-strip-types tools/ffmpeg-wasm/core-build.ts dir
 *   node --experimental-strip-types tools/ffmpeg-wasm/core-build.ts check [dist folder]
 *   node --experimental-strip-types tools/ffmpeg-wasm/core-build.ts manifest <dist folder> …
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This folder: tools/ffmpeg-wasm. */
export const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

/** The recipe: everything that decides what the core contains. Its hash keys every build. */
export const RECIPE_DIR = join(TOOL_DIR, 'recipe')

/** The files of a built core, as the app serves them from `ffmpeg/`. */
export const CORE_FILES = {
  script: 'ffmpeg-core.js',
  wasm: 'ffmpeg-core.wasm',
  manifest: 'ffmpeg-core.json',
} as const

/** Cloudflare Pages refuses files of 25 MiB or more (ARCHITECTURE.md §3). */
export const MAX_CORE_FILE_BYTES = 25 * 1024 * 1024

/** What FFmpeg's configure may report: LGPL only, never GPL or "nonfree". */
export const LGPL_LICENCES: readonly string[] = [
  'LGPL version 2.1 or later',
  'LGPL version 3 or later',
]

/** Configure flags that would make the core GPL or non-free, or bring in such a library. */
const FORBIDDEN_FLAGS =
  /--enable-(gpl|nonfree|version3-only|libx264|libx265|libxvid|libfdk[-_]aac|libvidstab|frei0r|librubberband|libcdio|libdavs2|libxavs2|avisynth|libzvbi|postproc|libsmbclient)\b/

/** The licence of each part of the core, as SPDX identifiers. */
const ALLOWED_COMPONENT_LICENCES: ReadonlySet<string> = new Set([
  'LGPL-2.1-or-later',
  'LGPL-2.0-or-later',
  'LGPL-3.0-or-later',
  'BSD-3-Clause',
  'Apache-2.0',
])

/** One part of the core, for the third-party notices. */
export interface CoreComponent {
  readonly name: string
  readonly version: string
  /** SPDX identifier. */
  readonly license: string
  readonly homepage: string
  /** Where its source came from: a release tarball, or a file of this repository. */
  readonly source: string
  /** The tarball's SHA-256, checked by build.sh; absent for FXM's own file. */
  readonly sha256?: string
}

/** ffmpeg-core.json: what a build is, written by build.sh, read by every check. */
export interface CoreManifest {
  readonly schema: 1
  /** The hash of the recipe it was built from (recipeHash()). */
  readonly recipeHash: string
  /** What FFmpeg's configure reported, e.g. "LGPL version 2.1 or later". */
  readonly ffmpegLicense: string
  /** FFmpeg's configure line, as it is kept in the library. */
  readonly configure: string
  /** The emsdk version that compiled it. */
  readonly emscripten: string
  readonly components: readonly CoreComponent[]
  /** Patches applied to the sources: none today. */
  readonly patches: readonly string[]
  /** The script and the WebAssembly, by file name. */
  readonly files: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * The recipe's hash: SHA-256 over every file in recipe/, by relative path and content. A change
 * to any of them means a new build, in CI too (its cache is keyed by this hash).
 */
export function recipeHash(recipeDir: string = RECIPE_DIR): string {
  const lines = filesUnder(recipeDir)
    .map((file) => relative(recipeDir, file).split(sep).join('/'))
    .sort()
    .map((name) => `${name}\0${sha256(readFileSync(join(recipeDir, name)))}\n`)
  return sha256(lines.join(''))
}

/** The recipe files the libraries (Opus, LAME, FFmpeg) are built from: libs.sh's inputs. */
export const LIBRARY_FILES: readonly string[] = ['versions.sh', 'libs.sh', 'pkg-config.sh']

/**
 * The hash of what the libraries are built from (LIBRARY_FILES), so that build.sh reuses them
 * when only the converter or the link step changed.
 */
export function librariesHash(recipeDir: string = RECIPE_DIR): string {
  const lines = [...LIBRARY_FILES]
    .sort()
    .map((name) => `${name}\0${sha256(readFileSync(join(recipeDir, name)))}\n`)
  return sha256(lines.join(''))
}

/** The checkout's .tools folder: FXM_TOOLS (scripts/env.sh), else the main checkout's. */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FXM_TOOLS) return env.FXM_TOOLS
  // Outside scripts/run.sh: tools/ffmpeg-wasm is two levels below the checkout.
  return join(resolve(TOOL_DIR, '..', '..'), '.tools')
}

/**
 * Where the core built from the current recipe is, or would be: `FXM_FFMPEG_CORE_DIR` when set
 * (CI points it at a downloaded artifact), else `.tools/ffmpeg-wasm/builds/<hash>/dist`.
 */
export function coreDistDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FXM_FFMPEG_CORE_DIR) return resolve(env.FXM_FFMPEG_CORE_DIR)
  return join(toolsDir(env), 'ffmpeg-wasm', 'builds', recipeHash(), 'dist')
}

/** Whether a built core is there (its manifest, at least). */
export function hasCore(dir: string): boolean {
  return existsSync(join(dir, CORE_FILES.manifest))
}

/** Reads a core's manifest, or throws with the reason. */
export function readCoreManifest(dir: string): CoreManifest {
  const file = join(dir, CORE_FILES.manifest)
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof value !== 'object' || value === null || (value as { schema?: unknown }).schema !== 1) {
    throw new Error(`${file} is not an ffmpeg core manifest (schema 1)`)
  }
  return value as CoreManifest
}

/** The versions and pins of recipe/versions.sh, its variables expanded. */
export function readPins(recipeDir: string = RECIPE_DIR): Record<string, string> {
  const pins: Record<string, string> = {}
  for (const line of readFileSync(join(recipeDir, 'versions.sh'), 'utf8').split('\n')) {
    const match = /^([A-Z][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (!match) continue
    const [, name = '', raw = ''] = match
    pins[name] = raw
      .replace(/^"(.*)"$/, '$1')
      .replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, key: string) => pins[key] ?? '')
  }
  return pins
}

/** The parts of the core, for the manifest, from versions.sh. */
export function coreComponents(pins: Record<string, string> = readPins()): CoreComponent[] {
  const pin = (name: string) => {
    const value = pins[name]
    if (!value) throw new Error(`recipe/versions.sh has no ${name}`)
    return value
  }
  return [
    {
      name: 'FFmpeg',
      version: pin('FFMPEG_VERSION'),
      license: 'LGPL-2.1-or-later',
      homepage: 'https://ffmpeg.org/',
      source: pin('FFMPEG_URL'),
      sha256: pin('FFMPEG_SHA256'),
    },
    {
      name: 'LAME',
      version: pin('LAME_VERSION'),
      license: 'LGPL-2.0-or-later',
      homepage: 'https://lame.sourceforge.io/',
      source: pin('LAME_URL'),
      sha256: pin('LAME_SHA256'),
    },
    {
      name: 'Opus',
      version: pin('OPUS_VERSION'),
      license: 'BSD-3-Clause',
      homepage: 'https://opus-codec.org/',
      source: pin('OPUS_URL'),
      sha256: pin('OPUS_SHA256'),
    },
    {
      name: "FXM's converter",
      version: '',
      license: 'Apache-2.0',
      homepage: 'https://github.com/Pratyay-ops/FXM/tree/main/tools/ffmpeg-wasm',
      source: 'tools/ffmpeg-wasm/recipe/fxm_convert.c',
    },
  ]
}

/** Writes ffmpeg-core.json for the files in `dir`. */
export function writeCoreManifest(
  dir: string,
  details: { recipeHash: string; ffmpegLicense: string; configure: string; emscripten: string },
): CoreManifest {
  const files: Record<string, { bytes: number; sha256: string }> = {}
  for (const name of [CORE_FILES.script, CORE_FILES.wasm]) {
    const bytes = readFileSync(join(dir, name))
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) }
  }
  const manifest: CoreManifest = {
    schema: 1,
    ...details,
    components: coreComponents(),
    patches: [],
    files,
  }
  writeFileSync(join(dir, CORE_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * Why a built core may not ship (an empty list when it may): it must be complete, its files must
 * be the ones its manifest names, each under 25 MiB, built from the current recipe, with an LGPL
 * licence from FFmpeg's configure, no flag that brings in GPL or non-free code, and parts under
 * licences FXM accepts.
 */
export function coreProblems(
  dir: string,
  { expectedRecipeHash = recipeHash() }: { expectedRecipeHash?: string } = {},
): string[] {
  if (!hasCore(dir)) return [`no ffmpeg core in ${dir}: build it with make ffmpeg-wasm`]
  let manifest: CoreManifest
  try {
    manifest = readCoreManifest(dir)
  } catch (error) {
    return [(error as Error).message]
  }
  const problems: string[] = []
  for (const name of [CORE_FILES.script, CORE_FILES.wasm]) {
    const file = join(dir, name)
    const expected = manifest.files?.[name]
    if (!existsSync(file)) {
      problems.push(`${name} is missing`)
      continue
    }
    const bytes = readFileSync(file)
    if (!expected || expected.bytes !== bytes.length || expected.sha256 !== sha256(bytes)) {
      problems.push(`${name} is not the file ffmpeg-core.json describes`)
    }
    if (statSync(file).size >= MAX_CORE_FILE_BYTES) {
      problems.push(
        `${name} is ${bytes.length} bytes: it must stay under 25 MiB (${MAX_CORE_FILE_BYTES} bytes), Cloudflare Pages' limit per file`,
      )
    }
  }
  if (!LGPL_LICENCES.includes(manifest.ffmpegLicense)) {
    problems.push(
      `FFmpeg's configure reported the licence "${manifest.ffmpegLicense}": the core must be LGPL`,
    )
  }
  const forbidden = FORBIDDEN_FLAGS.exec(manifest.configure ?? '')
  if (forbidden) problems.push(`FFmpeg was configured with ${forbidden[0]}`)
  if (!/--disable-gpl\b/.test(manifest.configure ?? '')) {
    problems.push('FFmpeg was configured without --disable-gpl')
  }
  for (const component of manifest.components ?? []) {
    if (!ALLOWED_COMPONENT_LICENCES.has(component.license)) {
      problems.push(`${component.name} is ${component.license}, which the core may not contain`)
    }
  }
  if (manifest.recipeHash !== expectedRecipeHash) {
    problems.push(
      `the core was built from recipe ${manifest.recipeHash}, not the current recipe ${expectedRecipeHash}: build it again`,
    )
  }
  return problems
}

/** The core's entry in the third-party notices: what it contains, its sources and its build. */
export function coreNotice(manifest: CoreManifest, repositoryUrl: string): string {
  const lines = [
    `FXM's ffmpeg core (app/ffmpeg/${CORE_FILES.script}, app/ffmpeg/${CORE_FILES.wasm})`,
    `Licence: LGPL-2.1-or-later (FFmpeg reports: ${manifest.ffmpegLicense})`,
    '',
    'The audio converter of the web app: FFmpeg built to WebAssembly with Emscripten',
    `${manifest.emscripten}, audio only, with no GPL or non-free part. It is a separate file that`,
    'you may replace with your own build of the same or a modified FFmpeg: build one with the',
    `recipe in ${repositoryUrl}/tree/main/tools/ffmpeg-wasm (its README says how) and put its`,
    `three files, ${CORE_FILES.script}, ${CORE_FILES.wasm} and ${CORE_FILES.manifest}, in app/ffmpeg/.`,
    '',
    'It contains:',
  ]
  for (const component of manifest.components) {
    if (component.sha256 === undefined) {
      // FXM's own file, in this repository.
      lines.push('', `${component.name} (${component.license}): ${component.source}`)
      continue
    }
    lines.push(
      '',
      `${component.name} ${component.version} (${component.license}), ${component.homepage}`,
      `  Source: ${component.source}`,
      `  SHA-256: ${component.sha256}`,
    )
  }
  lines.push(
    '',
    `FFmpeg's configure line: ${manifest.configure}`,
    `Patches: ${manifest.patches.length === 0 ? 'none' : manifest.patches.join(', ')}`,
    '',
    'This software uses code of FFmpeg (https://ffmpeg.org/), licensed under the LGPLv2.1, and',
    'LAME (https://lame.sourceforge.io/), licensed under the LGPL. The LGPL is at',
    'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html. Opus is BSD-3-Clause:',
    'https://opus-codec.org/license/.',
  )
  for (const [name, file] of Object.entries(manifest.files)) {
    lines.push(`${name}: ${file.bytes} bytes, SHA-256 ${file.sha256}`)
  }
  return lines.join('\n')
}

function main(args: readonly string[]): number {
  const [command, ...rest] = args
  switch (command) {
    case 'hash':
      console.log(recipeHash())
      return 0
    case 'libs-hash':
      console.log(librariesHash())
      return 0
    case 'dir':
      console.log(coreDistDir())
      return 0
    case 'check': {
      const dir = resolve(rest[0] ?? coreDistDir())
      const problems = coreProblems(dir)
      if (problems.length > 0) {
        console.error(`The ffmpeg core in ${dir} can't ship:`)
        for (const problem of problems) console.error(`  - ${problem}`)
        return 1
      }
      const manifest = readCoreManifest(dir)
      const wasm = manifest.files[CORE_FILES.wasm]
      console.log(
        `ffmpeg core OK: ${CORE_FILES.wasm} is ${wasm?.bytes} bytes (limit ${MAX_CORE_FILE_BYTES}), ${manifest.ffmpegLicense}`,
      )
      return 0
    }
    case 'manifest': {
      const [dir, ...flags] = rest
      const flag = (name: string) => {
        const at = flags.indexOf(`--${name}`)
        const value = at === -1 ? undefined : flags[at + 1]
        if (value === undefined) throw new Error(`manifest needs --${name}`)
        return value
      }
      if (!dir) throw new Error('manifest needs the dist folder')
      writeCoreManifest(resolve(dir), {
        recipeHash: flag('recipe-hash'),
        ffmpegLicense: flag('license'),
        configure: flag('configure'),
        emscripten: flag('emscripten'),
      })
      return 0
    }
    default:
      console.error(
        'usage: core-build.ts hash | libs-hash | dir | check [dist folder] | manifest <dist folder> …',
      )
      return 2
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
