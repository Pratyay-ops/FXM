import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Reporter } from './actions.ts'
import { downloadUrl, type Manifest } from './manifest.ts'
import { decodePublicKey, generateKeyPair, keyIdHex, verify } from './minisign.ts'
import {
  checkRelease,
  collectTarget,
  gatherArtifacts,
  isReleaseVersion,
  main,
  parseMode,
  readAppVersion,
  readUpdaterPubkey,
  signRelease,
  writeBuildKey,
} from './release.ts'
import { TARGETS, targetById } from './targets.ts'
import { temporaryFolder } from './testing.ts'

const PLACEHOLDER = 'PLACEHOLDER: this build has no updater key yet.'
const SLOW = 60_000

function recorder() {
  const lines: string[] = []
  const reporter: Reporter = {
    info: (m) => lines.push(`info ${m}`),
    notice: (t, m) => lines.push(`notice ${t}: ${m}`),
    error: (t, m) => lines.push(`error ${t}: ${m}`),
    output: (n, v) => lines.push(`output ${n}=${v}`),
    summary: (m) => lines.push(`summary ${m}`),
  }
  return { lines, reporter }
}

let folder: string
beforeEach(() => {
  folder = temporaryFolder('desktop-release')
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

/** Each target's files, as the build jobs upload them: `<artifacts>/desktop-<target>/<name>`. */
function writeArtifacts(version: string) {
  const artifacts = join(folder, 'artifacts')
  for (const target of TARGETS) {
    const dir = join(artifacts, `desktop-${target.id}`)
    mkdirSync(dir, { recursive: true })
    for (const file of target.files(version))
      writeFileSync(join(dir, file.name), `${file.name} bytes`)
  }
  return artifacts
}

describe('release versions', () => {
  it('are x.y.z with numbers up to 65535, as scripts/release-lib.sh says', () => {
    for (const version of ['0.0.0', '0.7.0', '65535.65535.65535']) {
      expect(isReleaseVersion(version), version).toBe(true)
    }
    for (const version of ['0.7', 'v0.7.0', '0.7.0-beta', '65536.0.0', '01.0.0', '']) {
      expect(isReleaseVersion(version), version).toBe(false)
    }
  })

  it('come from apps/desktop/package.json, which the release sets with every other package', () => {
    expect(isReleaseVersion(readAppVersion())).toBe(true)
  })
})

describe('check', () => {
  it('lets a dry run build with the placeholder, and says it publishes nothing', () => {
    const { lines, reporter } = recorder()
    expect(
      checkRelease(
        { mode: 'dry-run', version: '', appVersion: '0.7.0', pubkey: PLACEHOLDER },
        reporter,
      ),
    ).toBe('0.7.0')
    expect(lines).toEqual([
      expect.stringMatching(/^notice .*publishes nothing: no release, no tag/),
    ])
  })

  it('stops a release while tauri.conf.json carries the placeholder', () => {
    const { reporter } = recorder()
    expect(() =>
      checkRelease(
        { mode: 'release', version: '0.7.0', appVersion: '0.7.0', pubkey: PLACEHOLDER },
        reporter,
      ),
    ).toThrow(/still the placeholder, or not a key.*Releases stop until then/)
  })

  it(
    'lets a release with a real key go on, naming the key',
    () => {
      const { lines, reporter } = recorder()
      const { publicKey } = generateKeyPair('')
      checkRelease(
        { mode: 'release', version: '0.7.0', appVersion: '0.7.0', pubkey: publicKey },
        reporter,
      )
      expect(lines).toEqual([
        `info The apps carry updater key ${keyIdHex(decodePublicKey(publicKey).keyId)}.`,
      ])
    },
    SLOW,
  )

  it('stops when the app has another version than the release', () => {
    const { reporter } = recorder()
    expect(() =>
      checkRelease(
        { mode: 'dry-run', version: '0.7.0', appVersion: '0.6.0', pubkey: PLACEHOLDER },
        reporter,
      ),
    ).toThrow('apps/desktop/package.json has version 0.6.0, not 0.7.0')
    expect(() =>
      checkRelease(
        { mode: 'dry-run', version: '', appVersion: '1.0', pubkey: PLACEHOLDER },
        reporter,
      ),
    ).toThrow(/not a release version/)
  })

  it('reads its mode strictly', () => {
    expect(parseMode('release')).toBe('release')
    expect(() => parseMode('relase')).toThrow(/--mode must be release or dry-run/)
  })

  it('reads the key the apps carry from tauri.conf.json', () => {
    const pubkey = readUpdaterPubkey()
    expect(pubkey.startsWith('PLACEHOLDER') || decodePublicKey(pubkey).key.length === 32).toBe(true)
  })

  it('outputs the version to build', async () => {
    const { lines, reporter } = recorder()
    await main(['check', '--mode', 'dry-run', '--version', ''], {}, reporter)
    expect(lines).toContain(`output version=${readAppVersion()}`)
  })
})

describe('build-key', () => {
  it(
    'writes a throwaway key for tauri build, readable by its owner only',
    () => {
      const { key, configArgs } = writeBuildKey(join(folder, 'build-key'), false)
      expect(configArgs).toBe('')
      expect(statSync(key).mode & 0o777).toBe(0o600)
      expect(() => decodePublicKey(readFileSync(`${key}.pub`, 'utf8'))).not.toThrow()
    },
    SLOW,
  )

  it(
    'gives a dry run’s apps its public key, through a config tauri build merges',
    () => {
      const { key, configArgs } = writeBuildKey(join(folder, 'build-key'), true)
      const [flag, path] = configArgs.split(' ')
      expect(flag).toBe('--config')
      expect(JSON.parse(readFileSync(path ?? '', 'utf8'))).toEqual({
        plugins: { updater: { pubkey: readFileSync(`${key}.pub`, 'utf8') } },
      })
    },
    SLOW,
  )
})

describe('collect', () => {
  const target = targetById('windows-x64')
  const bundle = () => join(folder, 'bundle')
  const writeBundle = (version: string) => {
    for (const file of target.files(version)) {
      mkdirSync(join(bundle(), file.source, '..'), { recursive: true })
      writeFileSync(join(bundle(), file.source), file.source)
    }
  }

  it('copies the target’s files under their release names, and nothing else', () => {
    writeBundle('0.7.0')
    writeFileSync(join(bundle(), 'nsis', 'FXM_0.7.0_x64-setup.exe.sig'), 'throwaway signature')
    const out = join(folder, 'out')
    const files = collectTarget({ target, version: '0.7.0', bundleDir: bundle(), out })
    expect(readdirSync(out).sort()).toEqual([
      'fxm-desktop-0.7.0-windows-x64-setup.exe',
      'fxm-desktop-0.7.0-windows-x64.msi',
    ])
    expect(readFileSync(join(out, 'fxm-desktop-0.7.0-windows-x64.msi'), 'utf8')).toBe(
      'msi/FXM_0.7.0_x64_en-US.msi',
    )
    expect(files.map((file) => file.sha256)).toHaveLength(2)
  })

  it('stops when the build made no file of the target', () => {
    expect(() =>
      collectTarget({ target, version: '0.7.0', bundleDir: bundle(), out: folder }),
    ).toThrow('windows-x64: the build made no nsis/FXM_0.7.0_x64-setup.exe')
  })

  it('stops when tauri-action didn’t report a file, if it reported any', () => {
    writeBundle('0.7.0')
    const reported = [join(bundle(), 'nsis', 'FXM_0.7.0_x64-setup.exe')]
    expect(() =>
      collectTarget({
        target,
        version: '0.7.0',
        bundleDir: bundle(),
        out: join(folder, 'o'),
        artifactPaths: reported,
      }),
    ).toThrow("windows-x64: tauri-action didn't report msi/FXM_0.7.0_x64_en-US.msi")
  })
})

describe('sign', () => {
  const sign = (overrides: Partial<Parameters<typeof signRelease>[0]> = {}) =>
    signRelease({
      version: '0.7.0',
      artifacts: writeArtifacts('0.7.0'),
      out: join(folder, 'release'),
      repo: 'Pratyay-ops/FXM',
      key: { kind: 'throwaway' },
      pubkey: PLACEHOLDER,
      now: new Date('2026-10-26T12:00:00Z'),
      ...overrides,
    })

  it(
    'signs every file the updater installs and writes latest.json next to them (dry run)',
    () => {
      const { manifest } = sign()
      const out = join(folder, 'release')
      const written = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8')) as Manifest
      expect(written).toEqual(manifest)
      expect(readdirSync(out)).toHaveLength(11)
      expect(written.platforms['linux-aarch64-deb']?.url).toBe(
        downloadUrl('Pratyay-ops/FXM', '0.7.0', 'fxm-desktop-0.7.0-linux-arm64.deb'),
      )
    },
    SLOW,
  )

  it(
    'signs with the updater key when it is the key the apps carry',
    () => {
      const pair = generateKeyPair('secret password')
      const { manifest, keyId } = sign({
        key: { kind: 'updater', secretKey: pair.secretKey, password: 'secret password' },
        pubkey: pair.publicKey,
      })
      const publicKey = decodePublicKey(pair.publicKey)
      expect(keyId).toBe(keyIdHex(publicKey.keyId))
      const file = join(folder, 'release', 'fxm-desktop-0.7.0-macos-arm64.app.tar.gz')
      const comment = verify(
        readFileSync(file),
        manifest.platforms['darwin-aarch64']?.signature ?? '',
        publicKey,
      )
      expect(comment).toMatch(
        /^timestamp:1793016000\tfile:fxm-desktop-0\.7\.0-macos-arm64\.app\.tar\.gz\tversion:0\.7\.0$/,
      )
    },
    SLOW,
  )

  it(
    'refuses a key the apps don’t carry: they would refuse every update',
    () => {
      const signing = generateKeyPair('a')
      const carried = generateKeyPair('b')
      expect(() =>
        sign({
          key: { kind: 'updater', secretKey: signing.secretKey, password: 'a' },
          pubkey: carried.publicKey,
        }),
      ).toThrow(/is key [0-9A-F]{16}, but the apps carry [0-9A-F]{16}/)
    },
    SLOW,
  )

  it(
    'refuses to sign for apps that carry the placeholder',
    () => {
      const pair = generateKeyPair('a')
      expect(() =>
        sign({ key: { kind: 'updater', secretKey: pair.secretKey, password: 'a' } }),
      ).toThrow(/still the placeholder/)
    },
    SLOW,
  )

  it(
    'refuses a wrong password',
    () => {
      const pair = generateKeyPair('right')
      expect(() =>
        sign({
          key: { kind: 'updater', secretKey: pair.secretKey, password: 'wrong' },
          pubkey: pair.publicKey,
        }),
      ).toThrow(/Wrong password/)
    },
    SLOW,
  )

  it('needs the updater key unless it is a dry run', async () => {
    const { reporter } = recorder()
    await expect(
      main(
        ['sign', '--version', '0.7.0', '--artifacts', folder, '--out', folder, '--repo', 'a/b'],
        {},
        reporter,
      ),
    ).rejects.toThrow(/TAURI_SIGNING_PRIVATE_KEY is not set/)
  })

  it('checks its inputs', () => {
    expect(() => sign({ version: 'v0.7.0' })).toThrow(/not a release version/)
    expect(() => sign({ repo: 'not a repo' })).toThrow(/--repo must be owner\/name/)
  })
})

describe('gathering the build jobs’ files', () => {
  it('takes exactly each target’s files from its own artifact', () => {
    const artifacts = writeArtifacts('0.7.0')
    gatherArtifacts(artifacts, join(folder, 'out'), '0.7.0')
    expect(readdirSync(join(folder, 'out'))).toHaveLength(10)
  })

  it('refuses a missing artifact, a missing or extra file, and a full folder', () => {
    const artifacts = writeArtifacts('0.7.0')
    rmSync(join(artifacts, 'desktop-linux-arm64'), { recursive: true })
    expect(() => gatherArtifacts(artifacts, join(folder, 'a'), '0.7.0')).toThrow(
      /not desktop-linux-arm64/,
    )
    rmSync(artifacts, { recursive: true })

    writeArtifacts('0.7.0')
    writeFileSync(join(artifacts, 'desktop-macos-x64', 'FXM.app.tar.gz.sig'), 'throwaway')
    expect(() => gatherArtifacts(artifacts, join(folder, 'b'), '0.7.0')).toThrow(
      /desktop-macos-x64 holds .*FXM\.app\.tar\.gz\.sig/,
    )
    rmSync(artifacts, { recursive: true })

    writeArtifacts('0.7.0')
    rmSync(join(artifacts, 'desktop-windows-x64', 'fxm-desktop-0.7.0-windows-x64.msi'))
    expect(() => gatherArtifacts(artifacts, join(folder, 'c'), '0.7.0')).toThrow(
      /desktop-windows-x64 holds/,
    )
    rmSync(artifacts, { recursive: true })

    writeArtifacts('0.7.0')
    mkdirSync(join(folder, 'full'))
    writeFileSync(join(folder, 'full', 'old'), '')
    expect(() => gatherArtifacts(artifacts, join(folder, 'full'), '0.7.0')).toThrow(/is not empty/)
  })
})
