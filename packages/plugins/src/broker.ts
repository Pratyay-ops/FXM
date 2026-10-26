/**
 * The fetch broker: the only way a plugin reaches the network. A plugin's `ctx.fetch` hands its
 * request to the host (`runtime/worker.ts`), and the broker decides:
 *
 * 1. **Declared hosts only.** The URL must be `https:`, without credentials, on a host the
 *    manifest declares (`host` or `host:port`, exactly), and not on a host of FXM's own services
 *    that the platform reaches with FXM's privileges (`reservedServiceOf`). Anything else is
 *    refused before a byte is sent.
 * 2. **What every platform can carry.** Plugin API 1 sends `GET` and `HEAD` only, without request
 *    headers and without a body: a plugin's hosts are user hosts of the platform, whose route on
 *    every platform (`@fxm/platform`'s transports) carries exactly that. A later API may widen
 *    this; narrowing it would break plugins.
 * 3. **The plugin's request budget.** Each request takes a slot from the plugin's own budget, a
 *    `RequestBudget` of `@fxm/platform` (stage 1.2) with the manifest's `requestsPerHour` as its
 *    hourly limit, at the priority of the operation (the stream of a playing song first), kept in
 *    storage so a reload doesn't reset it. A `429` from one of its hosts pauses the plugin's
 *    requests for the `Retry-After` time, at least a minute and at most an hour.
 * 4. **The platform's `fetch`.** The request goes out through the `ctx.fetch` of the provider
 *    call, so the platform's own rules apply on top: its host table (a plugin's own hosts are the
 *    user hosts the app passes to `createPlatform`) and `credentials: 'omit'`.
 * 5. **The answer.** A response that ended on an undeclared host (a redirect) is refused; the
 *    body is read as UTF-8 text, at most 2 MiB, within 20 s.
 *
 * Refusals and failures resolve as failed {@link WireResponse}s, which reject the plugin's
 * `ctx.fetch` with an error naming the reason; only a cancelled caller rejects. A broken rule is
 * the plugin's fault and fails with `Unavailable` (the item is skipped); only a route the platform
 * has closed fails with `Unsupported`, and the broker reports it to the host, which trusts it.
 *
 * @module
 */

import { FXM_ERROR_CODES, type FxmErrorCode, isFxmError, type ProviderContext } from '@fxm/core'
import {
  type Clock,
  isBudgetError,
  isRouteUnavailable,
  isTransportError,
  type RequestBudget,
  type RequestPriority,
  type RouteUnavailableError,
  systemClock,
} from '@fxm/platform'
import { fetchWithTimeout } from '@fxm/sources/shared'
import { cleanText, PLUGIN_FAIL_CODES } from './errors'
import { hostOfUrl, reservedServiceOf } from './manifest'
import type { WireFailure, WireRequest, WireResponse } from './runtime/protocol'

/** The methods a plugin may use (plugin API 1). */
export const PLUGIN_METHODS = ['GET', 'HEAD'] as const

/** The broker's limits. */
export interface BrokerLimits {
  /** A response body, in bytes. */
  readonly responseBytes: number
  /** One request, body included, in milliseconds. */
  readonly timeoutMs: number
  /** The shortest pause after a `429`, in milliseconds. */
  readonly minPauseMs: number
  /** The longest pause after a `429`, in milliseconds. */
  readonly maxPauseMs: number
}

/** The defaults of {@link BrokerLimits}. */
export const BROKER_LIMITS: BrokerLimits = {
  responseBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  minPauseMs: 60_000,
  maxPauseMs: 60 * 60_000,
}

/** Options for {@link createFetchBroker}. */
export interface FetchBrokerOptions {
  /** The plugin: its name, for messages, and its declared hosts. */
  readonly plugin: { readonly name: string; readonly hosts: readonly string[] }
  /** The plugin's own request budget (see the module documentation). */
  readonly budget: RequestBudget
  /** Overrides of {@link BROKER_LIMITS}. */
  readonly limits?: Partial<BrokerLimits>
  /** The clock, for tests. */
  readonly clock?: Clock
}

