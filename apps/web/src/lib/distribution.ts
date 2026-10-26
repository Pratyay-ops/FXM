/**
 * Which distribution this build is: `standard` (GitHub Releases, and the web app) or `fdroid`,
 * the build F-Droid makes from source with packaging/fdroid/build.sh (stage R.3). F-Droid's
 * inclusion policy forbids downloading executable code without the user's opt-in, so an F-Droid
 * build keeps the YouTube code updates from FXM's website off until the user turns them on
 * (`features/youtube-updates`), and never checks for app updates itself (stage 6.6).
 *
 * F-Droid's build script sets two flags, until the stages that read them agree on one name:
 * `FXM_DISTRIBUTION`, which stage 6.6's vite.config.ts builds into the app (and checks), and
 * `VITE_FXM_DISTRIBUTION`, which Vite builds in by itself and stage 8.3 reads. Either one naming
 * F-Droid, or holding a value `parseDistribution` doesn't know (only a mistyped recipe gives
 * one), makes an F-Droid build: such a build asks before it downloads code, rather than download
 * code without asking where it shouldn't.
 *
 * @module
 */

import { type Distribution, parseDistribution } from '@fxm/platform'

/** The distribution that a build's flags name (see the module documentation). */
export function distributionOf(...flags: readonly unknown[]): Distribution {
  let distribution: Distribution = 'standard'
  for (const flag of flags) {
    try {
      if (parseDistribution(flag) === 'fdroid') distribution = 'fdroid'
    } catch {
      distribution = 'fdroid'
    }
  }
  return distribution
}

/** This build's distribution. */
export const BUILD_DISTRIBUTION: Distribution = distributionOf(
  import.meta.env.FXM_DISTRIBUTION,
  import.meta.env.VITE_FXM_DISTRIBUTION,
)
