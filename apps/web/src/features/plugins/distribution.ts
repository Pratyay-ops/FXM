/**
 * Which distribution this build is: `standard`, or `fdroid` for the F-Droid build of stage R.3,
 * which builds the web app with `VITE_FXM_DISTRIBUTION=fdroid`. F-Droid builds keep plugins off
 * until the user opts in (`PLUGINS_CONSENT` of `@fxm/plugins`).
 *
 * @module
 */

import { type Distribution, parseDistribution } from '@fxm/platform'

/**
 * The distribution a build flag names (`parseDistribution` of `@fxm/platform`). A value it
 * doesn't know, which only a mistyped build recipe gives, counts as `fdroid`: such a build asks
 * before it runs any plugin, rather than run plugins without asking where it shouldn't.
 */
export function distributionOf(flag: unknown): Distribution {
  try {
    return parseDistribution(flag)
  } catch {
    return 'fdroid'
  }
}

/** This build's distribution. */
export const BUILD_DISTRIBUTION: Distribution = distributionOf(
  import.meta.env.VITE_FXM_DISTRIBUTION,
)
