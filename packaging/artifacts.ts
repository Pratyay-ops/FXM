/**
 * The release files the channels point at, named as the release workflow names them: the APK of
 * stage 6.6 (`fxm_release_catalog` in scripts/release-lib.sh) and the desktop installers of
 * stage 7.5 (apps/desktop/release/targets.ts). Both stages were reviewed but not merged when
 * this was written; artifacts.test.ts compares these names with theirs once they have merged.
 *
 * @module
 */

import type { Version } from './version.ts'

/** The Android app for every phone, which Obtainium and the APK's own update check offer. */
export function androidUniversalApk(version: Version): string {
  return `fxm-android-universal-${version.text}.apk`
}

/** The Windows installer for the user's account (NSIS), which winget installs. */
export function windowsSetup(version: Version): string {
  return `fxm-desktop-${version.text}-windows-x64-setup.exe`
}

/** Flatpak's architectures, and the `.deb` each one repackages. */
export const DEB_ARCHES = ['x86_64', 'aarch64'] as const
export type DebArch = (typeof DEB_ARCHES)[number]

/** The desktop app's `.deb` for an architecture. */
export function linuxDeb(version: Version, arch: DebArch): string {
  return `fxm-desktop-${version.text}-linux-${arch === 'x86_64' ? 'x64' : 'arm64'}.deb`
}
