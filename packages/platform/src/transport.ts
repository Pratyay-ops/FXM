/**
 * What every transport shares: classifying a URL, the request forms, drawing InnerTube calls
 * from the request budget and telling the budget about bot checks. Each platform only supplies
 * a {@link Router} that says how it sends each kind of request, or that it cannot.
 *
 * @module
 */

import { type Fetch, FxmError } from '@fxm/core'
import { REQUEST_PRIORITIES, type RequestBudget, type RequestPriority } from './budget'
import { findHostRule, type HostRule, INNERTUBE_API_PREFIX, parseUrl, unknownHost } from './hosts'
import {
  isRequestLike,
  requestUrl,
  type SimpleInnerTubeRequest,
  toSimpleInnerTubeRequest,
} from './innertube'

/**
 * How a request is routed, from its host and path:
 *
 * - `open`, `googlevideo`, `spotify`, `lastfm-web`: the {@link HostClass} of its host
 * - `innertube`: an InnerTube API call (`/youtubei/v1/…`), always sent in the CORS-simple shape
 * - `youtube-web`: any other path on a YouTube API host, such as the player JavaScript or
 *   `sw.js_data`
 * - `user`: a host the user added in Settings (GET only)
 *
 * `innertube` and `youtube-web` requests draw from the request budget.
 */
export type RouteKind =
  | 'open'
  | 'innertube'
  | 'youtube-web'
  | 'googlevideo'
  | 'spotify'
  | 'lastfm-web'
  | 'user'

/** A classified request URL. */
export interface Target {
  /** The parsed URL. */
  readonly url: URL
  /** How it is routed. */
  readonly kind: RouteKind
  /** The host's rule; absent for user hosts. */
  readonly rule?: HostRule
}

/**
 * A request in the form every route sends: a URL string and options whose headers are a plain
 * object. Only `method`, `headers`, `body`, `signal` and `redirect` are carried over from the
 * caller; `credentials` is always `omit`, and `Origin` and `Cookie` headers are never kept.
 */
export interface OutgoingRequest {
  /** The absolute URL. */
  readonly url: string
  /** The request options. */
  readonly init: RequestInit & { readonly headers: Readonly<Record<string, string>> }
}

/** Sends an InnerTube API call that is already in the CORS-simple shape. */
export type InnerTubeSender = (request: SimpleInnerTubeRequest) => Promise<Response>

/** Sends any other request. */
export type RequestSender = (request: OutgoingRequest) => Promise<Response>

/**
 * How one platform reaches each kind of request. Both methods throw an `Unsupported` `FxmError`
 * when the platform cannot reach the target right now, before any budget is drawn.
 */
export interface Router {
  /** The sender for an InnerTube API call. */
  innerTube(target: Target): InnerTubeSender
  /** The sender for every other request. */
  other(target: Target): RequestSender
}

/**
 * The `fetch` a platform gives providers, and the budget its InnerTube calls draw from. Each
 * `fetch` refuses hosts FXM does not contact with an `Unsupported` `FxmError`, and draws one
 * slot per request to a YouTube API host at its priority.
 */
export interface Transport {
  /** The `fetch` for providers; its InnerTube calls draw at `interactive` priority. */
  readonly fetch: Fetch
  /**
   * A `fetch` whose InnerTube calls draw at `priority`: build the provider context for playback
   * with `current-track`, for the queue's next tracks with `prefetch`, and for imports with
   * `bulk`. Bulk calls wait for their turn; the others reject with a `RateLimited` `FxmError`
   * when the hour's budget for them is used up.
   */
  withPriority(priority: RequestPriority): Fetch
  /** The request budget. */
  readonly budget: RequestBudget
}

/** Options for {@link createTransport}. */
export interface TransportCoreOptions {
  /** The budget every InnerTube call draws from. */
  budget: RequestBudget
  /** Hosts the user added in Settings (`host` or `host:port`), read on every request. */
  userHosts?: () => Iterable<string>
  /** Request headers this platform never sends (lower case), besides `Origin` and `Cookie`. */
  dropHeaders?: readonly string[]
}

/** Headers no transport ever sends on the caller's behalf. */
const NEVER_SENT = ['origin', 'cookie']

/**
 * Request kinds that native platforms and Node send with a browser `User-Agent` when given one:
 * Spotify refuses non-browser agents, and YouTube's web endpoints expect a browser.
 */
export const BROWSER_AGENT_KINDS: readonly RouteKind[] = [
  'innertube',
  'youtube-web',
  'googlevideo',
  'spotify',
]

/**
 * Headers with `userAgent` added as `user-agent` when the request is of a
 * {@link BROWSER_AGENT_KINDS} kind and carries no `User-Agent` of its own.
 */
export function withBrowserAgent(
  headers: Readonly<Record<string, string>>,
  kind: RouteKind,
  userAgent: string | undefined,
): Record<string, string> {
  const result = { ...headers }
  const hasAgent = Object.keys(result).some((name) => name.toLowerCase() === 'user-agent')
  if (userAgent !== undefined && BROWSER_AGENT_KINDS.includes(kind) && !hasAgent) {
    result['user-agent'] = userAgent
  }
  return result
}

const LOGIN_REQUIRED = 'LOGIN_REQUIRED'

function isPriority(value: unknown): value is RequestPriority {
  return (REQUEST_PRIORITIES as readonly unknown[]).includes(value)
}

