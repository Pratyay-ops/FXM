/** Build variants: the release build, or the development build that also allows localhost. */
import type { Browser } from '../src/manifest.ts'

/**
 * Reads `FXM_EXTENSION_DEV`: `1`, `true` or `yes` select the development build; unset, empty,
 * `0`, `false` or `no` the release build. Anything else is a mistake worth failing on.
 */
export function isDevVariant(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes'].includes(normalized)) return true
  if (['', '0', 'false', 'no'].includes(normalized)) return false
  throw new Error(`FXM_EXTENSION_DEV must be 1 or 0, got "${value}"`)
}

/** Output names inside dist/ for one browser: the unpacked folder and the zip. */
export function outputNames(
  browser: Browser,
  version: string,
  dev: boolean,
): { folder: string; zip: string } {
  const suffix = dev ? '-dev' : ''
  return { folder: `${browser}${suffix}`, zip: `fxm-connect-${browser}-${version}${suffix}.zip` }
}
