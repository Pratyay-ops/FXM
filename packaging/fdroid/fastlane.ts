/**
 * FXM's store listing for F-Droid, in the fastlane layout that F-Droid reads from the source
 * repository at each release (fastlane/metadata/android/en-US/, F-Droid's "All About
 * Descriptions, Graphics, and Screenshots", read 2026-10-26). `channels sync` writes the texts
 * and the icon from ../listing.ts; `channels changelog <x.y.z>` writes a release's changelog.
 *
 * @module
 */

import { APP_NAME, description, SUMMARY } from '../listing.ts'
import { androidVersionCode, type Version } from '../version.ts'

/** The folder, from the repository's root. */
export const FASTLANE_DIR = 'fastlane/metadata/android/en-US'

/** F-Droid's limits, in characters. */
export const FASTLANE_LIMITS = { title: 50, short: 80, full: 4000, changelog: 500 } as const

/** The icon: the app's 512 px icon (the web app's, drawn from the same mark as the launcher's). */
export const FASTLANE_ICON = {
  from: 'apps/web/public/icons/icon-512.png',
  to: `${FASTLANE_DIR}/images/icon.png`,
}

/**
 * What F-Droid builds do differently, which only F-Droid's listing says: no update check of
 * their own, and FXM's YouTube code from its website only after the user's opt-in. The signed
 * YouTube settings (stage 1.13's config) are data and still come, which the note says too.
 */
export const FDROID_BUILD_NOTE =
  'F-Droid’s build never checks for new versions of itself: F-Droid updates it. Between app releases, FXM keeps YouTube working with signed settings and code from its website. F-Droid’s build takes the settings, which are data, but downloads the code only after you turn that on in Settings → Sources, because the code doesn’t come from F-Droid.'

/** The full description, as plain text: F-Droid turns each line break into a break. */
export function fullDescription(): string {
  const { intro, features, paragraphs } = description('android')
  const [privacy, ...rest] = paragraphs
  return [
    intro,
    features.map((feature) => `• ${feature}`).join('\n'),
    privacy,
    FDROID_BUILD_NOTE,
    ...rest,
  ].join('\n\n')
}

/** The listing's text files, by path from the repository's root. */
export function fastlaneTexts(): Map<string, string> {
  return new Map([
    [`${FASTLANE_DIR}/title.txt`, `${APP_NAME}\n`],
    [`${FASTLANE_DIR}/short_description.txt`, `${SUMMARY}\n`],
    [`${FASTLANE_DIR}/full_description.txt`, `${fullDescription()}\n`],
  ])
}

/** Where a release's changelog goes: named after its Android version code, as F-Droid wants. */
export function changelogPath(version: Version): string {
  return `${FASTLANE_DIR}/changelogs/${androidVersionCode(version)}.txt`
}
