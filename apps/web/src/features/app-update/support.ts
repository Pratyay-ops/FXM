/**
 * Which builds check for new app versions (stage 6.6): only the Android app from GitHub
 * Releases. The web app updates itself (features/pwa), the desktop app gets its own updater
 * (stage 7.5), F-Droid builds leave updates to F-Droid (`updatePolicy` of `@fxm/platform`: its
 * inclusion policy forbids self-updates without the user's opt-in), and a build of an unreleased
 * version (0.0.0) has nothing to compare with.
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
  /** The distribution. Default: this build's `FXM_DISTRIBUTION` flag. */
  readonly distribution?: Distribution
  /** The app's version. Default: `APP_VERSION`. */
  readonly version?: string
}

/** This build's distribution: `fdroid` in F-Droid builds (stage R.3). */
export function buildDistribution(flag: unknown = import.meta.env.FXM_DISTRIBUTION): Distribution {
  try {
    return parseDistribution(flag)
  } catch (error) {
    // vite.config.ts fails the build first; should a bad flag get through, check nothing.
    console.error('FXM: unknown FXM_DISTRIBUTION, so the app-update check stays off', error)
    return 'fdroid'
  }
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
  distribution = buildDistribution(),
  version = APP_VERSION,
}: AppUpdateBuild = {}): AppUpdateSupport {
  if (environment !== 'capacitor') return { checks: false, reason: 'not-android' }
  if (!updatePolicy(distribution).appUpdateCheck) return { checks: false, reason: 'fdroid' }
  const parts = parseVersion(version)
  if (parts === undefined || parts.every((part) => part === 0)) {
    return { checks: false, reason: 'unreleased' }
  }
  return { checks: true, version }
}