/** What became of one request. */
export interface BrokerOutcome {
  /** The answer the plugin gets. */
  readonly response: WireResponse
  /**
   * When the platform refused the request because its route to the host is closed right now
   * (`RouteUnavailableError`): that error. The host reports the call as `unreachable` then.
   */
  readonly closedRoute?: RouteUnavailableError
}

/** The broker of one plugin. */
export interface FetchBroker {
  /**
   * Checks one request and sends it through `ctx.fetch`, taking a slot of the plugin's budget at
   * `priority` (default `interactive`). Resolves with the response or with why it failed; rejects
   * only with the reason of `ctx.signal` when the caller cancels.
   */
  fetch(
    request: WireRequest,
    ctx: ProviderContext,
    priority?: RequestPriority,
  ): Promise<BrokerOutcome>
  /** The plugin's request budget. */
  readonly budget: RequestBudget
  /** While a `429` pauses the plugin's requests: when the pause ends, in epoch milliseconds. */
  pausedUntil(): number | undefined
}

/** A header name: an HTTP token. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u

/** A header value or status text without the characters `Response` refuses. */
function printable(value: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed
  return value.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/gu, '').slice(0, max)
}

/** Milliseconds from a `Retry-After` header (seconds or an HTTP date), if it has one. */
function retryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  const text = header.trim()
  if (/^\d+$/u.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** Reads a body as UTF-8 text, cancelling it once it passes `maxBytes`; `undefined` then. */
async function readCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** Creates the broker of one plugin. */
export function createFetchBroker(options: FetchBrokerOptions): FetchBroker {
  const { plugin, budget } = options
  const clock = options.clock ?? systemClock
  const limits = { ...BROKER_LIMITS, ...options.limits }
  let pausedUntil = 0

  function failed(id: number, error: WireFailure): BrokerOutcome {
    return { response: { id, ok: false, error } }
  }

  /** A request that breaks the plugin's rules: the plugin's fault, so the item is skipped. */
  function refused(id: number, code: string, message: string): BrokerOutcome {
    return failed(id, { code, fxmCode: 'Unavailable', message })
  }

  async function send(
    request: WireRequest,
    ctx: ProviderContext,
    priority: RequestPriority,
  ): Promise<BrokerOutcome> {
    const { id } = request
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return refused(id, 'bad-request', 'ctx.fetch needs an absolute URL')
    }
    const host = hostOfUrl(url)
    if (
      host === undefined ||
      !plugin.hosts.includes(host) ||
      reservedServiceOf(host) !== undefined
    ) {
      return refused(
        id,
        'host-not-declared',
        `${plugin.name} may not contact ${cleanText(url.host, 100) || 'that address'}: its manifest doesn't declare it (only https:// addresses on its declared hosts)`,
      )
    }
    if (!(PLUGIN_METHODS as readonly string[]).includes(request.method)) {
      return refused(
        id,
        'bad-request',
        `ctx.fetch sends GET or HEAD, not ${cleanText(request.method, 10)}`,
      )
    }
    if (request.headers.length > 0) {
      return refused(
        id,
        'bad-request',
        `ctx.fetch sends no request headers in plugin API 1 (not ${cleanText(request.headers[0]?.[0] ?? '', 60)})`,
      )
    }
    if (request.body !== undefined) {
      return refused(id, 'bad-request', 'ctx.fetch sends no request body in plugin API 1')
    }

    const now = clock.now()
    if (pausedUntil > now) {
      return failed(id, {
        code: 'rate-limited',
        fxmCode: 'RateLimited',
        message: `${plugin.name}'s service asked FXM to slow down`,
        retryAfterMs: pausedUntil - now,
      })
    }
    try {
      await budget.acquire(priority)
    } catch (error) {
      if (!isBudgetError(error)) throw error
      return failed(id, {
        code: 'rate-limited',
        fxmCode: 'RateLimited',
        message: `${plugin.name} used up its ${budget.settings.hourlyLimit} requests of the hour`,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      })
    }

    let response: Response
    try {
      response = await fetchWithTimeout(ctx.fetch, url.href, {
        method: request.method,
        credentials: 'omit',
        timeoutMs: limits.timeoutMs,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      return describeFailure(id, error, limits.timeoutMs)
    }

    if (response.url !== '') {
      let final: URL | undefined
      try {
        final = new URL(response.url)
      } catch {
        final = undefined
      }
      const finalHost = final === undefined ? undefined : hostOfUrl(final)
      if (finalHost === undefined || !plugin.hosts.includes(finalHost)) {
        await response.body?.cancel().catch(() => undefined)
        return refused(
          id,
          'redirect',
          `The answer came from ${cleanText(final?.host ?? 'another address', 100)}, which ${plugin.name} doesn't declare`,
        )
      }
    }
    if (response.status < 200 || response.status > 599) {
      await response.body?.cancel().catch(() => undefined)
      return failed(id, {
        code: 'network',
        fxmCode: 'Network',
        message: `The request ended with status ${response.status}`,
      })
    }
    if (response.status === 429) {
      const wait = retryAfter(response.headers.get('retry-after'), clock.now())
      const pause = Math.min(limits.maxPauseMs, Math.max(limits.minPauseMs, wait ?? 0))
      pausedUntil = Math.max(pausedUntil, clock.now() + pause)
    }

    let body: string | undefined
    try {
      body = request.method === 'HEAD' ? '' : await readCapped(response, limits.responseBytes)
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      return describeFailure(id, error, limits.timeoutMs)
    }
    if (body === undefined) {
      return refused(id, 'too-large', `The answer is larger than ${limits.responseBytes} bytes`)
    }
    const pairs: [string, string][] = []
    response.headers.forEach((value, name) => {
      if (pairs.length < 64 && TOKEN.test(name) && name.toLowerCase() !== 'set-cookie') {
        pairs.push([name.toLowerCase(), printable(value, 1024)])
      }
    })
    return {
      response: {
        id,
        ok: true,
        status: response.status,
        statusText: printable(response.statusText, 100),
        url: response.url === '' ? url.href : response.url,
        headers: pairs,
        body,
      },
    }
  }

  return {
    budget,
    fetch(request, ctx, priority = 'interactive') {
      if (ctx.signal?.aborted) return Promise.reject(ctx.signal.reason)
      return send(request, ctx, priority)
    },
    pausedUntil() {
      return pausedUntil > clock.now() ? pausedUntil : undefined
    },
  }
}

/** The `FxmError` code a plugin's request fails with, from the platform's: one it may pass on. */
function passedCode(code: FxmErrorCode): FxmErrorCode {
  return PLUGIN_FAIL_CODES.includes(code) ? code : 'Unavailable'
}

/** Why a request failed once sent, for the plugin. */
function describeFailure(id: number, error: unknown, timeoutMs: number): BrokerOutcome {
  if (isRouteUnavailable(error)) {
    return {
      response: {
        id,
        ok: false,
        error: { code: 'refused', fxmCode: 'Unsupported', message: cleanText(error.message, 300) },
      },
      closedRoute: error,
    }
  }
  if (isTransportError(error)) {
    return {
      response: {
        id,
        ok: false,
        error: { code: 'refused', fxmCode: 'Unavailable', message: cleanText(error.message, 300) },
      },
    }
  }
  if (isFxmError(error) && FXM_ERROR_CODES.includes(error.code)) {
    return {
      response: {
        id,
        ok: false,
        error: {
          code: error.code === 'RateLimited' ? 'rate-limited' : 'network',
          fxmCode: passedCode(error.code),
          message: cleanText(error.message, 300),
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        },
      },
    }
  }
  const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
  return {
    response: {
      id,
      ok: false,
      error: {
        code: 'network',
        fxmCode: 'Network',
        message: timedOut ? `No answer within ${timeoutMs} ms` : 'The request failed',
      },
    },
  }
}
