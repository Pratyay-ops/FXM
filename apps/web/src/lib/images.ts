/**
 * Which images the web app may request. Two rules, so that no image request leaves the page that
 * shouldn't:
 *
 * - **The policy.** Only images the deployed policy's `img-src` allows (`APP_SERVICES` in
 *   scripts/build-dist/src/policies.ts): the app's own origin, `data:` and `blob:` URLs, and the
 *   image hosts of the services it shows images from. Anything else, such as a plugin's cover on
 *   a host of its own (stage 8.3), would only end in a policy violation, so it is never asked
 *   for: the seeded placeholder shows instead.
 * - **The Spotify switch.** Spotify's image hosts only while Spotify is switched on. Settings and
 *   the site say "Off: FXM doesn't contact Spotify", so with it off the covers of Spotify songs
 *   and playlists already in the library (an import, the account sync's copies) show the
 *   placeholder too, and Save to device leaves them out of saved files.
 *
 * @module
 */

import { jamendoOffered } from './free-sources'

/**
 * Hosts the app's `img-src` allows, as `scripts/build-dist/src/policies.ts` lists them: an exact
 * host, or `*.` and a domain for its sub-domains (not the domain itself), HTTPS only. Keep the two
 * lists in step: a host missing here only shows a placeholder, one missing there a violation.
 */
export const POLICY_IMAGE_HOSTS: readonly string[] = [
  // YouTube and YouTube Music: thumbnails, covers and channel images.
  '*.ytimg.com',
  '*.googleusercontent.com',
  '*.ggpht.com',
  // Spotify's covers, mosaics and playlist images.
  '*.scdn.co',
  '*.spotifycdn.com',
  'archive.org',
  '*.archive.org',
  'coverartarchive.org',
]

/** Jamendo's images, allowed only in a build that offers Jamendo (its `client_id`). */
export const JAMENDO_IMAGE_HOSTS: readonly string[] = ['*.jamendo.com']

/** Spotify's image hosts: `i.scdn.co`, `mosaic.scdn.co`, `image-cdn-ak.spotifycdn.com`, … */
export const SPOTIFY_IMAGE_HOSTS: readonly string[] = ['*.scdn.co', '*.spotifycdn.com']

/** Whether `hostname` is `pattern`, or for `*.domain` one of the domain's sub-domains. */
function matchesHost(hostname: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return hostname === pattern
  const suffix = pattern.slice(1)
  return hostname.length > suffix.length && hostname.endsWith(suffix)
}

/** `url` parsed against the page's address, or `undefined` when it isn't a URL. */
function parse(url: string): URL | undefined {
  try {
    return new URL(url, globalThis.location?.href ?? 'https://fxmusic.pages.dev/app/')
  } catch {
    return undefined
  }
}

/** Whether `url` is an image on one of Spotify's image hosts. */
export function isSpotifyImageUrl(url: string): boolean {
  const parsed = parse(url)
  return (
    parsed !== undefined && SPOTIFY_IMAGE_HOSTS.some((host) => matchesHost(parsed.hostname, host))
  )
}

/**
 * Whether the app's policy lets the page load `url` as an image: a `data:` or `blob:` URL, one of
 * the app's own origin, or an HTTPS URL on one of {@link POLICY_IMAGE_HOSTS} (Jamendo's in a build
 * that offers it), on the default port and without credentials.
 */
export function isPolicyImageUrl(url: string, jamendo: boolean = jamendoOffered()): boolean {
  const parsed = parse(url)
  if (parsed === undefined) return false
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true
  if (globalThis.location !== undefined && parsed.origin === globalThis.location.origin) return true
  if (parsed.protocol !== 'https:' || parsed.port !== '') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  const hosts = jamendo ? [...POLICY_IMAGE_HOSTS, ...JAMENDO_IMAGE_HOSTS] : POLICY_IMAGE_HOSTS
  return hosts.some((host) => matchesHost(parsed.hostname, host))
}

/**
 * `url` when the app may show it now, else `undefined` (the placeholder then shows): the policy
 * must allow it, and a Spotify image needs Spotify switched on.
 */
export function shownImageUrl(
  url: string | undefined,
  spotifyEnabled: boolean,
  jamendo: boolean = jamendoOffered(),
): string | undefined {
  if (url === undefined || url === '') return undefined
  if (!spotifyEnabled && isSpotifyImageUrl(url)) return undefined
  return isPolicyImageUrl(url, jamendo) ? url : undefined
}

/** The images of `artwork` the app may show now (see {@link shownImageUrl}). */
export function shownArtwork<T extends { readonly url: string }>(
  artwork: readonly T[],
  spotifyEnabled: boolean,
  jamendo: boolean = jamendoOffered(),
): T[] {
  return artwork.filter((image) => shownImageUrl(image.url, spotifyEnabled, jamendo) !== undefined)
}

/** Reads the app's Spotify switch; off until the app's sources say where it is. */
let readSpotifySwitch: () => boolean = () => false

/**
 * Tells this module where the app's Spotify switch is: the app's sources (`sources-context.tsx`)
 * do when they load, before anything is shown. Until then Spotify's images count as switched off.
 */
export function setAppSpotifySwitch(read: () => boolean): void {
  readSpotifySwitch = read
}

/**
 * Whether the app may load `url` as an image now, by the app's own Spotify switch: for what runs
 * outside React, such as the system's media controls and the covers of saved files.
 */
export function appShowsImage(url: string): boolean {
  return shownImageUrl(url, readSpotifySwitch()) !== undefined
}
