/**
 * Site-wide constants. astro.config.ts reads SITE_URL from here, so the canonical
 * origin, the sitemap and robots.txt always agree.
 */

/** Production origin, without a trailing slash. */
export const SITE_URL = 'https://fxm-music.pages.dev'

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
