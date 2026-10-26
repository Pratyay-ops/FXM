/**
 * Site-wide constants. astro.config.ts reads SITE_URL from here, so the canonical
 * origin, the sitemap and robots.txt always agree.
 */

/** Production origin, without a trailing slash. */
export const SITE_URL = 'https://fxmusic.pages.dev'

/** The web player. It is built by apps/web and served next to this site at deploy time. */
export const APP_PATH = '/app/'

/**
 * Paths that exist in production but are not part of this site's build output. The
 * build-time link check skips them (see src/lib/build-check.ts).
 */
export const EXTERNAL_PATHS = [APP_PATH] as const

/** <meta name="theme-color"> per theme: the page background (tokens.test.ts keeps them in sync). */
export const THEME_COLOR = { dark: '#0b0b0f', light: '#f6f6f8' } as const

export const REPO_URL = 'https://github.com/Pratyay-ops/FXM'
export const RELEASES_URL = `${REPO_URL}/releases/latest`
export const ISSUES_URL = `${REPO_URL}/issues`
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

export type Feature =
  | 'lite'
  | 'homeFeed'
  | 'radio'
  | 'spotifyAccount'
  | 'downloads'
  | 'conversions'
  | 'pwa'
  | 'embed'
  | 'android'
  | 'desktop'
  | 'firefox'

/**
 * What is released, feature by feature. The site goes live with the web app at milestone
 * M1 (docs/PLAN.md); everything still false here is marked "Coming soon": the badges, the
 * download cards and their buttons, the device suggestion and a few sentences read these
 * flags. When a stage ships a feature, flip its flag, then search the site for
 * `AVAILABLE.<name>` to review the copy around it.
 */
export const AVAILABLE: Readonly<Record<Feature, boolean>> = {
  /**
   * The experimental Lite tier: YouTube Music in the web app without FXM Connect, in browsers that
   * pass its check (stage 1.10). Stage 2.8 turns it on once Lite plays a song on the deployed site,
   * and leaves it off while Lite's kill switch is on. The sentences it changes are in
   * src/lib/tiers.ts.
   */
  lite: false,
  /**
   * The home feed with quick picks and daily mixes, made on the device from YouTube Music radio,
   * Spotify, Last.fm and ListenBrainz: stage 3.3, wired into the app by 2.9b. Endless radio is
   * `radio` (3.4).
   */
  homeFeed: true,
  /** Song radio from YouTube Music and Spotify, in the app: stages 3.3 and 3.4 (M2) */
  radio: false,
  /** A read-only sync of a Spotify account's recommendations, likes and playlists: 3.5 (M2) */
  spotifyAccount: false,
  /**
   * Downloads for offline listening, in the format the source has (the original file): 4.1,
   * wired into the app by 2.9b. Converting to other formats is `conversions`.
   */
  downloads: true,
  /** Converting downloads to FLAC, ALAC, WAV, MP3, AAC or Opus, with tags and cover art: 4.2 */
  conversions: false,
  /** Installing the web app as a PWA: 5.1 (M4) */
  pwa: true,
  /** The embeddable mini-player: 5.2 (M4) */
  embed: false,
  /** The Android APK on GitHub Releases: 6.6 (M5) */
  android: false,
  /** The desktop app for macOS, Windows and Linux: 7.5 (M6) */
  desktop: false,
  /**
   * FXM Connect as a Firefox add-on signed by Mozilla, the .xpi on GitHub Releases: R.2. Turn it
   * on once a release carries the signed file (apps/extension/README.md, "Store channels").
   */
  firefox: false,
}
