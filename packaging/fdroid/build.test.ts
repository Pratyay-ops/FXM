import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../version.ts'

/** The repository files build.sh runs, copied into a scratch repository. */
const COPIED = [
  'packaging/fdroid/build.sh',
  'scripts/env.sh',
  'scripts/lib.sh',
  'scripts/run.sh',
  'scripts/install-pnpm.sh',
  'package.json',
  '.nvmrc',
]

const NOTICES = 'apps/mobile/android/app/src/main/assets/public/third-party-notices.txt'
const REPORT = 'apps/mobile/android/app/build/fxm/android-libraries.json'

/**
 * A stand-in for pnpm that records each call with the distribution flags it saw, and makes the
 * files the real install, builds and `cap sync` would.
 */
const FAKE_PNPM = `#!/usr/bin/env bash
if [ "\${1:-}" = --version ]; then echo 12.12.1; exit 0; fi
printf '%s|FXM_DISTRIBUTION=%s|VITE_FXM_DISTRIBUTION=%s\\n' "$*" "\${FXM_DISTRIBUTION:-}" "\${VITE_FXM_DISTRIBUTION:-}" >>pnpm.log
case "$*" in
  *"@fxm/deploy dist"*) mkdir -p dist/pages && echo 'FXM third-party notices' >dist/pages/third-party-notices.txt ;;
  *build:mobile*) mkdir -p apps/web/dist-mobile && echo '<!doctype html>' >apps/web/dist-mobile/index.html ;;
  *"cap sync android"*)
    mkdir -p apps/mobile/android/app/src/main/assets/public
    cp apps/web/dist-mobile/index.html apps/mobile/android/app/src/main/assets/public/ ;;
esac
`

/** A stand-in for Gradle (the wrapper, or F-Droid's gradlew-fdroid) that writes the report. */
const fakeGradle = (name: string) => `#!/usr/bin/env bash
printf '%s %s|ANDROID_HOME=%s\\n' "${name}" "$*" "\${ANDROID_HOME:-}" >>../../../gradle.log
mkdir -p app/build/fxm && echo '{"libraries":[]}' >app/build/fxm/android-libraries.json
`

/** A stand-in for stage 6.6's notices writer: joins its first two inputs into its output. */
const FAKE_WRITER = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const [report, web, out] = process.argv.slice(2)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, \`FXM for Android: third-party notices\\n\${readFileSync(report, 'utf8')}\${readFileSync(web, 'utf8')}\`)
writeFileSync('writer.log', JSON.stringify([report, web, out]))
`

let scratch: string | undefined

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

/** Options for {@link scratchRepository}. */
interface ScratchOptions {
  /** Whether the checkout has stage 6.6's notices writer. */
  readonly writer?: boolean
  /** Where Gradle comes from: the wrapper with its JAR, or gradlew-fdroid on the PATH. */
  readonly gradle?: 'wrapper' | 'fdroid'
}

/** A scratch repository with the build script, its helpers and the fakes. */
function scratchRepository({ writer = false, gradle = 'wrapper' }: ScratchOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'fxm-fdroid-build-'))
  scratch = root
  for (const file of COPIED) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(join(REPO_ROOT, file), join(root, file))
  }
  chmodSync(join(root, 'packaging/fdroid/build.sh'), 0o755)
  for (const script of ['run.sh', 'install-pnpm.sh'])
    chmodSync(join(root, 'scripts', script), 0o755)
  mkdirSync(join(root, '.tools/bin'), { recursive: true })
  writeFileSync(join(root, '.tools/bin/pnpm'), FAKE_PNPM, { mode: 0o755 })
  const android = join(root, 'apps/mobile/android')
  mkdirSync(join(android, 'gradle/wrapper'), { recursive: true })
  if (gradle === 'wrapper') {
    writeFileSync(join(android, 'gradle/wrapper/gradle-wrapper.jar'), 'jar')
    writeFileSync(join(android, 'gradlew'), fakeGradle('gradlew'), { mode: 0o755 })
  } else {
    mkdirSync(join(root, 'fdroid-bin'), { recursive: true })
    writeFileSync(join(root, 'fdroid-bin/gradlew-fdroid'), fakeGradle('gradlew-fdroid'), {
      mode: 0o755,
    })
  }
  if (writer) {
    mkdirSync(join(root, 'apps/mobile/scripts'), { recursive: true })
    writeFileSync(join(root, 'apps/mobile/scripts/write-notices.ts'), FAKE_WRITER)
  }
  spawnSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

/** The environment without the toolchain variables of the checkout the tests run in. */
function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(FXM_|PNPM_|pnpm_config_|npm_config_|VITE_FXM_|ANDROID_|GRADLE_)/.test(name)) {
      env[name] = value
    }
  }
  return { ...env, ...extra }
}

/** Runs the build script in a scratch repository. */
function build(root: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['packaging/fdroid/build.sh'], {
    cwd: root,
    env: cleanEnvironment(env),
    encoding: 'utf8',
  })
}

const lines = (root: string, file: string) =>
  readFileSync(join(root, file), 'utf8').trim().split('\n')

