/**
 * FXM's ffmpeg core, as built by recipe/build.sh: where a build lives, what its manifest
 * (ffmpeg-core.json) says, and the checks every build must pass before anything ships it: the
 * WebAssembly file is smaller than 25 MiB (Cloudflare Pages' limit per file), FFmpeg's
 * configure reported an LGPL licence, the licence texts of its parts and the notices of its
 * linked files are there, its source (the pinned tarballs and the recipe) is there, and the
 * files are the ones the manifest names. Also the core's entry in the third-party notices.
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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/**
 * The licence texts every core carries in its `licenses/` folder, which recipe/build.sh fills
 * from the checked sources and emsdk, in the order the notice gives them in full: FFmpeg's and
 * LAME's (the LGPL asks for a copy of itself with the library), Opus's (BSD-3-Clause asks that
 * binaries reproduce its notice), the notices of the linked files under licences of their own
 * (recipe/linked-licences.ts: FFmpeg's MIT and BSD files, such as its Ogg demuxer, and Opus's
 * files, each with its copyright lines), and those of Emscripten's runtime and its C library
 * (musl), which are linked in too.
 */
export const CORE_LICENSE_TEXTS: readonly { readonly file: string; readonly title: string }[] = [
  { file: 'licenses/FFmpeg-LICENSE.md.txt', title: "FFmpeg's LICENSE.md" },
  {
    file: 'licenses/FFmpeg-COPYING.LGPLv2.1.txt',
    title: "FFmpeg's COPYING.LGPLv2.1: the GNU Lesser General Public License, version 2.1",
  },
  { file: 'licenses/LAME-LICENSE.txt', title: "LAME's LICENSE" },
  {
    file: 'licenses/LAME-COPYING.txt',
    title: "LAME's COPYING: the GNU Library General Public License, version 2",
  },
  { file: 'licenses/Opus-COPYING.txt', title: "Opus's COPYING" },
  {
    file: 'licenses/linked-notices.txt',
    title: "The parts' copyright lines, and the notices of the linked files under other licences",
  },
  { file: 'licenses/Emscripten-LICENSE.txt', title: "Emscripten's LICENSE" },
  { file: 'licenses/musl-COPYRIGHT.txt', title: "musl's COPYRIGHT (Emscripten's C library)" },
]

/**
 * The files of a built core that the app serves next to it, at `/app/ffmpeg/`: the three files
 * and the licence texts. ffmpeg-core.json lists them all but itself under `files`.
 */
export const CORE_DIST_FILES: readonly string[] = [
  ...Object.values(CORE_FILES),
  ...CORE_LICENSE_TEXTS.map((text) => text.file),
]

/**
 * The folder of a built core that holds its source: the release tarballs of its parts, exactly
 * as build.sh checked them, and FXM's recipe as one archive (recipe/source-archive.ts).
 * ffmpeg-core.json lists them under `sources`.
 */
export const CORE_SOURCE_DIR = 'source'

/** The recipe's archive in {@link CORE_SOURCE_DIR}. */
export const RECIPE_ARCHIVE = 'fxm-ffmpeg-core-recipe.tar'

/**
 * Where the site serves the core's source, from its root: on the same site as the core, but
 * outside the app, whose service worker would answer a page's request there with the app.
 */
export const CORE_SOURCE_PATH = 'source/ffmpeg-core'

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
  /**
   * Where its source came from: a release tarball, or for FXM's own file its path in this
   * repository (the notice links it at the commit the site was built from).
   */
  readonly source: string
  /** The tarball's SHA-256, checked by build.sh; absent for FXM's own file. */
  readonly sha256?: string
  /** The tarball's name in the core's {@link CORE_SOURCE_DIR}; absent for FXM's own file. */
  readonly archive?: string
  /** Other addresses of the same tarball, which build.sh tries when the first fails. */
  readonly mirrors?: readonly string[]
}

