/**
 * What every transport shares: classifying a URL, the request forms, drawing YouTube calls from
 * the request budget, keeping redirects inside the host table and telling the budget about bot
 * checks. Each platform only supplies a {@link Router} that says how it sends each kind of
 * request, or that it cannot.
 *
 * @module
 */

import { type Fetch, FxmError } from '@fxm/core'
import { REQUEST_PRIORITIES, type RequestBudget, type RequestPriority } from './budget'
import type { ConnectFeature } from './connect'
import { type RouteNeed, RouteUnavailableError, TransportError } from './errors'
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
 * How one platform reaches each kind of request. Reachability is checked at send time: for a
 * request that draws from the budget the transport asks once before it takes a slot, so a closed
 * route costs nothing, and again right before it sends, so a route that closed while the call
 * waited for its slot (FXM Connect disabled, the Lite kill switch set) is never used. Both
 * methods throw a {@link RouteUnavailableError} when the platform cannot reach the target right
 * now, and otherwise return a sender meant to be called at once.
 */
export interface Router {
  /** The sender for an InnerTube API call. */
  innerTube(target: Target): InnerTubeSender
  /** The sender for every other request, and for every hop of a redirect. */
  other(target: Target): RequestSender
}

/**
 * The `fetch` a platform gives providers, and the budget its YouTube calls draw from. Each
 * `fetch` refuses hosts FXM does not contact with a `TransportError`, and draws one slot per
 * request to a YouTube API host at its priority.
 */
export interface Transport {
  /**
   * The `fetch` for what the user is waiting on: its YouTube calls draw at `interactive`
   * priority. Build provider contexts with {@link Transport.withPriority} for anything else.
   */
  readonly fetch: Fetch
  /**
   * A `fetch` whose YouTube calls draw at `priority`: build the provider context for playback
   * with `current-track`, for the queue's next tracks with `prefetch`, and for imports with
   * `bulk`. A call whose slot is not free rejects with a `BudgetError` (`RateLimited`); a bulk
   * call first waits briefly for its turn (see {@link TransportOptions.bulkMaxWaitMs}). Throws a
   * `RangeError` for an unknown priority.
   */
  withPriority(priority: RequestPriority): Fetch
  /**
   * Whether a request to `url` could be sent right now: the host is known and the platform's
   * route to it is open. Draws nothing from the budget, e.g. for the recommendation engine to
   * skip Last.fm stations without FXM Connect.
   */
  canReach(url: string | URL): boolean
  /** The request budget. */
  readonly budget: RequestBudget
}

/** The options every transport factory takes. */
export interface TransportOptions {
  /** The budget every request to a YouTube API host draws from: the device's one budget. */
  budget: RequestBudget
  /** Hosts the user added in Settings (`host` or `host:port`, HTTPS only), read on every request. */
  userHosts?: () => Iterable<string>
  /**
   * The longest a bulk call waits inside `fetch` for its turn, in milliseconds, before it rejects
   * with a `BudgetError`. Default: the budget's spacing plus a second, so that the calls of one
   * provider operation can follow each other while a pause or a used-up hour fails fast.
   */
  bulkMaxWaitMs?: number
  /**
   * Whether a `LOGIN_REQUIRED` playability status in a `/youtubei/v1/player` answer counts as a
   * bot check (see {@link createTransport}). Default `true`. Turn it off once the stream resolver
   * reports the bot checks it tells apart from age gates itself.
   */
  reportLoginRequired?: boolean
}

/** Options for {@link createTransport}. */
export interface TransportCoreOptions extends TransportOptions {
  /**
   * How redirects are kept inside the host table:
   *
   * - `browser`: the platform's `fetch` follows them (a browser page or webview), and a response
   *   that ended on a host outside the table, or of another class, is refused
   * - `manual`: the senders send with `redirect: 'manual'` and return redirect responses as they
   *   are; the transport follows them itself, checking every hop before it is sent
   */
  redirects: 'browser' | 'manual'
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

/** The options of {@link TransportOptions} a factory passes on to {@link createTransport}. */
export function transportOptions(options: TransportOptions): TransportOptions {
  return {
    budget: options.budget,
    ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
    ...(options.bulkMaxWaitMs === undefined ? {} : { bulkMaxWaitMs: options.bulkMaxWaitMs }),
    ...(options.reportLoginRequired === undefined
      ? {}
      : { reportLoginRequired: options.reportLoginRequired }),
  }
}

/** How much longer than the budget's spacing a bulk call may wait for its turn by default. */
const BULK_WAIT_SLACK_MS = 1_000

/** Most redirects one request follows. */
export const MAX_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Headers that describe a body, dropped when a redirect turns a request into a `GET`. */
const REQUEST_BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
]

