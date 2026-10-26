/**
 * Which distribution this build is: `standard`, or `fdroid` for the F-Droid build of stage R.3.
 * F-Droid builds keep plugins off until the user opts in (`PLUGINS_CONSENT` of `@fxm/plugins`).
 *
 * The app's one gate, `lib/distribution.ts`, which the YouTube code updates read too, so that a
 * build can't ask before one kind of downloaded code and not before the other. It says which
 * build flags make an F-Droid build; a value `parseDistribution` doesn't know counts as `fdroid`,
 * which asks first.
 *
 * @module
 */

export { BUILD_DISTRIBUTION, distributionOf } from '../../lib/distribution'