/** Classifies a URL, or rejects it with an `Unsupported` `FxmError`. */
export function classifyTarget(url: URL, userHosts?: () => Iterable<string>): Target {
  const rule = findHostRule(url)
  if (rule !== undefined) {
    if (rule.hostClass !== 'innertube') return { url, kind: rule.hostClass, rule }
    const kind = url.pathname.startsWith(INNERTUBE_API_PREFIX) ? 'innertube' : 'youtube-web'
    return { url, kind, rule }
  }
  if (isPlainUserUrl(url) && userHosts !== undefined) {
    const host = url.host.toLowerCase()
    for (const entry of userHosts()) {
      if (entry.trim().toLowerCase() === host) return { url, kind: 'user' }
    }
  }
  throw unknownHost(url)
}

/** User hosts may use another port, but only over HTTPS and without credentials. */
function isPlainUserUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}

/** The error for a target this platform cannot reach right now. */
export function unreachable(target: Target, needs: string): FxmError {
  const service = target.rule?.service ?? target.url.host
  return new FxmError('Unsupported', `Reaching ${service} needs ${needs}`)
}

/**
 * Turns a `fetch` call into an {@link OutgoingRequest}. A `Request`'s body is read into bytes.
 * User-host requests must be `GET` or `HEAD` and lose every header.
 */
export async function toOutgoingRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  target: Target,
  dropHeaders: readonly string[] = [],
): Promise<OutgoingRequest> {
  const request = isRequestLike(input) ? input : undefined
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? request?.headers)
  for (const name of [...NEVER_SENT, ...dropHeaders]) headers.delete(name)
  if (target.kind === 'user') {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new FxmError('Unsupported', `Only GET requests go to ${target.url.host}`)
    }
    for (const name of [...headers.keys()]) headers.delete(name)
  }
  let body = init?.body ?? undefined
  if (body === undefined && request?.body != null && method !== 'GET' && method !== 'HEAD') {
    body = new Uint8Array(await request.arrayBuffer())
  }
  const signal = init?.signal ?? request?.signal ?? undefined
  const redirect = init?.redirect ?? request?.redirect
  return {
    url: target.url.href,
    init: {
      method,
      headers: Object.fromEntries(headers),
      credentials: 'omit',
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      ...(redirect === undefined ? {} : { redirect }),
    },
  }
}

/** Whether an InnerTube `/player` response holds a `LOGIN_REQUIRED` playability status. */
async function isLoginRequired(response: Response): Promise<boolean> {
  if (!response.ok || typeof response.clone !== 'function') return false
  try {
    const text = await response.clone().text()
    if (!text.includes(LOGIN_REQUIRED)) return false
    const json: unknown = JSON.parse(text)
    const status = (json as { playabilityStatus?: { status?: unknown } } | null)?.playabilityStatus
    return status?.status === LOGIN_REQUIRED
  } catch {
    return false
  }
}

/**
 * Builds a {@link Transport} from a platform's {@link Router}. Every request is classified first
 * (unknown hosts reject with an `Unsupported` `FxmError`), then routed. InnerTube API calls are
 * turned into the CORS-simple shape and draw from the budget, as do other requests to YouTube's
 * API hosts. Afterwards an HTTP 429 from those hosts, or a `LOGIN_REQUIRED` playability status in
 * a `/player` response, is reported to the budget as a bot check before the caller gets the
 * response. `LOGIN_REQUIRED` also marks age-restricted videos; counting those too only pauses
 * bulk work, which errs on the safe side.
 */
export function createTransport(router: Router, options: TransportCoreOptions): Transport {
  const { budget, userHosts, dropHeaders = [] } = options
  const fetches = new Map<RequestPriority, Fetch>()

  async function send(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    priority: RequestPriority,
  ): Promise<Response> {
    const target = classifyTarget(parseUrl(requestUrl(input)), userHosts)
    const signal = init?.signal ?? (isRequestLike(input) ? input.signal : undefined) ?? undefined
    signal?.throwIfAborted()
    const acquireOptions = signal === undefined ? {} : { signal }

    if (target.kind === 'innertube') {
      const sendInnerTube = router.innerTube(target)
      const simple = await toSimpleInnerTubeRequest(input, init)
      await budget.acquire(priority, acquireOptions)
      const response = await sendInnerTube(simple)
      if (response.status === 429) budget.reportBotCheck('rate-limited')
      else if (
        target.url.pathname === `${INNERTUBE_API_PREFIX}player` &&
        (await isLoginRequired(response))
      ) {
        budget.reportBotCheck('login-required')
      }
      return response
    }

    const sendOther = router.other(target)
    const request = await toOutgoingRequest(input, init, target, dropHeaders)
    if (target.kind !== 'youtube-web') return sendOther(request)
    await budget.acquire(priority, acquireOptions)
    const response = await sendOther(request)
    if (response.status === 429) budget.reportBotCheck('rate-limited')
    return response
  }

  function withPriority(priority: RequestPriority): Fetch {
    if (!isPriority(priority)) {
      throw new FxmError('Unsupported', `Unknown request priority: ${String(priority)}`)
    }
    let fetch = fetches.get(priority)
    if (fetch === undefined) {
      fetch = (input: RequestInfo | URL, init?: RequestInit) => send(input, init, priority)
      fetches.set(priority, fetch)
    }
    return fetch
  }

  return { fetch: withPriority('interactive'), withPriority, budget }
}
