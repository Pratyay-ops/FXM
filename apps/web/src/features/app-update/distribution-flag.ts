/**
 * The `FXM_DISTRIBUTION` build flag, as vite.config.ts checks it before it builds it into the
 * app (`import.meta.env.FXM_DISTRIBUTION`), where `parseDistribution` of `@fxm/platform` reads it.
 * F-Droid builds (stage R.3) set it to `fdroid`; the other builds leave it unset or `standard`.
 * Without imports, so that the Vite config can load it: `distribution-flag.test.ts` keeps it in
 * step with `parseDistribution`.
 *
 * @module
 */

/** Whether a value of `FXM_DISTRIBUTION` names a distribution, in any case. */
export function isDistributionFlag(value: string | undefined): boolean {
  return /^(standard|fdroid|f-droid)?$/.test((value ?? '').trim().toLowerCase())
}

/**
 * The flag's value for the app, or an error that fails the build, so that a typo can't turn an
 * F-Droid build into a standard one, which would check for app updates without asking.
 */
export function distributionFlag(value: string | undefined): string {
  if (!isDistributionFlag(value)) {
    throw new Error(
      `FXM_DISTRIBUTION is ${JSON.stringify(value)}: leave it unset, or set it to standard or fdroid`,
    )
  }
  return (value ?? '').trim()
}
