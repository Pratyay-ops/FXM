/**
 * The hosts FXM contacts, and how each is reached. Every transport classifies a URL here first
 * and refuses anything else with a `TransportError` (`unknown-host`), so the table doubles as
 * the network allow-list: providers cannot send a request to a host that is not listed (or that
 * the user did not add in Settings, see the transports' `userHosts`).
 *
 * Redirects are checked too. Desktop, Android and Node follow them in the transport, hop by hop,
 * so no request ever leaves the table. In a browser the browser follows them itself, so the
 * transport refuses a response that ended outside the table; the web app's content security
 * policy (`connect-src`) is what keeps the page from contacting such a host in the first place.
 *
 * @module
 */

import { TransportError } from './errors'

/** Every {@link HostClass}. */
export const HOST_CLASSES = ['open', 'innertube', 'googlevideo', 'spotify', 'lastfm-web'] as const

/**
 * How a host can be reached from a web page:
 *
 * - `open`: CORS-friendly APIs and images. A page fetches them directly on every tier
 * - `innertube`: YouTube's API hosts. FXM Connect or the Lite tier's sandbox on the web
 * - `googlevideo`: YouTube's media servers. `<audio src>` plays them anywhere, but reading the
 *   bytes (downloads, probes, MediaSource) takes FXM Connect on the web
 * - `spotify`: Spotify's web-player hosts. FXM Connect on the web
 * - `lastfm-web`: Last.fm's keyless station JSON on www.last.fm. FXM Connect on the web
 *
 * Desktop, Android and Node reach every class directly.
 */
export type HostClass = (typeof HOST_CLASSES)[number]

/** One row of {@link HOST_RULES}. */
export interface HostRule {
  /**
   * An exact host name, or `*.` and a domain, which matches every sub-domain of that domain at
   * any depth but not the domain itself.
   */
  readonly host: string
  /** How the host is reached. */
  readonly hostClass: HostClass
  /** What the host serves, for messages. */
  readonly service: string
  /**
   * When set, only paths starting with this prefix belong to the rule. Other paths on the host
   * are refused, because nothing makes them readable from a page.
   */
  readonly pathPrefix?: string
}

/**
 * The hosts FXM contacts. Only `https:` URLs on the default port, without credentials, match.
 * The order carries no meaning: no two rules match the same host.
 */
export const HOST_RULES: readonly HostRule[] = [
  { host: 'musicbrainz.org', hostClass: 'open', service: 'MusicBrainz' },
  { host: 'coverartarchive.org', hostClass: 'open', service: 'Cover Art Archive' },
  { host: 'api.listenbrainz.org', hostClass: 'open', service: 'ListenBrainz' },
  { host: 'labs.api.listenbrainz.org', hostClass: 'open', service: 'ListenBrainz Labs' },
  { host: 'ws.audioscrobbler.com', hostClass: 'open', service: 'the Last.fm API' },
  { host: 'lrclib.net', hostClass: 'open', service: 'LRCLIB' },
  { host: 'archive.org', hostClass: 'open', service: 'Internet Archive' },
  { host: '*.archive.org', hostClass: 'open', service: 'Internet Archive' },
  { host: 'api.jamendo.com', hostClass: 'open', service: 'Jamendo' },
  { host: '*.jamendo.com', hostClass: 'open', service: 'Jamendo' },
  { host: 'itunes.apple.com', hostClass: 'open', service: 'iTunes Search' },
  { host: 'sponsor.ajay.app', hostClass: 'open', service: 'SponsorBlock' },
  { host: 'i.ytimg.com', hostClass: 'open', service: 'YouTube thumbnails' },
  { host: '*.ggpht.com', hostClass: 'open', service: 'YouTube images' },
  { host: 'i.scdn.co', hostClass: 'open', service: 'Spotify images' },
  // BotGuard's interpreter, for the experimental YouTube rungs of stage 1.11. It sends no CORS
  // headers, so only the desktop and Android apps can read it.
  {
    host: 'www.google.com',
    hostClass: 'open',
    service: "Google's BotGuard",
    pathPrefix: '/js/th/',
  },
  { host: 'www.youtube.com', hostClass: 'innertube', service: 'YouTube' },
  { host: 'music.youtube.com', hostClass: 'innertube', service: 'YouTube Music' },
  { host: 'youtubei.googleapis.com', hostClass: 'innertube', service: 'YouTube' },
  { host: '*.googlevideo.com', hostClass: 'googlevideo', service: 'YouTube media' },
  { host: 'open.spotify.com', hostClass: 'spotify', service: 'Spotify' },
  { host: 'clienttoken.spotify.com', hostClass: 'spotify', service: 'Spotify' },
  { host: 'api-partner.spotify.com', hostClass: 'spotify', service: 'Spotify' },
  { host: 'spclient.wg.spotify.com', hostClass: 'spotify', service: 'Spotify' },
  {
    host: 'www.last.fm',
    hostClass: 'lastfm-web',
    service: 'Last.fm stations',
    pathPrefix: '/player/station/',
  },
]