const LOGIN_REQUIRED = 'LOGIN_REQUIRED'
const PLAYER_PATH = `${INNERTUBE_API_PREFIX}player`

/**
 * English reasons of a `LOGIN_REQUIRED` that is not a bot check: an age gate or a private video.
 * Stream requests ask for English (`hl=en`); in other languages only the language-independent
 * age-gate field counts, and the status is reported, which errs on the safe side.
 */
const NOT_A_BOT_CHECK = /confirm your age|inappropriate for some users|age-restricted|\bprivate\b/iu

function isPriority(value: unknown): value is RequestPriority {
  return (REQUEST_PRIORITIES as readonly unknown[]).includes(value)
}

/** Classifies a URL, or throws a `TransportError` (`unknown-host`). */
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

/** What the target serves, for messages: the service, or the host for user hosts. */
function serviceOf(target: Target): string {
  return target.rule?.service ?? target.url.host
}

const NEED_NAMES: Readonly<Record<RouteNeed, string>> = {
  connect: 'FXM Connect',
  lite: 'the Lite tier',
  native: 'the desktop or Android app',
  sandbox: 'the web app’s sandbox documents',
}

/** "a", "a or b", "a, b or c". */
function either(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? 'nothing')
    : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

/**
 * The error for a target this platform cannot reach right now: a {@link RouteUnavailableError}
 * that says what would open it. `detail` replaces the generated list of needs in the message.
 */
