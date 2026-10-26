import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { androidUniversalApk, linuxDeb, windowsSetup } from '../artifacts.ts'
import { pinnedReleaseCertificate, RELEASE_CERTIFICATE_FILE, readmeBlocks } from '../files.ts'
import { ANDROID_ID } from '../listing.ts'
import { parseVersion, REPO_ROOT } from '../version.ts'
import {
  APK_FILTER,
  additionalSettings,
  addLink,
  colons,
  importLink,
  linksTable,
  obtainiumConfig,
  pinnedCertificate,
  REDIRECT_URL,
  webLink,
} from './obtainium.ts'

const FINGERPRINT = 'ab'.repeat(32)

describe('Obtainium', () => {
  it('follows FXM’s GitHub repository under its Android application ID', () => {
    expect(addLink()).toBe('obtainium://add/https://github.com/Pratyay-ops/FXM')
    const config = JSON.parse(decodeURIComponent(importLink().replace('obtainium://app/', '')))
    expect(config).toEqual(obtainiumConfig())
    expect(config).toMatchObject({ id: ANDROID_ID, url: 'https://github.com/Pratyay-ops/FXM' })
    expect(JSON.parse(config.additionalSettings)).toEqual(additionalSettings())
  })

  it('installs the universal APK and nothing else a release carries', () => {
    const filter = new RegExp(APK_FILTER)
    const version = parseVersion('0.6.0')
    expect(filter.test(androidUniversalApk(version))).toBe(true)
    for (const other of [
      'fxm-android-arm64-v8a-0.6.0.apk',
      windowsSetup(version),
      linuxDeb(version, 'x86_64'),
      'fxm-web-0.6.0.zip',
      'SHA256SUMS',
    ]) {
      expect(filter.test(other), other).toBe(false)
    }
    // Releases only, and the universal APK whatever the phone: Obtainium's defaults otherwise.
    expect(additionalSettings()).toEqual({
      includePrereleases: false,
      apkFilterRegEx: APK_FILTER,
      invertAPKFilter: false,
      autoApkFilterByArch: false,
    })
  })

  it('pins the release certificate once 6.6’s file pins one', () => {
    expect(pinnedCertificate(undefined)).toBeUndefined()
    // apps/mobile/release-certificate.txt's placeholder (stage 6.6).
    expect(
      pinnedCertificate(
        '# The SHA-256 of the signing certificate\nnone yet: run scripts/make-android-keystore.sh\n',
      ),
    ).toBeUndefined()
    const pinned = pinnedCertificate(`# comment\n\n${colons(FINGERPRINT).toLowerCase()}\n`)
    expect(pinned).toBe(FINGERPRINT)
    expect(additionalSettings({ certificate: FINGERPRINT }).allowedSigningCertHashes).toBe(
      `${'AB:'.repeat(31)}AB`,
    )
    expect(additionalSettings().allowedSigningCertHashes).toBeUndefined()
    expect(() => colons('abc')).toThrow(/not a SHA-256/)
  })

  it('wraps a link in Obtainium’s web page, for places that can’t open obtainium:// links', () => {
    const link = webLink(addLink())
    expect(link.startsWith(`${REDIRECT_URL}?r=`)).toBe(true)
    expect(new URL(link).searchParams.get('r')).toBe(addLink())
  })

  it('gives the links in its README as the generator makes them, with the pinned certificate', () => {
    // Once apps/mobile/release-certificate.txt pins FXM's certificate (stage 6.6), this fails
    // until `channels sync` has written the pinned import link into the README.
    const readme = readFileSync(join(REPO_ROOT, 'packaging/obtainium/README.md'), 'utf8')
    const certificate = pinnedReleaseCertificate()
    const options = certificate === undefined ? {} : { certificate }
    expect(readme).toContain(linksTable(options))
    expect(readme).toContain(webLink(importLink(options)))
    expect(readme).toContain(webLink(addLink()))
    expect(readme).toContain(addLink())
  })

  it('pins the certificate in the README’s import link as soon as 6.6’s file pins one', () => {
    const root = mkdtempSync(join(tmpdir(), 'fxm-obtainium-'))
    try {
      const file = join(root, RELEASE_CERTIFICATE_FILE)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `# The SHA-256 fingerprint\n${colons(FINGERPRINT)}\n`)
      const links = readmeBlocks(root).get('packaging/obtainium/README.md')?.links
      expect(links).toBe(linksTable({ certificate: FINGERPRINT }))
      expect(links).toContain(webLink(importLink({ certificate: FINGERPRINT })))
      expect(links).not.toContain(webLink(importLink()))
      expect(links).toContain(
        `only an APK signed with FXM's release certificate, \`${colons(FINGERPRINT)}\``,
      )
      // 6.6's placeholder pins nothing yet.
      writeFileSync(file, '# The SHA-256\nnone yet: run scripts/make-android-keystore.sh\n')
      expect(readmeBlocks(root).get('packaging/obtainium/README.md')?.links).toBe(linksTable())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
