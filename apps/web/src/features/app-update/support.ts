/**
 * Which builds check for new app versions (stage 6.6): only the Android app from GitHub
 * Releases, which the release workflow builds with `FXM_DISTRIBUTION=standard`. The web app
 * updates itself (features/pwa), the desktop app gets its own updater (stage 7.5), F-Droid builds
 * leave updates to F-Droid (`updatePolicy` of `@fxm/platform`: its inclusion policy forbids
 * self-updates without the user's opt-in), and a build of an unreleased version (0.0.0) has
 * nothing to compare with. Any other build stays quiet too: a development build, `make apk` or
 * someone else's rebuild is signed with another key, so the APK it would offer couldn't install
 * over it.
 *
 * @module
 */

import { APP_VERSION } from '@fxm/core'
import {
  type Distribution,
  detectEnvironment,
  type Environment,
  parseDistribution,
  updatePolicy,
} from '@fxm/platform'
import { parseVersion } from './releases'

/** Why a build doesn't check for app updates. */
export type NoAppUpdateReason =
  /** The web app, the desktop app or a test: not the Android app. */
  | 'not-android'
  /** An F-Droid build: F-Droid updates it. */
  | 'fdroid'
  /**
   * A build that doesn't say it is the one from GitHub Releases (`FXM_DISTRIBUTION` unset): a
   * development build, `make apk`, or someone else's rebuild, signed with another key than FXM's.
   */
  | 'unofficial-build'
  /** A build of no released version (0.0.0, or not x.y.z), such as a development build. */
  | 'unreleased'

/** Whether this build checks GitHub for new versions of itself. */
export type AppUpdateSupport =
  | { readonly checks: true; readonly version: string }
  | { readonly checks: false; readonly reason: NoAppUpdateReason }

/** What {@link appUpdateSupport} decides on; each defaults to this build's. */
export interface AppUpdateBuild {
  /** Where FXM runs. Default: {@link detectEnvironment}. */
  readonly environment?: Environment
  /**
   * The `FXM_DISTRIBUTION` flag the build was made with (vite.config.ts builds it in; `''` when
   * unset). Default: this build's, `import.meta.env.FXM_DISTRIBUTION`.
   */
  readonly distributionFlag?: string
  /** The app's version. Default: `APP_VERSION`. */
  readonly version?: string
}

/** This build's distribution: `fdroid` in F-Droid builds (stage R.3), otherwise `standard`. */
export function buildDistribution(flag: unknown = import.meta.env.FXM_DISTRIBUTION): Distribution {
  try {
    return parseDistribution(flag)
  } catch (error) {
    // vite.config.ts fails the build first; should a bad flag get through, check nothing.
    console.error('FXM: unknown FXM_DISTRIBUTION, so the app-update check stays off', error)
    return 'fdroid'
  }
}

/**
 * Whether the flag says this is the build from GitHub Releases: `standard`, in any case. Unlike
 * {@link buildDistribution}, which reads an unset flag as `standard`, this fails closed: only the
 * release workflow's build (`release-apk.sh build`) sets it.
 */
export function isGitHubReleasesBuild(flag: unknown = import.meta.env.FXM_DISTRIBUTION): boolean {
  return typeof flag === 'string' && flag.trim().toLowerCase() === 'standard'
}

function currentEnvironment(): Environment | undefined {
  try {
    return detectEnvironment()
  } catch {
    return undefined
  }
}

let thisBuild: AppUpdateSupport | undefined

/**
 * {@link appUpdateSupport} of this build, worked out once: where it runs, its flags and its
 * version never change while it runs.
 */
export function buildAppUpdateSupport(): AppUpdateSupport {
  thisBuild ??= appUpdateSupport()
  return thisBuild
}

/** Whether this build checks for new app versions, and why not. */
export function appUpdateSupport({
  environment = currentEnvironment(),
  distributionFlag = import.meta.env.FXM_DISTRIBUTION,
  version = APP_VERSION,
}: AppUpdateBuild = {}): AppUpdateSupport {
  if (environment !== 'capacitor') return { checks: false, reason: 'not-android' }
  if (!updatePolicy(buildDistribution(distributionFlag)).appUpdateCheck) {
    return { checks: false, reason: 'fdroid' }
  }
  if (!isGitHubReleasesBuild(distributionFlag)) return { checks: false, reason: 'unofficial-build' }
  const parts = parseVersion(version)
  if (parts === undefined || parts.every((part) => part === 0)) {
    return { checks: false, reason: 'unreleased' }
  }
  return { checks: true, version }
}