export function routeClosedError(
  target: Target,
  needs: readonly RouteNeed[],
  options: { detail?: string; connectFeature?: ConnectFeature } = {},
): RouteUnavailableError {
  const what = options.detail ?? either(needs.map((need) => NEED_NAMES[need]))
  return new RouteUnavailableError(
    target.kind,
    needs,
    `Reaching ${serviceOf(target)} needs ${what}`,
    options.connectFeature,
  )
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
      throw new TransportError('bad-request', `Only GET requests go to ${target.url.host}`)
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

/** The request for the next hop of a redirect, following the Fetch standard's rules. */
function redirectedRequest(request: OutgoingRequest, status: number, to: URL): OutgoingRequest {
  const { body, ...rest } = request.init
  const method = (rest.method ?? 'GET').toUpperCase()
  const toGet =
    (status === 303 && method !== 'GET' && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST')
  if (!toGet && typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    throw new TransportError('redirect', `A streamed body cannot follow a redirect to ${to.host}`)
  }
  const crossOrigin = new URL(request.url).origin !== to.origin
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(rest.headers)) {
    const lower = name.toLowerCase()
    if (toGet && REQUEST_BODY_HEADERS.includes(lower)) continue
    if (crossOrigin && lower === 'authorization') continue
    headers[name] = value
  }
  return {
    url: to.href,
    init: {
      ...rest,
      method: toGet ? 'GET' : method,
      headers,
      ...(toGet || body === undefined || body === null ? {} : { body }),
    },
  }
}

/** Whether a URL is Google's "unusual traffic" page, where flagged YouTube requests end up. */
function isUnusualTrafficPage(url: URL): boolean {
  const host = url.hostname
  return (
    (host === 'google.com' || host.endsWith('.google.com')) && url.pathname.startsWith('/sorry/')
  )
}

/** A text in YouTube's `simpleText` or `runs` form, or a plain string. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const { simpleText, runs } = value as { simpleText?: unknown; runs?: unknown }
  if (typeof simpleText === 'string') return simpleText
  if (!Array.isArray(runs)) return undefined
  return runs.map((run) => (run as { text?: unknown } | null)?.text ?? '').join('')
}

/**
 * Whether a `/player` answer holds a `LOGIN_REQUIRED` playability status that may be a bot check:
 * not an age gate (`desktopLegacyAgeGateReason`, or an English age reason) and not a private
 * video (its English reason).
 */
async function isBotCheckLoginRequired(response: Response): Promise<boolean> {
  if (!response.ok || typeof response.clone !== 'function') return false
  try {
    const text = await response.clone().text()
    if (!text.includes(LOGIN_REQUIRED)) return false
    const json: unknown = JSON.parse(text)
    const status = (json as { playabilityStatus?: Record<string, unknown> } | null)
      ?.playabilityStatus
    if (status?.status !== LOGIN_REQUIRED) return false
    const ageGate = status.desktopLegacyAgeGateReason
    if (typeof ageGate === 'number' && ageGate > 0) return false
    const screen = (status.errorScreen as { playerErrorMessageRenderer?: unknown } | undefined)
      ?.playerErrorMessageRenderer as { reason?: unknown; subreason?: unknown } | undefined
    const reasons = [status.reason, screen?.reason, screen?.subreason].map(textOf)
    return !reasons.some((reason) => reason !== undefined && NOT_A_BOT_CHECK.test(reason))
  } catch {
    return false
  }
}

/** Frees a response that will not be read, e.g. a redirect the transport follows. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Nothing to free.
  }
}

/**
 * Builds a {@link Transport} from a platform's {@link Router}:
 *
 * 1. Every request is classified first; an unknown host throws a `TransportError`
 *    (`unknown-host`) and a closed route a {@link RouteUnavailableError}, before anything is
 *    drawn from the budget.
 * 2. InnerTube API calls are turned into the CORS-simple shape. They and other requests to
 *    YouTube's API hosts take a budget slot at the fetch's priority; the route is then asked
 *    again, so one that closed in the meantime is not used.
 * 3. Redirects stay inside the host table (see {@link TransportCoreOptions.redirects}). One that
 *    leaves YouTube for Google's "unusual traffic" page is reported as a bot check and rejects
 *    with a `BotCheck` `FxmError`.
 * 4. Before the caller gets the response, an HTTP 429 from YouTube's API hosts is reported to the
 *    budget as a bot check, and so is a `LOGIN_REQUIRED` playability status in a `/player`
 *    answer (read from a clone), unless it is an age gate or a private video or
 *    {@link TransportOptions.reportLoginRequired} is off. A 403 is not: InnerTube answers it to
 *    origins it refuses, which says nothing about the IP address.
 */
export function createTransport(router: Router, options: TransportCoreOptions): Transport {
  const { budget, userHosts, dropHeaders = [], redirects } = options
  const reportLoginRequired = options.reportLoginRequired ?? true
  const bulkMaxWaitMs = options.bulkMaxWaitMs ?? budget.settings.bulkSpacingMs + BULK_WAIT_SLACK_MS
  const fetches = new Map<RequestPriority, Fetch>()

  /** Takes the budget slot for a request to a YouTube API host. */
  async function draw(priority: RequestPriority, signal: AbortSignal | undefined): Promise<void> {
    await budget.acquire(priority, {
      ...(signal === undefined ? {} : { signal }),
      ...(priority === 'bulk' ? { maxWaitMs: bulkMaxWaitMs } : {}),
    })
  }

  /**
   * The target of a redirect hop from `from` to `to`, which must stay inside the host table and
   * the host's class (user hosts: the same host). Google's "unusual traffic" page counts as a
   * bot check.
   */
  function hop(from: Target, to: URL): Target {
    const youtube = from.rule?.hostClass === 'innertube' || from.rule?.hostClass === 'googlevideo'
    if (youtube && isUnusualTrafficPage(to)) {
      budget.reportBotCheck('rate-limited')
      throw new FxmError(
        'BotCheck',
        `${serviceOf(from)} sent the request to Google's "unusual traffic" page`,
      )
    }
    const refused = () =>
      new TransportError(
        'redirect',
        `${serviceOf(from)} redirected to ${to.protocol}//${to.host}${to.pathname}, which this request may not follow`,
      )
    let next: Target
    try {
      next = classifyTarget(to, userHosts)
    } catch {
      throw refused()
    }
    const sameRoute =
      from.kind === 'user' || next.kind === 'user'
        ? from.kind === next.kind && from.url.host === next.url.host
        : from.rule?.hostClass === next.rule?.hostClass
    if (!sameRoute) throw refused()
    return next
  }

  /** Follows redirects hop by hop (`manual` platforms), checking each before it is sent. */
  async function follow(
    first: Response,
    request: OutgoingRequest,
    target: Target,
    mode: RequestRedirect,
  ): Promise<Response> {
    let response = first
    let current = request
    let from = target
    for (let hops = 0; ; hops += 1) {
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get('location')
        : null
      if (location === null || mode === 'manual') return response
      if (mode === 'error') {
        throw new TransportError(
          'redirect',
          `${serviceOf(from)} answered with a redirect, which the request does not follow`,
        )
      }
      if (hops >= MAX_REDIRECTS) {
        throw new TransportError(
          'redirect',
          `${serviceOf(target)} redirected more than ${MAX_REDIRECTS} times`,
        )
      }
      let to: URL
      try {
        to = new URL(location, current.url)
      } catch (cause) {
        throw new TransportError('redirect', `${serviceOf(from)} sent an unreadable redirect`, {
          cause,
        })
      }
      const next = hop(from, to)
      current = redirectedRequest(current, response.status, to)
      await discard(response)
      response = await router.other(next)(current)
      from = next
    }
  }

  /** Keeps the response's redirects inside the host table. */
  async function settle(
    response: Response,
    request: OutgoingRequest,
    target: Target,
    mode: RequestRedirect,
  ): Promise<Response> {
    if (redirects === 'manual') return follow(response, request, target, mode)
    if (response.redirected && response.url !== '') {
      try {
        hop(target, new URL(response.url))
      } catch (error) {
        await discard(response)
        throw error
      }
    }
    return response
  }

  async function send(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    priority: RequestPriority,
  ): Promise<Response> {
    const target = classifyTarget(parseUrl(requestUrl(input)), userHosts)
    const request = isRequestLike(input) ? input : undefined
    const signal = init?.signal ?? request?.signal ?? undefined
    const mode: RequestRedirect = init?.redirect ?? request?.redirect ?? 'follow'
    signal?.throwIfAborted()

    if (target.kind === 'innertube') {
      router.innerTube(target)
      const simple = await toSimpleInnerTubeRequest(input, init)
      await draw(priority, signal)
      const response = await settle(await router.innerTube(target)(simple), simple, target, mode)
      if (response.status === 429) budget.reportBotCheck('rate-limited')
      else if (
        reportLoginRequired &&
        target.url.pathname === PLAYER_PATH &&
        (await isBotCheckLoginRequired(response))
      ) {
        budget.reportBotCheck('login-required')
      }
      return response
    }

    const sendNow = router.other(target)
    const outgoing = await toOutgoingRequest(input, init, target, dropHeaders)
    if (target.kind !== 'youtube-web') {
      return settle(await sendNow(outgoing), outgoing, target, mode)
    }
    await draw(priority, signal)
    const response = await settle(await router.other(target)(outgoing), outgoing, target, mode)
    if (response.status === 429) budget.reportBotCheck('rate-limited')
    return response
  }

  function withPriority(priority: RequestPriority): Fetch {
    if (!isPriority(priority)) {
      throw new RangeError(`Unknown request priority: ${String(priority)}`)
    }
    let fetch = fetches.get(priority)
    if (fetch === undefined) {
      fetch = (input: RequestInfo | URL, init?: RequestInit) => send(input, init, priority)
      fetches.set(priority, fetch)
    }
    return fetch
  }

  function canReach(url: string | URL): boolean {
    try {
      const target = classifyTarget(parseUrl(url), userHosts)
      if (target.kind === 'innertube') router.innerTube(target)
      else router.other(target)
      return true
    } catch {
      return false
    }
  }

  return { fetch: withPriority('interactive'), withPriority, canReach, budget }
}
