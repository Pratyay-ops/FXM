/**
 * Constants of the connect feature: where FXM's downloads live and which of the apps and
 * features the tiers mention are released yet.
 *
 * @module
 */

/** FXM's source code. */
export const REPOSITORY_URL = 'https://github.com/Pratyay-ops/FXM'

/** The latest release: the FXM Connect zips today, the desktop app and the APK later. */
export const RELEASES_URL = `${REPOSITORY_URL}/releases/latest`

/**
 * What is released, for the tier panels and the install guides. The landing page keeps the same
 * kind of map (`AVAILABLE` in `apps/site/src/config.ts`): a stage that ships one of these flips
 * its flag here too, and the "Coming soon" badges and the guides follow.
 */
export const RELEASED = {
  /**
   * FXM Connect as a Firefox add-on signed by Mozilla: stage R.2. Turn it on with the landing
   * page's `AVAILABLE.firefox`, once a release carries the signed `.xpi` (apps/extension/README.md,
   * "Store channels"): the Firefox guide then installs it instead of the temporary add-on.
   */
  firefoxAddon: false,
  /** FXM Connect listed on Edge Add-ons: stage R.2, once its first version is published there. */
  edgeAddon: false,
  /** The desktop app for macOS, Windows and Linux on GitHub Releases: stage 7.5. */
  desktop: false,
  /** The Android app (APK) on GitHub Releases: stage 6.6. */
  android: false,
  /** Downloads in any format: stage 4.1. */
  downloads: false,
  /** Connecting a Spotify account for a read-only sync: stage 3.5 (the web app with FXM Connect). */
  spotifyAccount: true,
  /** Playing music files from the device: stage 4.4, in the Library's Local files tab. */
  localFiles: true,
} as const

/** A flag of {@link RELEASED}. */
export type ReleaseFlag = keyof typeof RELEASED

/** " (coming soon)" after something that isn't released yet, nothing after the rest. */
export function soon(released: boolean): string {
  return released ? '' : ' (coming soon)'
}
