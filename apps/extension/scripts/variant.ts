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

/**
 * Output paths inside dist/ for one browser: the unpacked folder and the zip. Development
 * builds go to dist/dev/ and their zips end in -dev, so release tooling that picks up
 * dist/*.zip can never ship one: they trust any app on the localhost ports.
 */
export function outputNames(
  browser: Browser,
  version: string,
  dev: boolean,
): { folder: string; zip: string } {
  return dev
    ? { folder: `dev/${browser}`, zip: `dev/fxm-connect-${browser}-${version}-dev.zip` }
    : { folder: browser, zip: `fxm-connect-${browser}-${version}.zip` }
}

/** The staging folder inside dist/ that both browsers' outputs are copied from. */
export function stagingFolder(dev: boolean): string {
  return dev ? 'dev/.staging' : '.staging'
}
