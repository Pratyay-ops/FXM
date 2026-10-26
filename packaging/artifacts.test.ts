import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { androidUniversalApk, DEB_ARCHES, linuxDeb, windowsSetup } from './artifacts.ts'
import { androidVersionCode, parseVersion, REPO_ROOT } from './version.ts'

const version = parseVersion('0.6.0')

/**
 * Stages 6.6 (the APK) and 7.5 (the desktop installers) name the release files. They had not
 * merged when these names were written, so these checks compare with theirs once they have.
 */
describe('the release files the channels point at', () => {
  it('follow the release’s naming: fxm-<what>-<version>…', () => {
    expect(androidUniversalApk(version)).toBe('fxm-android-universal-0.6.0.apk')
    expect(windowsSetup(version)).toBe('fxm-desktop-0.6.0-windows-x64-setup.exe')
    expect(DEB_ARCHES.map((arch) => linuxDeb(version, arch))).toEqual([
      'fxm-desktop-0.6.0-linux-x64.deb',
      'fxm-desktop-0.6.0-linux-arm64.deb',
    ])
  })

  it('match the APK in the release catalog, once stage 6.6 has merged', () => {
    const catalog = readFileSync(join(REPO_ROOT, 'scripts/release-lib.sh'), 'utf8')
    if (!catalog.includes('release-android|')) return
    expect(catalog).toContain(
      `release-android|${androidUniversalApk(parseVersion('9.9.9')).replace('9.9.9', '<version>')}|`,
    )
  })

  it('match the desktop installers of stage 7.5, once it has merged', async () => {
    const targets = join(REPO_ROOT, 'apps/desktop/release/targets.ts')
    if (!existsSync(targets)) return
    const { releaseFiles } = (await import(targets)) as {
      releaseFiles: (version: string) => { name: string }[]
    }
    const names = releaseFiles(version.text).map((file) => file.name)
    expect(names).toContain(windowsSetup(version))
    for (const arch of DEB_ARCHES) expect(names).toContain(linuxDeb(version, arch))
  })

  it('give the Android version code that stage 6.6’s build.gradle computes, once it has merged', () => {
    const gradle = readFileSync(join(REPO_ROOT, 'apps/mobile/android/app/build.gradle'), 'utf8')
    if (!gradle.includes('fxmVersionCode')) return
    // The same rule as version.ts: major × 1,000,000 + minor × 1,000 + patch, at least 1.
    expect(gradle).toContain('major * 1_000_000L + minor * 1_000L + patch')
    expect(gradle).toContain('Math.max(1L,')
    expect(androidVersionCode(parseVersion('1.2.3'))).toBe(1002003)
  })
})
