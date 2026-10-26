/**
 * The provider's versioned runtime config (`spotify-config.json`): Spotify's endpoints, the
 * default TOTP secret sources (URLs only, never a secret), the browser User-Agent for native
 * transports, and the persisted-query hash of every GraphQL operation.
 *
 * Each hash was found in Spotify's own web-player files before any code used it; the clean-room
 * log in this folder's README records where and when. An operation without a cleanly sourced hash
 * is simply absent, and calls that need it fail with `Unsupported` (`operation-unsupported`).
 * A newer config, e.g. fetched from FXM's static site, replaces the bundled one through
 * {@link loadSpotifyConfig} and `SpotifyProvider.setConfig`, so a Spotify hash change ships
 * without an app release.
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
   * community-maintained JSON files on {@link SPOTIFY_SECRET_SOURCE_HOSTS}. Users may replace
   * them with another URL or pasted JSON in Settings.
   */
  readonly secretSources: readonly string[]
  /** The User-Agent native transports send, because Spotify refuses non-browser clients. */
  readonly userAgent: string
  /** The persisted query of each operation with a cleanly sourced hash. */
  readonly operations: Readonly<Partial<Record<SpotifyOperationName, SpotifyOperationConfig>>>
}

/**
 * The only hosts a config may name as secret sources: GitHub's raw-file hosts, where the
 * community secret lists live. A config can therefore not make every FXM install contact an
 * arbitrary host. A secret source the user enters in Settings may be on any public host.
 */
export const SPOTIFY_SECRET_SOURCE_HOSTS: readonly string[] = Object.freeze([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
])

const HASH = /^[0-9a-f]{64}$/u
/** Printable ASCII only: a header value must not carry control characters or line breaks. */
const USER_AGENT = /^[\x20-\x7e]{1,512}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What {@link checkHttpsUrl} requires beyond `https:` and no user name or password. */
export interface UrlRules {
  /** `spotify`: a `spotify.com` host other than the official Web API; or exactly these hosts. */
  hosts?: 'spotify' | readonly string[]
  /** Refuse `localhost` and IP literals, e.g. a home router's admin page. */
  publicHost?: boolean
}

function isLocalOrIpHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('[') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)
  )
}

/**
 * Checks a URL from a config or from the user's settings and returns it normalized (without a
 * trailing slash). It must be `https:`, carry no user name or password, and follow `rules`.
 *
 * @throws TypeError naming `what` when it does not.
 */
export function checkHttpsUrl(value: unknown, what: string, rules: UrlRules = {}): string {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new TypeError(`${what} is not a URL`)
  }
  if (url.protocol !== 'https:') throw new TypeError(`${what} must use https`)
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(`${what} must not contain a user name or password`)
  }
  const host = url.hostname
  if (rules.publicHost && isLocalOrIpHost(host)) {
    throw new TypeError(`${what} must name a public host, not localhost or an IP address`)
  }
  if (rules.hosts === 'spotify') {
    if (host !== 'spotify.com' && !host.endsWith('.spotify.com')) {
      throw new TypeError(`${what} must be on a spotify.com host`)
    }
    if (host === 'api.spotify.com') {
      // The official Web API answers web-player tokens with 429: FXM never calls it.
      throw new TypeError(`${what} must not be the official Web API (api.spotify.com)`)
    }
  } else if (rules.hosts !== undefined && !rules.hosts.includes(host)) {
    throw new TypeError(`${what} must be on one of ${rules.hosts.join(', ')}`)
  }
  return url.href.replace(/\/$/u, '')
}

/**
 * Checks a config, e.g. one fetched at run time, and returns a frozen copy. Unknown operation
 * names and fields are ignored, so an older app accepts a newer config.
 *
 * @throws TypeError when a field is missing or malformed: a version that is not a positive
 * integer, an endpoint that is not `https:` on a `spotify.com` host (the bearer token goes
 * there) or that is the official Web API, a secret source that is not `https:` on
 * {@link SPOTIFY_SECRET_SOURCE_HOSTS}, a User-Agent that is not 1 to 512 printable ASCII
 * characters, or a hash that is not 64 lower-case hex digits. No URL may carry a user name or
 * password.
 */
export function parseSpotifyConfig(value: unknown): SpotifyConfig {
  if (!isRecord(value)) throw new TypeError('The Spotify config must be an object')
  const { version, updated, endpoints, secretSources, userAgent, operations } = value
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new TypeError('The Spotify config version must be a positive integer')
  }
  if (!isRecord(endpoints)) throw new TypeError('The Spotify config needs endpoints')
  if (!Array.isArray(secretSources)) throw new TypeError('secretSources must be a list of URLs')
  const agent = typeof userAgent === 'string' ? userAgent.trim() : ''
  if (!USER_AGENT.test(agent)) {
    throw new TypeError('userAgent must be 1 to 512 printable ASCII characters')
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
  const spotify = { hosts: 'spotify' } as const
  return Object.freeze({
    version: version as number,
    ...(typeof updated === 'string' ? { updated } : {}),
    endpoints: Object.freeze({
      token: checkHttpsUrl(endpoints.token, 'endpoints.token', spotify),
      serverTime: checkHttpsUrl(endpoints.serverTime, 'endpoints.serverTime', spotify),
      pathfinder: checkHttpsUrl(endpoints.pathfinder, 'endpoints.pathfinder', spotify),
      spclient: checkHttpsUrl(endpoints.spclient, 'endpoints.spclient', spotify),
    }),
    secretSources: Object.freeze(
      secretSources.map((url, index) =>
        checkHttpsUrl(url, `secretSources[${index}]`, { hosts: SPOTIFY_SECRET_SOURCE_HOSTS }),
      ),
    ),
    userAgent: agent,
    operations: Object.freeze(parsedOperations),
  })
}

/** The config bundled with this build. */
export const DEFAULT_SPOTIFY_CONFIG: SpotifyConfig = parseSpotifyConfig(bundled)

/**
 * The config to use: `candidate` when it is valid and at least as new as `fallback` (by
 * `version`), otherwise `fallback`. Never throws, so a broken download cannot break Spotify.
 * Apply the result with `SpotifyProvider.setConfig`.
 *
 * The checks bound what a config can do (Spotify hosts only for the endpoints, GitHub's raw-file
 * hosts only for the secret sources, a plain User-Agent), but they cannot tell a genuine config
 * from a forged one. The web app loads the config from its own origin, like its code. The
 * desktop and Android apps must verify the config's signature (stage 1.13) before they pass it
 * in, and keep the bundled config when the check fails.
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
