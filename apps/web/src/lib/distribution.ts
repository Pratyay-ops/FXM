/**
 * Which distribution this build is: `standard` (GitHub Releases, and the web app) or `fdroid`,
 * the build F-Droid makes from source with packaging/fdroid/build.sh (stage R.3). F-Droid's
 * inclusion policy forbids downloading executable code without the user's opt-in, so an F-Droid
 * build keeps the YouTube code updates from FXM's website (`features/youtube-updates`) and plugins
 * (`features/plugins`, stage 8.3) off until the user turns them on, and never checks for app
 * updates itself (stage 6.6). This is the one gate both opt-ins read: `features/plugins` takes
 * {@link BUILD_DISTRIBUTION} from here.
 *
 * Two build flags can name the distribution, until one name is left:
 *
 * - `VITE_FXM_DISTRIBUTION`, which Vite builds in by itself, as it does every `VITE_` variable.
 *   This one gates downloaded code and plugins, today and after stage 6.6.
 * - `FXM_DISTRIBUTION`, which turns off stage 6.6's app-update check. Vite builds in no other
 *   variables by itself, and only stage 6.6's vite.config.ts builds this one in, so until 6.6 has
 *   merged it is `undefined` here: a build with only this flag would download code and run
 *   plugins without asking. Once it has merged, this module reads it too.
 *
 * packaging/fdroid/build.sh sets both. Either one naming F-Droid, or holding a value
 * `parseDistribution` doesn't know (only a mistyped recipe gives one), makes an F-Droid build:
 * such a build asks before it downloads code, rather than download code without asking where it
 * shouldn't.
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