/**
 * ffmpeg-core.json: what a build is, written by build.sh, read by every check. The facts of the
 * build itself; the notice takes each part's name, licence and homepage from the current recipe
 * (`coreComponents()`), which `coreProblems` makes sure is the one the core was built from.
 */
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
  /** The parts it was built from, as the recipe named them then. */
  readonly components: readonly CoreComponent[]
  /** Patches applied to the sources: none today. */
  readonly patches: readonly string[]
  /** The script, the WebAssembly and the licence texts, by path in the core's folder. */
  readonly files: Readonly<Record<string, FileFacts>>
  /** Its source, by file name in its {@link CORE_SOURCE_DIR}: the tarballs and the recipe. */
  readonly sources: Readonly<Record<string, FileFacts>>
}

/** A file's size and SHA-256, as the manifest records them. */
export interface FileFacts {
  readonly bytes: number
  readonly sha256: string
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

/**
 * The parts of the core, for the manifest, from versions.sh. Each tarball keeps the name of its
 * release URL in the core's source folder, as build.sh downloads it.
 */
export function coreComponents(pins: Record<string, string> = readPins()): CoreComponent[] {
  const pin = (name: string) => {
    const value = pins[name]
    if (!value) throw new Error(`recipe/versions.sh has no ${name}`)
    return value
  }
  const tarball = (prefix: string) => {
    const url = pin(`${prefix}_URL`)
    const mirror = pins[`${prefix}_MIRROR`]
    return {
      source: url,
      sha256: pin(`${prefix}_SHA256`),
      archive: url.slice(url.lastIndexOf('/') + 1),
      ...(mirror ? { mirrors: [mirror] } : {}),
    }
  }
  return [
    {
      name: 'FFmpeg',
      version: pin('FFMPEG_VERSION'),
      license: 'LGPL-2.1-or-later',
      homepage: 'https://ffmpeg.org/',
      ...tarball('FFMPEG'),
    },
    {
      name: 'LAME',
      version: pin('LAME_VERSION'),
      license: 'LGPL-2.0-or-later',
      homepage: 'https://lame.sourceforge.io/',
      ...tarball('LAME'),
    },
    {
      name: 'Opus',
      version: pin('OPUS_VERSION'),
      license: 'BSD-3-Clause',
      homepage: 'https://opus-codec.org/',
      ...tarball('OPUS'),
    },
    {
      name: "FXM's converter",
      version: '',
      license: 'Apache-2.0',
      homepage: 'https://github.com/Pratyay-ops/FXM',
      source: 'tools/ffmpeg-wasm/recipe/fxm_convert.c',
    },
  ]
}

/**
 * The names of a core's source files in its {@link CORE_SOURCE_DIR}, from the recipe: each part's
 * tarball, then the recipe's archive.
 */
export function coreSourceFiles(components: readonly CoreComponent[] = coreComponents()): string[] {
  return [
    ...components.flatMap((component) => (component.archive ? [component.archive] : [])),
    RECIPE_ARCHIVE,
  ]
}

/** A file's size and SHA-256. */
function factsOf(file: string): FileFacts {
  const bytes = readFileSync(file)
  return { bytes: bytes.length, sha256: sha256(bytes) }
}

/**
 * Writes ffmpeg-core.json for the files in `dir`: CORE_DIST_FILES but the manifest, and the
 * source files of the recipe (coreSourceFiles) in its source folder.
 */
export function writeCoreManifest(
  dir: string,
  details: { recipeHash: string; ffmpegLicense: string; configure: string; emscripten: string },
): CoreManifest {
  const files: Record<string, FileFacts> = {}
  for (const name of CORE_DIST_FILES.filter((file) => file !== CORE_FILES.manifest)) {
    files[name] = factsOf(join(dir, name))
  }
  const components = coreComponents()
  const sources: Record<string, FileFacts> = {}
  for (const name of coreSourceFiles(components)) {
    sources[name] = factsOf(join(dir, CORE_SOURCE_DIR, name))
  }
  const manifest: CoreManifest = {
    schema: 1,
    ...details,
    components,
    patches: [],
    files,
    sources,
  }
  writeFileSync(join(dir, CORE_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** What a manifest must hold for the checks and the notice: its shape, field by field. */
function manifestShapeProblems(manifest: Partial<Record<keyof CoreManifest, unknown>>): string[] {
  const problems: string[] = []
  for (const key of ['recipeHash', 'ffmpegLicense', 'configure', 'emscripten'] as const) {
    const value = manifest[key]
    if (typeof value !== 'string' || value === '') problems.push(`ffmpeg-core.json has no ${key}`)
  }
  const patches = manifest.patches
  if (!Array.isArray(patches) || !patches.every((patch) => typeof patch === 'string')) {
    problems.push('ffmpeg-core.json has no list of patches (an empty one when there are none)')
  }
  const components = manifest.components
  if (!Array.isArray(components)) {
    problems.push('ffmpeg-core.json lists no components')
  } else {
    const ffmpeg = (components as Partial<CoreComponent>[]).find((part) => part?.name === 'FFmpeg')
    if (
      typeof ffmpeg?.source !== 'string' ||
      !/^https:\/\//.test(ffmpeg.source) ||
      !/^[0-9a-f]{64}$/.test(ffmpeg.sha256 ?? '')
    ) {
      problems.push("ffmpeg-core.json doesn't name FFmpeg's source and its SHA-256")
    }
  }
  if (typeof manifest.files !== 'object' || manifest.files === null) {
    problems.push('ffmpeg-core.json lists no files')
  }
  if (typeof manifest.sources !== 'object' || manifest.sources === null) {
    problems.push(
      'ffmpeg-core.json lists no sources: the core was built before it carried them, so build it again',
    )
  }
  return problems
}

/**
 * Why a built core may not ship (an empty list when it may): its manifest must be complete, its
 * files (the script, the WebAssembly and the licence texts of CORE_LICENSE_TEXTS) and its source
 * (the current recipe's tarballs, with the SHA-256 versions.sh pins, and the recipe's archive)
 * must be there and be the ones the manifest names, each under 25 MiB, built from the current
 * recipe, with an LGPL licence from FFmpeg's configure, no flag that brings in GPL or non-free
 * code, and parts under licences FXM accepts. `sourceDir` is where the source files are: the
 * core's own source folder unless make dist has put them elsewhere. `components` are the
 * current recipe's parts (`coreComponents()`), whose tarballs the source must hold.
 */
export function coreProblems(
  dir: string,
  {
    expectedRecipeHash = recipeHash(),
    sourceDir = join(dir, CORE_SOURCE_DIR),
    components = coreComponents(),
  }: {
    expectedRecipeHash?: string
    sourceDir?: string
    components?: readonly CoreComponent[]
  } = {},
): string[] {
  if (!hasCore(dir)) return [`no ffmpeg core in ${dir}: build it with make ffmpeg-wasm`]
  let manifest: CoreManifest
  try {
    manifest = readCoreManifest(dir)
  } catch (error) {
    return [(error as Error).message]
  }
  const shape = manifestShapeProblems(manifest)
  if (shape.length > 0) return shape
  const problems: string[] = []
  for (const name of CORE_DIST_FILES.filter((file) => file !== CORE_FILES.manifest)) {
    const file = join(dir, name)
    const expected = manifest.files[name]
    if (!existsSync(file)) {
      problems.push(
        name.startsWith('licenses/')
          ? `${name} is missing: the core must carry the licence texts of its parts (recipe/build.sh)`
          : `${name} is missing`,
      )
      continue
    }
    const bytes = readFileSync(file)
    if (!expected || expected.bytes !== bytes.length || expected.sha256 !== sha256(bytes)) {
      problems.push(`${name} is not the file ffmpeg-core.json describes`)
    }
    if (name.startsWith('licenses/') && bytes.length === 0) problems.push(`${name} is empty`)
    if (statSync(file).size >= MAX_CORE_FILE_BYTES) {
      problems.push(
        `${name} is ${bytes.length} bytes: it must stay under 25 MiB (${MAX_CORE_FILE_BYTES} bytes), Cloudflare Pages' limit per file`,
      )
    }
  }
  // The source: every file the recipe names, as the manifest describes it, and the tarballs with
  // the SHA-256 versions.sh pins (the LGPL asks for the very source the core was built from).
  for (const name of coreSourceFiles(components)) {
    const file = join(sourceDir, name)
    if (!existsSync(file)) {
      problems.push(
        `${CORE_SOURCE_DIR}/${name} is missing: the core must carry its source (recipe/build.sh)`,
      )
      continue
    }
    const facts = factsOf(file)
    const expected = manifest.sources[name]
    if (expected?.bytes !== facts.bytes || expected.sha256 !== facts.sha256) {
      problems.push(`${CORE_SOURCE_DIR}/${name} is not the file ffmpeg-core.json describes`)
    }
    const pinned = components.find((component) => component.archive === name)?.sha256
    if (pinned !== undefined && facts.sha256 !== pinned) {
      problems.push(`${CORE_SOURCE_DIR}/${name} is not the tarball recipe/versions.sh pins`)
    }
    if (facts.bytes >= MAX_CORE_FILE_BYTES) {
      problems.push(
        `${CORE_SOURCE_DIR}/${name} is ${facts.bytes} bytes: it must stay under 25 MiB (${MAX_CORE_FILE_BYTES} bytes), Cloudflare Pages' limit per file`,
      )
    }
  }
  if (!LGPL_LICENCES.includes(manifest.ffmpegLicense)) {
    problems.push(
      `FFmpeg's configure reported the licence "${manifest.ffmpegLicense}": the core must be LGPL`,
    )
  }
  const forbidden = FORBIDDEN_FLAGS.exec(manifest.configure)
  if (forbidden) problems.push(`FFmpeg was configured with ${forbidden[0]}`)
  if (!/--disable-gpl\b/.test(manifest.configure)) {
    problems.push('FFmpeg was configured without --disable-gpl')
  }
  for (const component of manifest.components) {
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

/** A full commit hash, as git prints it. */
const COMMIT = /^[0-9a-f]{40}$/

/**
 * The commit this checkout is at: GITHUB_SHA in CI, else what git says, or `undefined` outside a
 * git checkout. The notice links the recipe at this commit, so the link always shows the recipe
 * that built the core (`coreProblems` checks the recipe's hash), not whatever main holds later.
 */
export function currentCommit(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = TOOL_DIR,
): string | undefined {
  if (env.GITHUB_SHA !== undefined && COMMIT.test(env.GITHUB_SHA)) return env.GITHUB_SHA
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return COMMIT.test(head) ? head : undefined
  } catch {
    return undefined
  }
}

/** `text` wrapped at 78 columns, for the notices file. */
function wrap(text: string, width = 78): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

/** What {@link coreNotice} needs besides the core. */
export interface CoreNoticeOptions {
  /** The repository's address, e.g. `https://github.com/Pratyay-ops/FXM`. */
  readonly repositoryUrl: string
  /** The commit the site is built from ({@link currentCommit}). */
  readonly commit: string
  /** The core's parts: by default the current recipe's (`coreComponents()`). */
  readonly components?: readonly CoreComponent[]
}

/**
 * The core's entry in the third-party notices: what it contains, with each part's licence, its
 * source on the same site (and where its project publishes it) and SHA-256, the build
 * (Emscripten, FFmpeg's configure line, the patches), how to replace it with the recipe at the
 * site's own commit, and the licence texts in full, with the notices of its linked files.
 *
 * The parts' names, licences and homepages come from the current recipe, the build's facts and
 * the licence texts from the core in `dir`, so a fix to this text reaches a deploy whose core
 * came from CI's cache. Call it on a core `coreProblems` passed.
 */
export function coreNotice(dir: string, options: CoreNoticeOptions): string {
  const manifest = readCoreManifest(dir)
  const components = options.components ?? coreComponents()
  const at = (kind: 'tree' | 'blob', path: string) =>
    `${options.repositoryUrl}/${kind}/${options.commit}/${path}`
  const here = (name: string) => `/${CORE_SOURCE_PATH}/${name}`
  const recipe = manifest.sources[RECIPE_ARCHIVE]
  const lines = [
    `FXM's ffmpeg core (app/ffmpeg/${CORE_FILES.script}, app/ffmpeg/${CORE_FILES.wasm})`,
    `Licence: LGPL-2.1-or-later (FFmpeg reports: ${manifest.ffmpegLicense})`,
    '',
    ...wrap(
      `The audio converter of the web app: FFmpeg built to WebAssembly with Emscripten ${manifest.emscripten}, audio only, with no GPL or non-free part. It is a separate file that you may replace with your own build of the same or a modified FFmpeg: build one with the recipe this site was built with, ${at('tree', 'tools/ffmpeg-wasm')} (its README says how), and put what it builds, ${CORE_FILES.script}, ${CORE_FILES.wasm}, ${CORE_FILES.manifest} and the licenses folder, in app/ffmpeg/.`,
    ),
    '',
    ...wrap(
      `Its source is next to it, on the site that serves this file: in /${CORE_SOURCE_PATH}/ are the release tarballs of FFmpeg, LAME and Opus exactly as the core was built from them, and FXM's recipe, which builds the core from them (${RECIPE_ARCHIVE}: tools/ffmpeg-wasm and the scripts it runs). On FXM's own site that is https://fxmusic.pages.dev/${CORE_SOURCE_PATH}/, in a release's web zip (fxm-web-<version>.zip) the folder ${CORE_SOURCE_PATH}/, and every GitHub Release of FXM attaches the same files as fxm-ffmpeg-core-source-<version>.zip. The parts' projects publish their tarballs too, at the addresses below; the SHA-256 tells the right file.`,
    ),
    '',
    'It contains:',
  ]
  for (const component of components) {
    if (component.sha256 === undefined) {
      // FXM's own file, at the commit the site was built from.
      lines.push('', `${component.name} (${component.license}): ${at('blob', component.source)}`)
      continue
    }
    const also = [component.source, ...(component.mirrors ?? [])]
    lines.push(
      '',
      `${component.name} ${component.version} (${component.license}), ${component.homepage}`,
      ...(component.archive ? [`  Source: ${here(component.archive)}`] : []),
      ...also.map((url, index) => `  ${index === 0 ? 'Also at:' : '        '} ${url}`),
      `  SHA-256: ${component.sha256}`,
    )
  }
  if (recipe !== undefined) {
    lines.push(
      '',
      `FXM's recipe (Apache-2.0): ${here(RECIPE_ARCHIVE)}`,
      `  Also at: ${at('tree', 'tools/ffmpeg-wasm')}`,
      `  SHA-256: ${recipe.sha256}`,
    )
  }
  lines.push(
    '',
    ...wrap(
      `Emscripten ${manifest.emscripten}'s runtime, linked in: its JavaScript glue and its C library, built from musl (MIT; Emscripten also offers the University of Illinois/NCSA Open Source License). Also linked in, and needing no notice: compiler-rt's builtins (Apache-2.0 WITH LLVM-exception) and dlmalloc (public domain).`,
    ),
    '',
    `FFmpeg's configure line: ${manifest.configure}`,
    `Patches: ${manifest.patches.length === 0 ? 'none' : manifest.patches.join(', ')}`,
  )
  for (const name of [CORE_FILES.script, CORE_FILES.wasm]) {
    const file = manifest.files[name]
    if (file) lines.push(`${name}: ${file.bytes} bytes, SHA-256 ${file.sha256}`)
  }
  lines.push(
    '',
    ...wrap(
      `This software uses code of FFmpeg (https://ffmpeg.org/) licensed under the LGPLv2.1, of LAME (https://lame.sourceforge.io/) licensed under the LGPL, and of Opus (https://opus-codec.org/) licensed under the BSD-3-Clause licence; their sources are on this site, in /${CORE_SOURCE_PATH}/. Their licences follow in full, then the parts' copyright lines and the notices of the files linked into the core that are under licences of their own (FFmpeg's MIT and BSD files, Opus's BSD files), and the licences of Emscripten and musl.`,
    ),
  )
  for (const text of CORE_LICENSE_TEXTS) {
    lines.push('', `--- ${text.title}`, '', readFileSync(join(dir, text.file), 'utf8').trimEnd())
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
      const source = Object.values(manifest.sources).reduce((sum, file) => sum + file.bytes, 0)
      console.log(
        `ffmpeg core OK: ${CORE_FILES.wasm} is ${wasm?.bytes} bytes (limit ${MAX_CORE_FILE_BYTES}), ${manifest.ffmpegLicense}; its source in ${CORE_SOURCE_DIR}/ is ${Object.keys(manifest.sources).length} files, ${source} bytes`,
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

/**
 * Whether this file runs as a script (`node <file> …`) rather than as an import. Both paths are
 * resolved to their real paths, so it also runs from a folder behind a symbolic link, such as
 * macOS's /tmp.
 */
function runAsScript(): boolean {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (runAsScript()) {
  process.exitCode = main(process.argv.slice(2))
}
