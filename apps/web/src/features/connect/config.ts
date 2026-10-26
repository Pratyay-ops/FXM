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
  /**
   * The Android app (APK) on GitHub Releases: stage 6.6. Turn it on with the landing page's
   * `AVAILABLE.android`, once a release carries the signed APKs (apps/mobile/RELEASING.md).
   */
  android: false,
  /**
   * Downloads, in the format the source has (the original file): stage 4.1, on with the app's
   * composition root (stage 2.9b). YouTube songs where their bytes are readable (FXM Connect,
   * the desktop and Android apps), Internet Archive and Jamendo everywhere.
   */
  downloads: true,
  /**
   * Converting downloads to FLAC, ALAC, WAV, MP3, AAC or Opus, with tags, cover art and lyrics:
   * stage 4.2. A download stays the original file, which plays offline; a downloaded song's
   * "Save to device…" saves a copy in the format the user picks, converted on the device by
   * FXM's ffmpeg core (the app's `ffmpeg/` folder, which make dist fills). Off, Settings and Save
   * to device offer the original alone.
   */
  conversions: true,
  /** Connecting a Spotify account for a read-only sync: stage 3.5 (the web app with FXM Connect). */
  spotifyAccount: true,
  /** Playing music files from the device: stage 4.4, in the Library's Local files tab. */
  localFiles: true,
  /**
   * The embeddable mini-player (stage 5.2), and with it the app's Share entry, which hands out
   * its code. Turn it on with the landing page's `AVAILABLE.embed`, once a browser test shows the
   * production embed playing in the Lite tier inside a page on another origin: until then nobody
   * is invited to publish a player that may not play.
   */
  embed: false,
} as const

/** A flag of {@link RELEASED}. */
export type ReleaseFlag = keyof typeof RELEASED

/** " (coming soon)" after something that isn't released yet, nothing after the rest. */
export function soon(released: boolean): string {
  return released ? '' : ' (coming soon)'
}
