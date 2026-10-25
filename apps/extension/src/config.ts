/**
 * Single source of truth for FXM Connect. The manifests, the DNR rulesets, the content script,
 * the background bridge and the options page all take their FXM origins from here, so the list
 * is never duplicated.
 */

/** Name shown in the browser's extension list. */
export const EXTENSION_NAME = 'FXM Connect'

/** Pages of the deployed FXM web app. Every rule, the content script and the bridge are scoped to them. */
export const PRODUCTION_ORIGINS = ['https://fxm-music.pages.dev'] as const

/**
 * Local web app servers (the Vite dev server and `vite preview`). Only the development build
 * (`FXM_EXTENSION_DEV=1`) allows them.
 */
export const DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'] as const

/** Where the options page sends people. */
export const APP_URL = 'https://fxm-music.pages.dev/app/'

/** `storage.local` key of the "Use my Spotify login from this browser" toggle (default off). */
export const SPOTIFY_LOGIN_KEY = 'spotifyLogin'

/**
 * Capabilities announced in the `fxm-connect:pong` reply. The first four name the groups of
 * CORS rules (a test checks them against rules.ts); `spotify-server-time` is the bridge's
 * credential-free relay.
 */
export const FEATURES = [
  'youtube',
  'googlevideo',
  'spotify',
  'lastfm',
  'spotify-server-time',
] as const

/** Feature added to the pong only while "Use my Spotify login from this browser" is on. */
export const SPOTIFY_LOGIN_FEATURE = 'spotify-login'

/** The FXM origins of a build variant, production first. */
export function fxmOrigins(dev: boolean): readonly string[] {
  return dev ? [...PRODUCTION_ORIGINS, ...DEVELOPMENT_ORIGINS] : [...PRODUCTION_ORIGINS]
}
