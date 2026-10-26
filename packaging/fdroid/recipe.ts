/**
 * FXM's metadata file for fdroiddata, F-Droid's repository of build recipes
 * (`metadata/io.github.pratyayops.fxm.yml` there), and the version file its update check reads
 * here. The owner submits the recipe (README.md); after that, F-Droid's checkupdates bot adds
 * each new release by itself, from the tag and version.txt. The fields and their order follow
 * fdroidserver's `fdroid rewritemeta` (metadata.py, read 2026-10-26), so the file is already in
 * the form F-Droid keeps.
 *
 * @module
 */

import {
  ANDROID_ID,
  APP_NAME,
  ISSUES_URL,
  LICENSE,
  NON_FREE_NET_REASON,
  RELEASES_URL,
  REPO_URL,
  SITE_URL,
} from '../listing.ts'
import { androidVersionCode, tagOf, type Version } from '../version.ts'
import { yamlBlock, yamlScalar } from '../yaml.ts'

/** The recipe's file name in fdroiddata's `metadata/` folder. */
export const RECIPE_FILE = `${ANDROID_ID}.yml`

/** The Android app's Gradle module, where F-Droid builds the APK. */
export const SUBDIR = 'apps/mobile/android/app'

/** The `build:` step: back to the repository's root, then the F-Droid build script. */
export const BUILD_COMMANDS = ['cd ../../../..', 'packaging/fdroid/build.sh'] as const

/** fdroiddata's categories (config/categories.yml there), as NewPipe's and Spotube's recipes use. */
export const CATEGORIES = ['Internet', 'Multimedia', 'Online Media Player'] as const

/**
 * The file F-Droid's update check reads at each tag. app/build.gradle computes the version code
 * from the version (stage 6.6), and F-Droid can only read a number written in a file
 * (`UpdateCheckData` in its Build Metadata Reference, and fdroidserver's checkupdates.py, read
 * 2026-10-26), so this file holds both. scripts/release-version.sh sets it with every other
 * version (`channels version`), so the release commit that a tag points at always carries it.
 */
export const VERSION_FILE = 'packaging/fdroid/version.txt'

/** Only release tags, `vX.Y.Z`. */
export const UPDATE_CHECK_MODE = 'Tags ^v\\d+\\.\\d+\\.\\d+$'

/** Where F-Droid finds the version code and name at a tag. */
export const UPDATE_CHECK_DATA = `${VERSION_FILE}|versionCode=(\\d+)|.|versionName=(\\d+\\.\\d+\\.\\d+)`

/** What F-Droid's maintainers should know about the build. */
export const MAINTAINER_NOTES = `The Android app is a Capacitor shell around FXM's web app (apps/web). In the build step,
packaging/fdroid/build.sh installs Node.js 22 from nodejs.org (pinned and SHA-256 checked:
Debian's stable and testing suites have no Node.js 22) and pnpm (pinned, integrity checked),
then the lockfile's npm packages, some of them FLOSS build tools with prebuilt native binaries
(the README lists them). It builds the web app with FXM_DISTRIBUTION=fdroid, copies it into the
Android project (cap sync) and writes the APK's third-party notices. FXM_DISTRIBUTION=fdroid
turns FXM's own update check off, and FXM's signed YouTube code updates and plugins wait for an
opt-in that says they bypass F-Droid's checks. app/build.gradle computes the version code, which
packaging/fdroid/version.txt repeats for UpdateCheckData.
Details: ${REPO_URL}/tree/main/packaging/fdroid`

/** The contents of version.txt for a release. */
export function versionFile(version: Version): string {
  return [
    '# FXM’s Android version, for F-Droid’s update check (UpdateCheckData in its recipe,',
    '# packaging/fdroid/README.md). scripts/release-version.sh sets it with every other version.',
    `versionName=${version.text}`,
    `versionCode=${androidVersionCode(version)}`,
    '',
  ].join('\n')
}

/** Reads version.txt back: the version name and code it holds. */
export function readVersionFile(text: string): { name: string; code: number } {
  const name = /^versionName=(\d+\.\d+\.\d+)$/m.exec(text)?.[1]
  const code = /^versionCode=(\d+)$/m.exec(text)?.[1]
  if (name === undefined || code === undefined) {
    throw new Error(`${VERSION_FILE} must have a versionName=x.y.z and a versionCode=<n> line`)
  }
  return { name, code: Number(code) }
}

/** Options for {@link fdroidRecipe}. */
export interface RecipeOptions {
  /** The release F-Droid builds first. */
  readonly version: Version
  /** Its commit: the full SHA-1 the tag points at, or the tag. */
  readonly commit: string
}

/** The recipe, ready for fdroiddata's `metadata/` folder. */
export function fdroidRecipe({ version, commit }: RecipeOptions): string {
  const code = androidVersionCode(version)
  return [
    'AntiFeatures:',
    '  NonFreeNet:',
    `    en-US: ${yamlScalar(NON_FREE_NET_REASON)}`,
    'Categories:',
    ...CATEGORIES.map((category) => `  - ${yamlScalar(category)}`),
    `License: ${yamlScalar(LICENSE)}`,
    `WebSite: ${yamlScalar(SITE_URL)}`,
    `SourceCode: ${yamlScalar(REPO_URL)}`,
    `IssueTracker: ${yamlScalar(ISSUES_URL)}`,
    `Changelog: ${yamlScalar(RELEASES_URL)}`,
    '',
    `AutoName: ${yamlScalar(APP_NAME)}`,
    '',
    'RepoType: git',
    `Repo: ${yamlScalar(`${REPO_URL}.git`)}`,
    '',
    'Builds:',
    `  - versionName: ${yamlScalar(version.text)}`,
    `    versionCode: ${code}`,
    `    commit: ${yamlScalar(commit)}`,
    `    subdir: ${yamlScalar(SUBDIR)}`,
    '    gradle:',
    '      - yes',
    '    build:',
    ...BUILD_COMMANDS.map((command) => `      - ${yamlScalar(command)}`),
    '',
    `MaintainerNotes: ${yamlBlock(MAINTAINER_NOTES, 2)}`,
    '',
    'AutoUpdateMode: Version',
    `UpdateCheckMode: ${yamlScalar(UPDATE_CHECK_MODE)}`,
    `UpdateCheckData: ${yamlScalar(UPDATE_CHECK_DATA)}`,
    `CurrentVersion: ${yamlScalar(version.text)}`,
    `CurrentVersionCode: ${code}`,
    '',
  ].join('\n')
}

/** The tag F-Droid's first build checks out when no commit is known. */
export function defaultCommit(version: Version): string {
  return tagOf(version)
}
