/**
 * Links that add FXM's Android app to Obtainium, which installs and updates apps straight from
 * their GitHub releases. Obtainium's deep links (its wiki, "Deep Links", read 2026-10-26):
 *
 * - `obtainium://add/<url>` opens Obtainium's Add App screen with the repository filled in;
 * - `obtainium://app/<url-encoded JSON>` imports a whole configuration, shown to the user before
 *   anything is added;
 * - `https://apps.obtainium.imranr.dev/redirect?r=<obtainium link>` is a web page that opens
 *   such a link, for places where `obtainium://` links can't be clicked, such as GitHub's
 *   Markdown, and offers Obtainium when it isn't installed.
 *
 * The configuration's settings are the ones Obtainium's crowdsourced configurations carry
 * (apps.obtainium.imranr.dev, read 2026-10-26). Imports nothing but Node's own modules.
 *
 * @module
 */

import { ANDROID_ID, APP_NAME, GITHUB_OWNER, REPO_URL } from '../listing.ts'

/**
 * Picks the universal APK of a release, `fxm-android-universal-<version>.apk` (stage 6.6), among
 * everything else a release carries: the arm64-v8a APK, the desktop installers, the web zip.
 * While FXM has no native code, both APKs hold the same app.
 */
export const APK_FILTER = '^fxm-android-universal-\\d+\\.\\d+\\.\\d+\\.apk$'

/** The repository to follow. */
export const SOURCE_URL = REPO_URL

/** Obtainium's web page that opens a deep link. */
export const REDIRECT_URL = 'https://apps.obtainium.imranr.dev/redirect'

/** Options for {@link obtainiumConfig}. */
export interface ObtainiumOptions {
  /**
   * The SHA-256 of FXM's release signing certificate (apps/mobile/release-certificate.txt,
   * stage 6.6), if it is pinned: Obtainium then refuses an APK signed with another key, also
   * on the first install, when Android has nothing to compare with yet.
   */
  readonly certificate?: string
}

/**
 * FXM's own settings. Obtainium fills in its defaults for every other one when it loads an
 * imported configuration (`appJSONCompatibilityModifiers` in lib/providers/app_json_migration.dart,
 * read 2026-10-26), which keeps the link short: releases only, the universal APK whatever the
 * phone's processor, and FXM's signing certificate once it is pinned.
 */
export function additionalSettings(options: ObtainiumOptions = {}): Record<string, unknown> {
  return {
    includePrereleases: false,
    apkFilterRegEx: APK_FILTER,
    invertAPKFilter: false,
    autoApkFilterByArch: false,
    ...(options.certificate === undefined
      ? {}
      : { allowedSigningCertHashes: colons(options.certificate) }),
  }
}

/** The configuration that a deep link carries. */
export function obtainiumConfig(options: ObtainiumOptions = {}) {
  return {
    id: ANDROID_ID,
    url: SOURCE_URL,
    author: GITHUB_OWNER,
    name: APP_NAME,
    preferredApkIndex: 0,
    additionalSettings: JSON.stringify(additionalSettings(options)),
  }
}

/** The link that opens Obtainium's Add App screen with FXM's repository filled in. */
export function addLink(): string {
  return `obtainium://add/${SOURCE_URL}`
}

/** The link that imports FXM's whole configuration. */
export function importLink(options: ObtainiumOptions = {}): string {
  return `obtainium://app/${encodeURIComponent(JSON.stringify(obtainiumConfig(options)))}`
}

/** A link to Obtainium's web page that opens `link`. */
export function webLink(link: string): string {
  return `${REDIRECT_URL}?r=${encodeURIComponent(link)}`
}

/** A SHA-256 fingerprint as Obtainium shows one: upper case, in pairs, with colons. */
export function colons(fingerprint: string): string {
  const hex = fingerprint.replace(/[\s:]/g, '')
  if (!/^[\da-f]{64}$/i.test(hex)) throw new Error(`${fingerprint} is not a SHA-256 fingerprint`)
  return hex.toUpperCase().replace(/(..)(?!$)/g, '$1:')
}

/**
 * The fingerprint pinned in apps/mobile/release-certificate.txt (stage 6.6), read as that
 * stage's release scripts read it: the first line that is neither blank nor a `#` comment, a
 * SHA-256 with or without colons. `undefined` while the file is missing or pins none yet.
 */
export function pinnedCertificate(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !entry.startsWith('#'))
  const hex = line?.replace(/[\s:]/g, '').toLowerCase()
  return hex !== undefined && /^[\da-f]{64}$/.test(hex) ? hex : undefined
}
