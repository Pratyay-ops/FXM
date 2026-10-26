import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildManifest,
  checkManifest,
  downloadUrl,
  type Manifest,
  releasePage,
} from './manifest.ts'
import {
  decodePublicKey,
  decodeSecretKey,
  generateKeyPair,
  type PublicKey,
  type SecretKey,
  sign,
  trustedComment,
} from './minisign.ts'
import { releaseFiles } from './targets.ts'

const VERSION = '0.7.0'
const REPO = 'Pratyay-ops/FXM'
const PUBLISHED = new Date('2026-10-26T12:00:00Z')

describe('latest.json', () => {
  let secret: SecretKey
  let publicKey: PublicKey
  let otherKey: SecretKey
  const files = new Map(releaseFiles(VERSION).map((file) => [file.name, Buffer.from(file.name)]))
  const read = (name: string) => files.get(name)

  /** Signatures of every file the updater installs, for `version`, with `key`. */
  const signatures = (key: SecretKey, version = VERSION) =>
    new Map(
      releaseFiles(VERSION)
        .filter((file) => file.platforms.length > 0)
        .map((file) => [
          file.name,
          sign(read(file.name) ?? Buffer.alloc(0), key, trustedComment(file.name, version, 1)),
        ]),
    )

  const manifest = () =>
    buildManifest({
      version: VERSION,
      repo: REPO,
      published: PUBLISHED,
      signatures: signatures(secret),
    })

  const check = (value: unknown) =>
    checkManifest(value, { version: VERSION, repo: REPO, publicKey, read })

  /** The manifest with one platform's entry changed. */
  const withPlatform = (platform: string, change: Partial<Manifest['platforms'][string]>) => {
    const original = manifest()
    const entry = original.platforms[platform]
    if (!entry) throw new Error(`no ${platform}`)
    return {
      ...original,
      platforms: { ...original.platforms, [platform]: { ...entry, ...change } },
    }
  }

  beforeAll(() => {
    const pair = generateKeyPair('m')
    secret = decodeSecretKey(pair.secretKey, 'm')
    publicKey = decodePublicKey(pair.publicKey)
    const other = generateKeyPair('o')
    otherKey = decodeSecretKey(other.secretKey, 'o')
  }, 60_000)

  it('lists every platform and bundle the updater looks up, each at its own file', () => {
    const { platforms, version, pub_date, notes } = manifest()
    expect(version).toBe(VERSION)
    expect(pub_date).toBe('2026-10-26T12:00:00.000Z')
    expect(notes).toContain(releasePage(REPO, VERSION))
    expect(Object.keys(platforms).sort()).toEqual(
      [
        'darwin-aarch64',
        'darwin-aarch64-app',
        'darwin-x86_64',
        'darwin-x86_64-app',
        'linux-aarch64',
        'linux-aarch64-appimage',
        'linux-aarch64-deb',
        'linux-x86_64',
        'linux-x86_64-appimage',
        'linux-x86_64-deb',
        'windows-x86_64',
        'windows-x86_64-msi',
        'windows-x86_64-nsis',
      ].sort(),
    )
    expect(platforms['windows-x86_64-msi']?.url).toBe(
      downloadUrl(REPO, VERSION, 'fxm-desktop-0.7.0-windows-x64.msi'),
    )
    // An app without a bundle type of its own gets the NSIS installer and the AppImage.
    expect(platforms['windows-x86_64']?.url).toMatch(/-windows-x64-setup\.exe$/)
    expect(platforms['linux-x86_64']?.url).toMatch(/-linux-x64\.AppImage$/)
    expect(platforms['linux-x86_64-deb']?.url).toMatch(/-linux-x64\.deb$/)
    expect(platforms['darwin-aarch64']?.url).toBe(
      'https://github.com/Pratyay-ops/FXM/releases/download/v0.7.0/fxm-desktop-0.7.0-macos-arm64.app.tar.gz',
    )
  })

  it('checks out as each platform’s updater will check it', () => {
    expect(check(JSON.parse(JSON.stringify(manifest())))).toEqual([])
  })

  it('needs a signature for every file the updater installs', () => {
    const missing = signatures(secret)
    missing.delete('fxm-desktop-0.7.0-linux-arm64.deb')
    expect(() =>
      buildManifest({ version: VERSION, repo: REPO, published: PUBLISHED, signatures: missing }),
    ).toThrow(/linux-arm64\.deb has no signature/)
  })

  it('fails with a signature by another key, as the apps would', () => {
    const forged = buildManifest({
      version: VERSION,
      repo: REPO,
      published: PUBLISHED,
      signatures: signatures(otherKey),
    })
    expect(check(forged)).toContain(
      'darwin-aarch64: The signature was made with another key than ' +
        `${Buffer.from(publicKey.keyId).reverse().toString('hex').toUpperCase()}`,
    )
  })

  it('fails when a file is signed for another version: an old release can’t pass for this one', () => {
    const old = buildManifest({
      version: VERSION,
      repo: REPO,
      published: PUBLISHED,
      signatures: signatures(secret, '0.6.0'),
    })
    expect(check(old)).toContain(
      'darwin-x86_64: fxm-desktop-0.7.0-macos-x64.app.tar.gz is signed for version 0.6.0',
    )
  })

  it('fails when a platform points at another file or release', () => {
    const elsewhere = withPlatform('linux-x86_64-deb', {
      url: downloadUrl(REPO, '0.6.0', 'fxm-desktop-0.6.0-linux-x64.deb'),
    })
    expect(check(elsewhere)).toEqual([
      expect.stringMatching(
        /^linux-x86_64-deb points at .*v0\.6\.0.*, not at fxm-desktop-0\.7\.0-linux-x64\.deb/,
      ),
    ])
  })

  it('fails on a missing platform, an unknown one, or the wrong version', () => {
    const { platforms, ...rest } = manifest()
    const { 'windows-x86_64-msi': _, ...fewer } = platforms
    expect(check({ ...rest, platforms: fewer })).toEqual(['latest.json has no windows-x86_64-msi'])
    expect(
      check({
        ...rest,
        platforms: { ...platforms, 'windows-aarch64': platforms['windows-x86_64'] },
      }),
    ).toEqual(['latest.json lists an unknown platform windows-aarch64'])
    expect(check({ ...manifest(), version: '0.7.1' })).toEqual([
      'latest.json announces 0.7.1, not 0.7.0',
    ])
    expect(check({ ...manifest(), pub_date: 'yesterday' })).toEqual([
      'latest.json has no publication date',
    ])
    expect(check([])).toEqual(['latest.json is not a JSON object'])
  })

  it('fails when the release lacks a file it lists', () => {
    const problems = checkManifest(manifest(), {
      version: VERSION,
      repo: REPO,
      publicKey,
      read: (name) => (name.endsWith('.AppImage') ? undefined : read(name)),
    })
    expect(problems).toContain(
      'linux-aarch64: the release has no fxm-desktop-0.7.0-linux-arm64.AppImage',
    )
  })
})
