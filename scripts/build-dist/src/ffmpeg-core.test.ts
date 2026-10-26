import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORE_FILES,
  CORE_LICENSE_TEXTS,
  coreComponents,
  coreNotice,
  coreProblems,
  currentCommit,
  librariesHash,
  MAX_CORE_FILE_BYTES,
  RECIPE_DIR,
  readCoreManifest,
  readPins,
  recipeHash,
} from '../../../tools/ffmpeg-wasm/core-build.ts'
import { compose, DistError, NOTICES_FILE } from './compose.ts'
import { CORE_FOLDER, createFfmpegCorePart } from './ffmpeg-core.ts'
import { parseHeaders } from './headers-file.ts'
import { fakeAppPart, fakeSitePart, removeTempDirs, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

const REPOSITORY = 'https://github.com/Pratyay-ops/FXM'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

/** A stand-in for each licence text, which build.sh copies from the real sources. */
const licenseText = (file: string) => `The licence text of ${file}.\n`

/** A built core in a folder: its files, the licence texts and the manifest build.sh writes. */
function fakeCore(overrides: Record<string, unknown> = {}): string {
  const dir = tempDir()
  const script = 'export default async function createFfmpegCore() {}\n'
  const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
  writeFileSync(join(dir, CORE_FILES.script), script)
  writeFileSync(join(dir, CORE_FILES.wasm), wasm)
  const files: Record<string, { bytes: number; sha256: string }> = {
    [CORE_FILES.script]: { bytes: script.length, sha256: sha(script) },
    [CORE_FILES.wasm]: { bytes: wasm.length, sha256: sha(wasm) },
  }
  for (const { file } of CORE_LICENSE_TEXTS) {
    writeFiles(dir, { [file]: licenseText(file) })
    files[file] = { bytes: licenseText(file).length, sha256: sha(licenseText(file)) }
  }
  const manifest = {
    schema: 1,
    recipeHash: recipeHash(),
    ffmpegLicense: 'LGPL version 2.1 or later',
    configure: '--prefix=/usr --disable-gpl --disable-nonfree --enable-libmp3lame --enable-libopus',
    emscripten: '6.0.12',
    components: coreComponents(),
    patches: [],
    files,
    ...overrides,
  }
  writeFileSync(join(dir, CORE_FILES.manifest), JSON.stringify(manifest))
  return dir
}

/** The manifest of `dir` without `keys`, as an older or broken build might have written it. */
function withoutKeys(dir: string, ...keys: string[]): string {
  const manifest = JSON.parse(readFileSync(join(dir, CORE_FILES.manifest), 'utf8'))
  for (const key of keys) delete manifest[key]
  writeFileSync(join(dir, CORE_FILES.manifest), JSON.stringify(manifest))
  return dir
}

describe('the recipe', () => {
  it('pins every download by version and SHA-256', () => {
    const pins = readPins()
    for (const name of ['FFMPEG', 'LAME', 'OPUS', 'EMSDK']) {
      expect(pins[`${name}_VERSION`], name).toMatch(/^\d+(\.\d+)+$/)
      expect(pins[`${name}_SHA256`], name).toMatch(/^[0-9a-f]{64}$/)
      expect(pins[`${name}_URL`], name).toMatch(/^https:\/\//)
    }
    expect(pins.FFMPEG_URL).toBe(`https://ffmpeg.org/releases/ffmpeg-${pins.FFMPEG_VERSION}.tar.xz`)
    expect(pins.EMSCRIPTEN_SHA256_linux_x64).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names each part of the core with a licence the core may contain, never GPL', () => {
    const components = coreComponents()
    expect(components.map((part) => [part.name, part.license])).toEqual([
      ['FFmpeg', 'LGPL-2.1-or-later'],
      ['LAME', 'LGPL-2.0-or-later'],
      ['Opus', 'BSD-3-Clause'],
      ["FXM's converter", 'Apache-2.0'],
    ])
  })

  it('copies every licence text the checks and the notice need (build.sh)', () => {
    const buildScript = readFileSync(join(RECIPE_DIR, 'build.sh'), 'utf8')
    for (const { file } of CORE_LICENSE_TEXTS) {
      expect(file).toMatch(/^licenses\/[A-Za-z0-9.-]+\.txt$/)
      expect(buildScript, file).toContain(file.slice('licenses/'.length))
    }
  })

  it('has hashes that change with the recipe, the libraries’ only with their own files', () => {
    const dir = tempDir()
    writeFiles(dir, {
      'versions.sh': 'FFMPEG_VERSION=1\n',
      'libs.sh': 'echo libs\n',
      'pkg-config.sh': 'echo 0\n',
      'fxm_convert.c': 'int main;\n',
    })
    const before = { recipe: recipeHash(dir), libraries: librariesHash(dir) }
    writeFileSync(join(dir, 'fxm_convert.c'), 'int main(void);\n')
    expect(recipeHash(dir)).not.toBe(before.recipe)
    expect(librariesHash(dir)).toBe(before.libraries)
    writeFileSync(join(dir, 'versions.sh'), 'FFMPEG_VERSION=2\n')
    expect(librariesHash(dir)).not.toBe(before.libraries)
  })
})

describe('coreProblems', () => {
  it('passes a complete LGPL core built from the current recipe', () => {
    expect(coreProblems(fakeCore())).toEqual([])
  })

  it('refuses a missing core, files the manifest doesn’t describe, and a stale build', () => {
    expect(coreProblems(tempDir())[0]).toMatch(/no ffmpeg core/)
    const changed = fakeCore()
    writeFileSync(join(changed, CORE_FILES.wasm), new Uint8Array([1, 2, 3]))
    expect(coreProblems(changed)).toEqual([
      'ffmpeg-core.wasm is not the file ffmpeg-core.json describes',
    ])
    expect(coreProblems(fakeCore({ recipeHash: 'f'.repeat(64) }))[0]).toMatch(
      /not the current recipe/,
    )
  })

  it('refuses a core that isn’t LGPL, or was configured to take GPL or non-free code', () => {
    expect(coreProblems(fakeCore({ ffmpegLicense: 'GPL version 2 or later' }))).toEqual([
      'FFmpeg\'s configure reported the licence "GPL version 2 or later": the core must be LGPL',
    ])
    expect(coreProblems(fakeCore({ configure: '--enable-gpl --enable-libx264' }))).toEqual([
      'FFmpeg was configured with --enable-gpl',
      'FFmpeg was configured without --disable-gpl',
    ])
    expect(
      coreProblems(
        fakeCore({
          components: [...coreComponents(), { name: 'x264', license: 'GPL-2.0-or-later' }],
        }),
      ),
    ).toEqual(['x264 is GPL-2.0-or-later, which the core may not contain'])
  })

  it('refuses a core without the licence texts of its parts', () => {
    const dir = fakeCore()
    rmSync(join(dir, 'licenses/Opus-COPYING.txt'))
    expect(coreProblems(dir)).toEqual([
      'licenses/Opus-COPYING.txt is missing: the core must carry the licence texts of its parts (recipe/build.sh)',
    ])
    const changed = fakeCore()
    writeFileSync(join(changed, 'licenses/LAME-COPYING.txt'), 'something else')
    expect(coreProblems(changed)).toEqual([
      'licenses/LAME-COPYING.txt is not the file ffmpeg-core.json describes',
    ])
  })

  it('refuses a manifest that lacks what the checks and the notice need', () => {
    expect(coreProblems(withoutKeys(fakeCore(), 'components', 'patches'))).toEqual([
      'ffmpeg-core.json has no list of patches (an empty one when there are none)',
      'ffmpeg-core.json lists no components',
    ])
    expect(coreProblems(withoutKeys(fakeCore(), 'configure', 'emscripten'))).toEqual([
      'ffmpeg-core.json has no configure',
      'ffmpeg-core.json has no emscripten',
    ])
    const ffmpegless = coreComponents().filter((part) => part.name !== 'FFmpeg')
    expect(coreProblems(fakeCore({ components: ffmpegless }))).toEqual([
      "ffmpeg-core.json doesn't name FFmpeg's source and its SHA-256",
    ])
    expect(coreProblems(withoutKeys(fakeCore(), 'files'))).toEqual([
      'ffmpeg-core.json lists no files',
    ])
  })

  it('refuses a WebAssembly file of 25 MiB or more', () => {
    const dir = fakeCore()
    const wasm = join(dir, CORE_FILES.wasm)
    truncateSync(wasm, MAX_CORE_FILE_BYTES)
    const bytes = readFileSync(wasm)
    const manifest = readCoreManifest(dir)
    writeFileSync(
      join(dir, CORE_FILES.manifest),
      JSON.stringify({
        ...manifest,
        files: {
          ...manifest.files,
          [CORE_FILES.wasm]: { bytes: bytes.length, sha256: sha(bytes) },
        },
      }),
    )
    expect(coreProblems(dir)).toEqual([
      `ffmpeg-core.wasm is ${MAX_CORE_FILE_BYTES} bytes: it must stay under 25 MiB (${MAX_CORE_FILE_BYTES} bytes), Cloudflare Pages' limit per file`,
    ])
  })
})

describe('coreNotice', () => {
  const options = { repositoryUrl: REPOSITORY, commit: COMMIT }

  it('names the parts, their sources and hashes, the configure line and how to replace it', () => {
    const notice = coreNotice(fakeCore(), options)
    expect(notice).toContain('Licence: LGPL-2.1-or-later')
    expect(notice).toContain('FFmpeg 9.0.2 (LGPL-2.1-or-later), https://ffmpeg.org/')
    expect(notice).toContain(`SHA-256: ${readPins().FFMPEG_SHA256}`)
    expect(notice).toContain('LAME 4.0 (LGPL-2.0-or-later), https://lame.sourceforge.io/')
    expect(notice).toContain('Opus 1.6.1 (BSD-3-Clause), https://opus-codec.org/')
    expect(notice).toContain("FFmpeg's configure line: --prefix=/usr --disable-gpl")
    expect(notice).toContain('Patches: none')
    expect(notice.replace(/\s+/g, ' ')).toContain('you may replace with your own build')
    expect(notice).toContain('compiler-rt')
  })

  it('links the recipe and the converter at the commit the site is built from, never main', () => {
    const notice = coreNotice(fakeCore(), options)
    expect(notice).toContain(`${REPOSITORY}/tree/${COMMIT}/tools/ffmpeg-wasm`)
    expect(notice).toContain(
      `FXM's converter (Apache-2.0): ${REPOSITORY}/blob/${COMMIT}/tools/ffmpeg-wasm/recipe/fxm_convert.c`,
    )
    expect(notice).not.toContain('/tree/main/')
  })

  it('carries the licence text of every part in full', () => {
    const notice = coreNotice(fakeCore(), options)
    for (const { file, title } of CORE_LICENSE_TEXTS) {
      expect(notice).toContain(`--- ${title}\n\n${licenseText(file).trimEnd()}`)
    }
    expect(notice).toContain("--- Opus's COPYING")
    expect(notice).toContain('GNU Lesser General Public License, version 2.1')
  })

  it('takes the parts from the current recipe, so a fix reaches a core from the cache', () => {
    const dir = fakeCore()
    const renamed = coreComponents().map((part) =>
      part.name === 'LAME' ? { ...part, homepage: 'https://lame.example/' } : part,
    )
    const before = coreNotice(dir, options)
    const after = coreNotice(dir, { ...options, components: renamed })
    expect(after).not.toBe(before)
    expect(after).toContain('LAME 4.0 (LGPL-2.0-or-later), https://lame.example/')
    // The manifest, built earlier, still has the old one.
    expect(readCoreManifest(dir).components.find((part) => part.name === 'LAME')?.homepage).toBe(
      'https://lame.sourceforge.io/',
    )
  })
})

describe('currentCommit', () => {
  it('takes GITHUB_SHA in CI, else asks git, and never makes one up', () => {
    expect(currentCommit({ GITHUB_SHA: COMMIT })).toBe(COMMIT)
    expect(currentCommit({}, RECIPE_DIR)).toMatch(/^[0-9a-f]{40}$/)
    expect(currentCommit({ GITHUB_SHA: 'main' }, tempDir())).toBeUndefined()
  })
})

describe('the ffmpeg core in make dist', () => {
  function run(root: string, parts: Parameters<typeof compose>[0]['parts']) {
    const logs: string[] = []
    const outDir = join(root, 'dist/pages')
    compose({
      root,
      parts,
      stagingDir: join(root, 'dist/.staging'),
      outDir,
      run: () => {
        throw new Error('no commands')
      },
      log: (message) => logs.push(message),
      repositoryUrl: REPOSITORY,
    })
    return { outDir, logs }
  }

  /** Composes with `core`, expecting make dist to refuse it: the problems it names. */
  function refused(core: ReturnType<typeof createFfmpegCorePart>): readonly string[] {
    const root = tempDir()
    try {
      run(root, [fakeSitePart(root), fakeAppPart(root), core])
    } catch (error) {
      expect(error).toBeInstanceOf(DistError)
      return (error as DistError).problems
    }
    throw new Error('expected a DistError')
  }

  it('ships the core at /app/ffmpeg/ under the app’s policy, with its notice', () => {
    const root = tempDir()
    const core = createFfmpegCorePart({ dir: fakeCore(), required: true, commit: COMMIT })
    const { outDir } = run(root, [fakeSitePart(root), fakeAppPart(root), core])
    for (const name of [
      ...Object.values(CORE_FILES),
      ...CORE_LICENSE_TEXTS.map((text) => text.file),
    ]) {
      expect(existsSync(join(outDir, 'app', CORE_FOLDER, name)), name).toBe(true)
    }
    const notices = readFileSync(join(outDir, NOTICES_FILE), 'utf8')
    expect(notices).toContain(
      "FXM's ffmpeg core (app/ffmpeg/ffmpeg-core.js, app/ffmpeg/ffmpeg-core.wasm)",
    )
    expect(notices).toContain(licenseText('licenses/FFmpeg-COPYING.LGPLv2.1.txt').trimEnd())
    expect(notices).toContain(`${REPOSITORY}/tree/${COMMIT}/tools/ffmpeg-wasm`)
    const { rules } = parseHeaders(readFileSync(join(outDir, '_headers'), 'utf8'))
    const app = rules.find((rule) => rule.path === '/app/*')
    expect(app?.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'")
  })

  it('leaves the core out where none is built, unless it is required', () => {
    const root = tempDir()
    const missing = tempDir()
    const { outDir, logs } = run(root, [
      fakeSitePart(root),
      fakeAppPart(root),
      createFfmpegCorePart({ dir: missing, required: false }),
    ])
    expect(existsSync(join(outDir, 'app', CORE_FOLDER))).toBe(false)
    expect(logs.join('\n')).toMatch(/no core in .*make ffmpeg-wasm builds one/)
    const again = tempDir()
    expect(() =>
      run(again, [
        fakeSitePart(again),
        fakeAppPart(again),
        createFfmpegCorePart({ dir: missing, required: true }),
      ]),
    ).toThrow(/ffmpeg-core is required but was not built/)
  })

  it('refuses a core that fails its checks', () => {
    const bad = createFfmpegCorePart({
      dir: fakeCore({ ffmpegLicense: 'GPL version 3 or later' }),
      required: true,
      commit: COMMIT,
    })
    expect(refused(bad)).toEqual([
      'ffmpeg-core: FFmpeg\'s configure reported the licence "GPL version 3 or later": the core must be LGPL',
    ])
  })

  it('never ships the core without its notice', () => {
    // A manifest of the right schema that lacks what the notice needs.
    expect(
      refused(
        createFfmpegCorePart({
          dir: withoutKeys(fakeCore(), 'components', 'patches'),
          required: true,
          commit: COMMIT,
        }),
      ),
    ).toEqual([
      'ffmpeg-core: ffmpeg-core.json has no list of patches (an empty one when there are none)',
      'ffmpeg-core: ffmpeg-core.json lists no components',
    ])
    // A notice that can't link the recipe at the site's commit.
    expect(
      refused(createFfmpegCorePart({ dir: fakeCore(), required: true, commit: () => undefined })),
    ).toEqual([
      "ffmpeg-core: can't tell which commit this dist is built from (no GITHUB_SHA, no git): the core's notice links its recipe at that commit",
    ])
  })
})