describe('the F-Droid build script', () => {
  it('builds the web app as an F-Droid build, syncs it and writes the APK’s notices', () => {
    const root = scratchRepository({ writer: true })
    const result = build(root)
    expect(result.status, result.stderr).toBe(0)
    expect(lines(root, 'pnpm.log')).toEqual([
      'install --frozen-lockfile --filter @fxm/mobile... --filter @fxm/web... --filter @fxm/deploy... --filter @fxm/site...|FXM_DISTRIBUTION=|VITE_FXM_DISTRIBUTION=',
      '--silent --filter @fxm/deploy dist|FXM_DISTRIBUTION=|VITE_FXM_DISTRIBUTION=',
      '--filter @fxm/web build:mobile|FXM_DISTRIBUTION=fdroid|VITE_FXM_DISTRIBUTION=fdroid',
      '--filter @fxm/mobile cap sync android|FXM_DISTRIBUTION=|VITE_FXM_DISTRIBUTION=',
    ])
    expect(lines(root, 'gradle.log')[0]).toMatch(/^gradlew --no-daemon fxmLibraryReport\|/)
    // The writer gets the library report, make dist's notices and the APK's file, as stage
    // 6.6's release-apk.sh passes them.
    expect(JSON.parse(readFileSync(join(root, 'writer.log'), 'utf8'))).toEqual([
      REPORT,
      'dist/pages/third-party-notices.txt',
      NOTICES,
    ])
    expect(readFileSync(join(root, NOTICES), 'utf8')).toMatch(
      /^FXM for Android: third-party notices\n\{"libraries":\[\]\}\nFXM third-party notices/,
    )
    expect(result.stdout).toMatch(/Gradle's assembleRelease is next/)
  })

  it('uses F-Droid’s Gradle and Android SDK where the checkout has neither', () => {
    const root = scratchRepository({ writer: true, gradle: 'fdroid' })
    const result = build(root, {
      PATH: `${join(root, 'fdroid-bin')}:${process.env.PATH}`,
      ANDROID_HOME: '/opt/android-sdk',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(lines(root, 'gradle.log')).toEqual([
      'gradlew-fdroid --no-daemon fxmLibraryReport|ANDROID_HOME=/opt/android-sdk',
    ])
  })

  it('warns and writes no notices in a checkout from before stage 6.6', () => {
    const root = scratchRepository()
    const result = build(root)
    expect(result.status, result.stderr).toBe(0)
    const calls = lines(root, 'pnpm.log')
    expect(calls[0]).toBe(
      'install --frozen-lockfile --filter @fxm/mobile... --filter @fxm/web...|FXM_DISTRIBUTION=|VITE_FXM_DISTRIBUTION=',
    )
    expect(calls.join('\n')).not.toMatch(/@fxm\/deploy dist/)
    expect(existsSync(join(root, 'gradle.log'))).toBe(false)
    expect(existsSync(join(root, NOTICES))).toBe(false)
    expect(result.stderr).toMatch(/predates stage 6\.6.*F-Droid must not build it/s)
    expect(
      existsSync(join(root, 'apps/mobile/android/app/src/main/assets/public/index.html')),
    ).toBe(true)
  })

  it('stops when the web app’s build writes nothing', () => {
    const root = scratchRepository()
    writeFileSync(
      join(root, '.tools/bin/pnpm'),
      FAKE_PNPM.replace(/\*build:mobile\*\) [^;]+;;/, '*build:mobile*) ;;'),
      { mode: 0o755 },
    )
    const result = build(root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/wrote no index\.html/)
    expect(readFileSync(join(root, 'pnpm.log'), 'utf8')).not.toMatch(/cap sync/)
  })

  it('pins Node.js 22 for Linux by checksum, and never uses an unpinned download', () => {
    const script = readFileSync(join(REPO_ROOT, 'packaging/fdroid/build.sh'), 'utf8')
    expect(script).toMatch(/^NODE_VERSION=22\.\d+\.\d+$/m)
    expect(script).toMatch(/^NODE_SHA256_LINUX_X64=[\da-f]{64}$/m)
    expect(script).toMatch(/^NODE_SHA256_LINUX_ARM64=[\da-f]{64}$/m)
    expect(script).toContain('fxm_download "https://nodejs.org/dist/v$NODE_VERSION/')
    expect(script).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/)
    // pnpm comes from the pinned installer, and the lockfile is never re-resolved.
    expect(script).toContain('scripts/install-pnpm.sh')
    expect(script).toContain('pnpm install --frozen-lockfile')
  })

  it('writes the notices where stage 6.6’s release build does, once it has merged', () => {
    const release = join(REPO_ROOT, 'apps/mobile/scripts/release-apk.sh')
    if (!existsSync(release)) return
    const script = readFileSync(release, 'utf8')
    // release-apk.sh runs from apps/mobile; build.sh from the repository's root.
    expect(script).toContain(`report=${REPORT.replace('apps/mobile/', '')}`)
    expect(script).toContain(`notices=${NOTICES.replace('apps/mobile/', '')}`)
    expect(script).toMatch(
      /scripts\/write-notices\.ts \\\s*"\$report" \.\.\/\.\.\/dist\/pages\/third-party-notices\.txt "\$notices"/,
    )
    expect(script).toContain('fxmLibraryReport')
  })
})