/** The path prefix of InnerTube API calls, e.g. `/youtubei/v1/search`. */
export const INNERTUBE_API_PREFIX = '/youtubei/v1/'

/** Whether `hostname` matches a {@link HostRule.host} pattern. */
export function matchesHost(hostname: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return hostname === pattern
  const suffix = pattern.slice(1)
  return hostname.length > suffix.length && hostname.endsWith(suffix)
}

/** Whether a URL is one FXM may send at all: `https:`, the default port and no credentials. */
export function isPlainHttpsUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === ''
}

/** The rule a URL falls under, or `undefined` when FXM does not contact it. */
export function findHostRule(url: URL): HostRule | undefined {
  if (!isPlainHttpsUrl(url)) return undefined
  const rule = HOST_RULES.find((candidate) => matchesHost(url.hostname, candidate.host))
  if (rule?.pathPrefix !== undefined && !url.pathname.startsWith(rule.pathPrefix)) return undefined
  return rule
}

/**
 * The rule of a service FXM itself contacts on `hostname`, whatever the path and the port, or
 * `undefined` when FXM contacts no service there: for code that must keep hosts of its own apart
 * from FXM's services, such as the hosts a runtime plugin declares (stage 8.3). Unlike
 * {@link findHostRule}, a rule with a `pathPrefix` counts for every path of its host.
 */
export function serviceHostRule(hostname: string): HostRule | undefined {
  const name = hostname.trim().toLowerCase()
  return HOST_RULES.find((candidate) => matchesHost(name, candidate.host))
}

/**
 * The {@link HostClass} of a URL. Throws a `TransportError` (an `Unsupported` `FxmError`) when the
 * URL is not an absolute URL that FXM contacts.
 */
export function classifyUrl(input: string | URL): HostClass {
  const url = parseUrl(input)
  const rule = findHostRule(url)
  if (rule === undefined) throw unknownHost(url)
  return rule.hostClass
}

/** Whether a URL is an InnerTube API call (`/youtubei/v1/…` on a YouTube API host). */
export function isInnerTubeApiUrl(input: string | URL): boolean {
  let url: URL
  try {
    url = parseUrl(input)
  } catch {
    return false
  }
  return (
    findHostRule(url)?.hostClass === 'innertube' && url.pathname.startsWith(INNERTUBE_API_PREFIX)
  )
}

/** Parses an absolute URL, rejecting anything else with a `TransportError` (`bad-request`). */
export function parseUrl(input: string | URL): URL {
  try {
    return new URL(input)
  } catch (cause) {
    throw new TransportError('bad-request', `Not an absolute URL: ${String(input)}`, { cause })
  }
}

/** The error for a URL that FXM does not contact: a `TransportError` (`unknown-host`). */
export function unknownHost(url: URL): TransportError {
  return new TransportError(
    'unknown-host',
    `FXM does not contact ${url.protocol}//${url.host}${url.pathname}: it is not on the list of known services`,
  )
}
