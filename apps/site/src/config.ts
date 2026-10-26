/**
 * Site-wide constants. astro.config.ts reads SITE_URL from here, so the canonical
 * origin, the sitemap and robots.txt always agree.
 */

/** Production origin, without a trailing slash. */
export const SITE_URL = 'https://fxmusic.pages.dev'

/** The web player. It is built by apps/web and served next to this site at deploy time. */
export const APP_PATH = '/app/'

/**
 * The licences of the open-source packages the site and the apps bundle, which `make dist`
 * writes next to them at deploy time (scripts/build-dist/README.md).
 */
export const NOTICES_PATH = '/third-party-notices.txt'

/**
 * Paths that exist in production but are not part of this site's build output. The
 * build-time link check skips them (see src/lib/build-check.ts).
 */
export const EXTERNAL_PATHS = [APP_PATH, NOTICES_PATH] as const

/** <meta name="theme-color"> per theme: the page background (tokens.test.ts keeps them in sync). */
export const THEME_COLOR = { dark: '#0b0b0f', light: '#f6f6f8' } as const

export const REPO_URL = 'https://github.com/Pratyay-ops/FXM'
export const RELEASES_URL = `${REPO_URL}/releases/latest`
export const ISSUES_URL = `${REPO_URL}/issues`
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

export type Feature =
  | 'lite'
  | 'jamendo'
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
 * The environment the site is built in: Node's while Astro renders the pages (and in the tests),
 * none in the browser. Flags that depend on how the deploy builds the site read it, so they
 * matter to the pages' HTML only: a page's script in the browser sees them off.
 */
const BUILD_ENV: Readonly<Record<string, string | undefined>> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

/**
 * What is released, feature by feature. The site goes live with the web app at milestone
 * M1 (docs/PLAN.md); everything still false here is marked "Coming soon": the badges, the
 * download cards and their buttons, the device suggestion and a few sentences read these
 * flags. When a stage ships a feature, flip its flag, then search the site for
 * `AVAILABLE.<name>` to review the copy around it, and update the feature list in the
 * repository's README.md, which marks the same features "(coming soon)".
 */
export const AVAILABLE: Readonly<Record<Feature, boolean>> = {
  /**
   * The experimental Lite tier: YouTube Music in the web app without FXM Connect, in browsers that
   * pass its check (stage 1.10). On since Lite played a song on the deployed site in Chromium on
   * 2026-10-26 (scripts/build-dist/README.md, "Lite on the deployed site", which says how to
   * check again). Turn it off while Lite's kill switch is on. The sentences it changes are in
   * src/lib/tiers.ts.
   */
  lite: true,
  /**
   * Free music from Jamendo (stage 1.6), which needs FXM's public Jamendo client_id: the deploy
   * passes the repository variable FXM_JAMENDO_CLIENT_ID to make dist as
   * VITE_FXM_JAMENDO_CLIENT_ID once the owner has registered one and confirmed Jamendo's terms
   * (packages/sources/src/jamendo/README.md). The same variable turns Jamendo on in the web app
   * and in its policy, so all three follow it together. The sentences it changes are in
   * src/lib/tiers.ts, the privacy page and the lossless lines of Features.astro and Faq.astro.
   */
  jamendo: Boolean(BUILD_ENV.VITE_FXM_JAMENDO_CLIENT_ID?.trim()),
  /**
   * The home feed with quick picks and daily mixes, made on the device from YouTube Music radio,
   * Spotify, Last.fm and ListenBrainz: stage 3.3, wired into the app by 2.9b. Autoplay is `radio`
   * (3.4).
   */
  homeFeed: true,
  /**
   * Autoplay, the endless radio of stage 3.4: when the queue runs low, the app adds songs like the
   * last plays, from YouTube Music's radio (and Spotify's, while Spotify is on). It isn't a station
   * on Home, and the app has no radio to start from a song, so the copy names neither. On since
   * autoplay kept a queue going in the Lite tier of the composed app, in Chromium, on 2026-10-26
   * (scripts/build-dist/README.md, "Autoplay in the Lite tier", which says how to check again).
   */
  radio: true,
  /** A read-only sync of a Spotify account's recommendations, likes and playlists: 3.5 (M2) */
  spotifyAccount: true,
  /**
   * Downloads for offline listening, in the format the source has (the original file): 4.1,
   * wired into the app by 2.9b. Saving a copy in another format is `conversions`.
   */
  downloads: true,
  /**
   * Saving a downloaded song as FLAC, ALAC, WAV, MP3, AAC or Opus, with tags, cover art and
   * lyrics: 4.2. The download stays the original file; the app's "Save to device…" converts a
   * copy on the device with FXM's ffmpeg core, which make dist ships at /app/ffmpeg/. On since a
   * download saved as FLAC that way in Chromium, from make dist served with its real headers, on
   * 2026-10-26 (apps/web/e2e/save.spec.ts says how to check again).
   */
  conversions: true,
  /** Installing the web app as a PWA: 5.1 (M4) */
  pwa: true,
  /**
   * The embeddable mini-player: 5.2 (M4), whose code the app's Share entry hands out (the app's
   * `RELEASED.embed` turns that on with this flag). On since the production embed played a song in
   * the Lite tier inside a page on another site, in Chromium, on 2026-10-26
   * (scripts/build-dist/README.md, "The embed on the deployed site", which says how to check
   * again). The sentences it changes are the embed's card in Features.astro (`embedCardText` in
   * src/lib/tiers.ts) and the privacy page's section on players on other websites.
   */
  embed: true,
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
