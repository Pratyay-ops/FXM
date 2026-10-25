/**
 * Static declarativeNetRequest (DNR) rules, generated from the typed specs below for every FXM
 * origin. They only rewrite headers: no rule contains YouTube or Spotify logic, so the web app
 * can follow changes at those services by redeploying the static site.
 *
 * Behaviour these rules answer, measured against the live services in October 2026 (the browser
 * side was verified in Chrome for Testing 156 and Firefox 158):
 * - InnerTube (www.youtube.com, music.youtube.com, youtubei.googleapis.com) answers any foreign
 *   Origin with 403 and no CORS headers, and 200 for a YouTube Origin or none. Preflights are
 *   stricter: an OPTIONS request gets 403 with a foreign Origin or none, and 400 with the host's
 *   own origin or without Access-Control-Request-Method. With the other YouTube origin
 *   (https://music.youtube.com at www.youtube.com and the reverse; youtubei.googleapis.com takes
 *   either) it gets 200 with CORS headers. So requests carry the host's own YouTube Origin and
 *   preflights the other one, and preflighted requests (JSON content type, X-Goog-* and
 *   X-YouTube-* headers) work.
 * - googlevideo serves media to any Origin but only sends Access-Control-Allow-Origin to YouTube
 *   origins. It answers a preflight from a YouTube Origin with 204 and from any other Origin
 *   with 400, so the Origin is rewritten on OPTIONS requests only. A media URL may redirect
 *   (302) to another googlevideo host. After such a cross-origin redirect the browser sends
 *   `Origin: null` and expects `Access-Control-Allow-Origin: null`, which no rule can give
 *   without also breaking requests that were not redirected: fetch(), MediaSource and downloads
 *   fail there, while a plain <audio src> still plays (see the README).
 * - open.spotify.com/api/token, /api/server-time and clienttoken.spotify.com send no CORS
 *   headers but answer OPTIONS with 200. api-partner and spclient echo any Origin today.
 *
 * Every rule also strips cookies from the request and Set-Cookie and
 * Access-Control-Allow-Credentials from the response, so a page can never act as the user's
 * logged-in account through these rules. The page fetches with `credentials: 'omit'` anyway.
 */
import { originHost, rulesetId } from './origins.ts'

/** DNR resource types the rules use. */
export type ResourceType = 'xmlhttprequest' | 'media' | 'other'

/** DNR request methods the rules use. */
export type RequestMethod = 'options'

/** A header modification. `value` is present exactly when `operation` is `set`. */
export type HeaderOperation =
  | { header: string; operation: 'set'; value: string }
  | { header: string; operation: 'remove' }

/** The subset of a DNR rule FXM Connect generates. */
export interface DnrRule {
  id: number
  priority: number
  condition: {
    initiatorDomains: string[]
    requestDomains?: string[]
    urlFilter?: string
    resourceTypes: ResourceType[]
    requestMethods?: RequestMethod[]
    excludedRequestMethods?: RequestMethod[]
  }
  action: {
    type: 'modifyHeaders'
    requestHeaders: HeaderOperation[]
    responseHeaders: HeaderOperation[]
  }
}

/** Groups of rules, announced to the web app as features. */
export type RuleFeature = 'youtube' | 'googlevideo' | 'spotify' | 'lastfm'

/** Typed description of one CORS rule, instantiated once per FXM origin. */
export interface CorsRuleSpec {
  /** Stable name, used in tests and documentation. */
  name: string
  feature: RuleFeature
  /** The host_permissions entry that covers every URL the rule can match. */
  hostPermission: string
  /** Match by host (sub-domains included) or by URL filter, never both. */
  target: { requestDomains: readonly string[] } | { urlFilter: string }
  resourceTypes: readonly ResourceType[]
  requestMethods?: readonly RequestMethod[]
  excludedRequestMethods?: readonly RequestMethod[]
  /** Rewrites the request's Origin to this value. */
  requestOrigin?: string
  /** Also sets Referer to `requestOrigin` + '/'. */
  referer?: boolean
  allowMethods?: string
  allowHeaders?: readonly string[]
  exposeHeaders?: readonly string[]
  maxAgeSeconds?: number
}

const YOUTUBE_ALLOW_HEADERS = [
  'content-type',
  'authorization',
  'x-goog-visitor-id',
  'x-youtube-client-name',
  'x-youtube-client-version',
  'x-goog-api-format-version',
  'x-origin',
  'x-youtube-bootstrap-logged-in',
  'x-browser-validation',
] as const

const SPOTIFY_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'client-token',
  'app-platform',
  'spotify-app-version',
  'accept',
] as const

const MEDIA_EXPOSE_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'content-type']

