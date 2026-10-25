/**
 * The provider's versioned runtime config (`spotify-config.json`): Spotify's endpoints, the
 * default TOTP secret sources (URLs only, never a secret), the browser User-Agent for native
 * transports, and the persisted-query hash of every GraphQL operation.
 *
 * Each hash was found in Spotify's own web-player files before any code used it; the clean-room
 * log in this folder's README records where and when. An operation without a cleanly sourced hash
 * is simply absent, and calls that need it fail with `Unsupported` (`operation-unavailable`).
 * A newer config, e.g. fetched from FXM's static site, replaces the bundled one through
 * {@link loadSpotifyConfig}, so a Spotify hash change ships without an app release.
 *
 * @module
 */

import bundled from './spotify-config.json'

/** Every GraphQL operation the provider knows how to call and parse. */
export const SPOTIFY_OPERATIONS = [
  'searchDesktop',
  'searchTracks',
  'searchAlbums',
  'searchArtists',
  'searchPlaylists',
  'getTrack',
  'getAlbum',
  'queryArtistOverview',
  'queryArtistRelated',
  'fetchPlaylist',
  'home',
  'homeSection',
  'libraryV3',
  'fetchLibraryTracks',
  'profileAttributes',
] as const

/** A GraphQL operation the provider knows. */
export type SpotifyOperationName = (typeof SPOTIFY_OPERATIONS)[number]

/** One operation's persisted query. */
export interface SpotifyOperationConfig {
  /** The SHA-256 hash of the persisted query document, 64 lower-case hex digits. */
  readonly sha256Hash: string
  /** The Spotify web-player file the hash was found in, for the clean-room log. */
  readonly observedIn?: string
}

/** Spotify's endpoints. Each must be an `https:` URL on a `spotify.com` host. */
export interface SpotifyEndpoints {
  /** The web-player token endpoint (`open.spotify.com/api/token`). */
  readonly token: string
  /** The server clock (`open.spotify.com/api/server-time`), for the TOTP. */
  readonly serverTime: string
  /** The GraphQL endpoint (`api-partner.spotify.com/pathfinder/v2/query`). */
  readonly pathfinder: string
  /** The spclient origin (`spclient.wg.spotify.com`), for radio and track metadata. */
  readonly spclient: string
}

/** The whole config. */
export interface SpotifyConfig {
  /** Increases with every change; a config only replaces one with a lower or equal version. */
  readonly version: number
  /** When the config was last checked against Spotify, as ISO 8601. */
  readonly updated?: string
  /** Spotify's endpoints. */
  readonly endpoints: SpotifyEndpoints
  /**
   * Where the TOTP secret is fetched from by default, tried in order: `https:` URLs of
   * community-maintained JSON files. Users may replace them with another URL or pasted JSON.
   */
  readonly secretSources: readonly string[]
  /** The User-Agent native transports send, because Spotify refuses non-browser clients. */
  readonly userAgent: string
  /** The persisted query of each operation with a cleanly sourced hash. */
  readonly operations: Readonly<Partial<Record<SpotifyOperationName, SpotifyOperationConfig>>>
}

const HASH = /^[0-9a-f]{64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function httpsUrl(value: unknown, what: string, spotifyOnly: boolean): string {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new TypeError(`${what} is not a URL`)
  }
  if (url.protocol !== 'https:') throw new TypeError(`${what} must use https`)
  const host = url.hostname
  if (spotifyOnly && host !== 'spotify.com' && !host.endsWith('.spotify.com')) {
    throw new TypeError(`${what} must be on a spotify.com host`)
  }
  if (spotifyOnly && host === 'api.spotify.com') {
    // The official Web API answers web-player tokens with 429: FXM never calls it.
    throw new TypeError(`${what} must not be the official Web API (api.spotify.com)`)
  }
  return url.href.replace(/\/$/u, '')
}

/**
 * Checks a config, e.g. one fetched at run time, and returns a frozen copy. Unknown operation
 * names and fields are ignored, so an older app accepts a newer config.
 *
 * @throws TypeError when a field is missing or malformed: a version that is not a positive
 * integer, an endpoint that is not `https:` on a `spotify.com` host (the bearer token goes
 * there) or that is the official Web API, a secret source that is not `https:`, an empty
 * User-Agent, or a hash that is not 64 lower-case hex digits.
 */
export function parseSpotifyConfig(value: unknown): SpotifyConfig {
  if (!isRecord(value)) throw new TypeError('The Spotify config must be an object')
  const { version, updated, endpoints, secretSources, userAgent, operations } = value
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new TypeError('The Spotify config version must be a positive integer')
  }
  if (!isRecord(endpoints)) throw new TypeError('The Spotify config needs endpoints')
  if (!Array.isArray(secretSources)) throw new TypeError('secretSources must be a list of URLs')
  if (typeof userAgent !== 'string' || userAgent.trim() === '') {
    throw new TypeError('userAgent must be a non-empty string')
  }
  if (!isRecord(operations)) throw new TypeError('operations must be an object')
  const parsedOperations: Partial<Record<SpotifyOperationName, SpotifyOperationConfig>> = {}
  for (const name of SPOTIFY_OPERATIONS) {
    if (!Object.hasOwn(operations, name)) continue
    const entry = operations[name]
    if (!isRecord(entry) || typeof entry.sha256Hash !== 'string' || !HASH.test(entry.sha256Hash)) {
      throw new TypeError(`The hash of ${name} must be 64 lower-case hex digits`)
    }
    parsedOperations[name] = Object.freeze({
      sha256Hash: entry.sha256Hash,
      ...(typeof entry.observedIn === 'string' ? { observedIn: entry.observedIn } : {}),
    })
  }
  return Object.freeze({
    version: version as number,
    ...(typeof updated === 'string' ? { updated } : {}),
    endpoints: Object.freeze({
      token: httpsUrl(endpoints.token, 'endpoints.token', true),
      serverTime: httpsUrl(endpoints.serverTime, 'endpoints.serverTime', true),
      pathfinder: httpsUrl(endpoints.pathfinder, 'endpoints.pathfinder', true),
      spclient: httpsUrl(endpoints.spclient, 'endpoints.spclient', true),
    }),
    secretSources: Object.freeze(
      secretSources.map((url, index) => httpsUrl(url, `secretSources[${index}]`, false)),
    ),
    userAgent: userAgent.trim(),
    operations: Object.freeze(parsedOperations),
  })
}

/** The config bundled with this build. */
export const DEFAULT_SPOTIFY_CONFIG: SpotifyConfig = parseSpotifyConfig(bundled)

/**
 * The config to use: `candidate` when it is valid and at least as new as `fallback` (by
 * `version`), otherwise `fallback`. Never throws, so a broken download cannot break Spotify.
 */
export function loadSpotifyConfig(
  candidate: unknown,
  fallback: SpotifyConfig = DEFAULT_SPOTIFY_CONFIG,
): SpotifyConfig {
  try {
    const config = parseSpotifyConfig(candidate)
    return config.version >= fallback.version ? config : fallback
  } catch {
    return fallback
  }
}