const API_TYPES: readonly ResourceType[] = ['xmlhttprequest', 'other']

const YOUTUBE = 'https://www.youtube.com'
const YOUTUBE_MUSIC = 'https://music.youtube.com'

/**
 * The two rules of an InnerTube host: requests get `origin`, CORS preflights get
 * `preflightOrigin`, the YouTube origin InnerTube accepts preflights from (see above).
 */
function innertube(
  name: string,
  host: string,
  origin: string,
  preflightOrigin: string,
): CorsRuleSpec[] {
  const shared: Omit<CorsRuleSpec, 'name'> = {
    feature: 'youtube',
    hostPermission: `https://${host}/*`,
    target: { requestDomains: [host] },
    resourceTypes: API_TYPES,
    referer: true,
    allowMethods: 'GET, POST, OPTIONS',
    allowHeaders: YOUTUBE_ALLOW_HEADERS,
    exposeHeaders: ['content-length'],
    maxAgeSeconds: 600,
  }
  return [
    { ...shared, name, excludedRequestMethods: ['options'], requestOrigin: origin },
    {
      ...shared,
      name: `${name}-preflight`,
      requestMethods: ['options'],
      requestOrigin: preflightOrigin,
    },
  ]
}

function spotify(
  name: string,
  hostPermission: string,
  target: CorsRuleSpec['target'],
  rewriteOrigin: boolean,
): CorsRuleSpec {
  return {
    name,
    feature: 'spotify',
    hostPermission,
    target,
    resourceTypes: API_TYPES,
    ...(rewriteOrigin ? { requestOrigin: 'https://open.spotify.com', referer: true } : {}),
    allowMethods: 'GET, POST, OPTIONS',
    allowHeaders: SPOTIFY_ALLOW_HEADERS,
    maxAgeSeconds: 600,
  }
}

/** Every CORS rule, in rule-ID order. */
export const CORS_RULE_SPECS: readonly CorsRuleSpec[] = [
  ...innertube('youtube-www', 'www.youtube.com', YOUTUBE, YOUTUBE_MUSIC),
  ...innertube('youtube-music', 'music.youtube.com', YOUTUBE_MUSIC, YOUTUBE),
  ...innertube('youtube-api', 'youtubei.googleapis.com', YOUTUBE, YOUTUBE),
  {
    // Media bytes for fetch(), MediaSource and downloads. <audio src> already plays without the
    // extension (googlevideo sends Cross-Origin-Resource-Policy: cross-origin). The Origin is
    // left alone: googlevideo serves any Origin, it only withholds the CORS headers. Responses
    // after a redirect to another googlevideo host stay unreadable (see above).
    name: 'googlevideo-media',
    feature: 'googlevideo',
    hostPermission: 'https://*.googlevideo.com/*',
    target: { requestDomains: ['googlevideo.com'] },
    resourceTypes: ['xmlhttprequest', 'media'],
    excludedRequestMethods: ['options'],
    exposeHeaders: MEDIA_EXPOSE_HEADERS,
  },
  {
    // Preflights (for example a POST with a protobuf body): googlevideo answers a foreign Origin
    // with 400 and a YouTube Origin with 204 plus its own allow lists, so only OPTIONS requests
    // get a YouTube Origin.
    name: 'googlevideo-preflight',
    feature: 'googlevideo',
    hostPermission: 'https://*.googlevideo.com/*',
    target: { requestDomains: ['googlevideo.com'] },
    resourceTypes: API_TYPES,
    requestMethods: ['options'],
    requestOrigin: YOUTUBE,
    exposeHeaders: MEDIA_EXPOSE_HEADERS,
  },
  spotify(
    'spotify-token',
    'https://open.spotify.com/*',
    { urlFilter: '|https://open.spotify.com/api/token^' },
    true,
  ),
  spotify(
    'spotify-server-time',
    'https://open.spotify.com/*',
    { urlFilter: '|https://open.spotify.com/api/server-time^' },
    true,
  ),
  spotify(
    'spotify-clienttoken',
    'https://clienttoken.spotify.com/*',
    { requestDomains: ['clienttoken.spotify.com'] },
    true,
  ),
  spotify(
    'spotify-partner',
    'https://api-partner.spotify.com/*',
    { requestDomains: ['api-partner.spotify.com'] },
    false,
  ),
  spotify(
    'spotify-spclient',
    'https://spclient.wg.spotify.com/*',
    { requestDomains: ['spclient.wg.spotify.com'] },
    false,
  ),
  {
    // Keyless recommendation station JSON.
    name: 'lastfm-station',
    feature: 'lastfm',
    hostPermission: 'https://www.last.fm/*',
    target: { urlFilter: '|https://www.last.fm/player/station/' },
    resourceTypes: API_TYPES,
  },
]

/** host_permissions the rules need, in spec order, without duplicates. */
export function ruleHostPermissions(specs: readonly CorsRuleSpec[] = CORS_RULE_SPECS): string[] {
  return [...new Set(specs.map((spec) => spec.hostPermission))]
}

/** Rule features in spec order, without duplicates. */
export function ruleFeatures(specs: readonly CorsRuleSpec[] = CORS_RULE_SPECS): RuleFeature[] {
  return [...new Set(specs.map((spec) => spec.feature))]
}

function requestHeaders(spec: CorsRuleSpec): HeaderOperation[] {
  const operations: HeaderOperation[] = []
  if (spec.requestOrigin !== undefined) {
    operations.push({ header: 'origin', operation: 'set', value: spec.requestOrigin })
    if (spec.referer) {
      operations.push({ header: 'referer', operation: 'set', value: `${spec.requestOrigin}/` })
    }
  }
  operations.push({ header: 'cookie', operation: 'remove' })
  return operations
}

function responseHeaders(spec: CorsRuleSpec, origin: string): HeaderOperation[] {
  const operations: HeaderOperation[] = [
    { header: 'access-control-allow-origin', operation: 'set', value: origin },
  ]
  const set = (header: string, value: string | undefined) => {
    if (value !== undefined) operations.push({ header, operation: 'set', value })
  }
  set('access-control-allow-methods', spec.allowMethods)
  set('access-control-allow-headers', spec.allowHeaders?.join(', '))
  set('access-control-expose-headers', spec.exposeHeaders?.join(', '))
  set('access-control-max-age', spec.maxAgeSeconds?.toString())
  operations.push(
    { header: 'access-control-allow-credentials', operation: 'remove' },
    { header: 'set-cookie', operation: 'remove' },
  )
  return operations
}

function condition(spec: CorsRuleSpec, initiator: string): DnrRule['condition'] {
  return {
    // initiatorDomains also matches sub-domains, such as the preview deployments at
    // <hash>.fxmusic.pages.dev. Browsers only modify headers for an initiator the extension
    // has host access to, and hostPermissions() in manifest.ts grants it for the exact FXM host
    // only: that is what keeps the rules away from those sub-domains.
    initiatorDomains: [initiator],
    ...('requestDomains' in spec.target
      ? { requestDomains: [...spec.target.requestDomains] }
      : { urlFilter: spec.target.urlFilter }),
    resourceTypes: [...spec.resourceTypes],
    ...(spec.requestMethods ? { requestMethods: [...spec.requestMethods] } : {}),
    ...(spec.excludedRequestMethods
      ? { excludedRequestMethods: [...spec.excludedRequestMethods] }
      : {}),
  }
}

/** The rules of one FXM origin: every spec scoped to the origin's host, with an exact ACAO. */
export function buildRules(
  origin: string,
  specs: readonly CorsRuleSpec[] = CORS_RULE_SPECS,
): DnrRule[] {
  const initiator = originHost(origin)
  return specs.map((spec, index) => ({
    id: index + 1,
    priority: 1,
    condition: condition(spec, initiator),
    action: {
      type: 'modifyHeaders',
      requestHeaders: requestHeaders(spec),
      responseHeaders: responseHeaders(spec, origin),
    },
  }))
}

/** A static ruleset: one per FXM origin. */
export interface Ruleset {
  /** Ruleset ID in the manifest. */
  id: string
  /** File name inside the extension. */
  path: string
  origin: string
  /** Whether the manifest enables it at install. */
  enabled: boolean
  rules: DnrRule[]
}

/**
 * One ruleset per FXM origin. The first origin's file is `rules.json`; the others are
 * `rules-<id>.json`. DNR matches initiators by host only, so when origins share a host (the
 * localhost ports of the dev build) only the first one is enabled at install and the
 * background switches between them (`rulesetSwitch` in origins.ts).
 */
export function buildRulesets(origins: readonly string[]): Ruleset[] {
  if (origins.length === 0) throw new Error('at least one FXM origin is required')
  if (new Set(origins).size !== origins.length) throw new Error('duplicate FXM origin')
  const enabledHosts = new Set<string>()
  return origins.map((origin, index) => {
    const host = originHost(origin)
    const enabled = !enabledHosts.has(host)
    enabledHosts.add(host)
    const id = rulesetId(origin)
    return {
      id,
      path: index === 0 ? 'rules.json' : `rules-${id}.json`,
      origin,
      enabled,
      rules: buildRules(origin),
    }
  })
}
