/**
 * The fetch broker: the only way a plugin reaches the network. A plugin's `ctx.fetch` hands its
 * request to the host (`runtime/document.ts`), and the broker decides:
 *
 * 1. **Declared hosts only.** The URL must be `https:`, without credentials, on a host the
 *    manifest declares (`host` or `host:port`, exactly). Anything else is refused before a byte
 *    is sent.
 * 2. **A request shape FXM can carry.** `GET`, `HEAD` or `POST`; only the `Accept`,
 *    `Accept-Language`, `Content-Type` and `Range` headers; a text body only on a `POST`, at
 *    most 256 KiB.
 * 3. **The plugin's request budget.** Each request takes a slot from the plugin's own budget,
 *    a `RequestBudget` of `@fxm/platform` (stage 1.2) with the manifest's `requestsPerHour` as
 *    its hourly limit, kept in storage so a reload doesn't reset it. A `429` from one of its
 *    hosts pauses the plugin's requests for the `Retry-After` time, at least a minute and at most
 *    an hour.
 * 4. **The platform's `fetch`.** The request goes out through the `ctx.fetch` of the provider
 *    call, so the platform's own rules apply on top: its host table (a plugin's own hosts are the
 *    user hosts the app passes to `createPlatform`, which go only as `GET` or `HEAD`, without
 *    headers), `credentials: 'omit'`, and the shared YouTube request budget for any request to a
 *    YouTube API host.
 * 5. **The answer.** A response that ended on an undeclared host (a redirect) is refused; the
 *    body is read as UTF-8 text, at most 2 MiB, within 20 s.
 *
 * Refusals and failures resolve as failed {@link WireResponse}s, which reject the plugin's
 * `ctx.fetch` with an error naming the reason; only a cancelled caller rejects.
 *
 * @module
 */

import { isFxmError, type ProviderContext } from '@fxm/core'
import {
  type Clock,
  isBudgetError,
  isRouteUnavailable,
  isTransportError,
  type RequestBudget,
  systemClock,
} from '@fxm/platform'
import { fetchWithTimeout } from '@fxm/sources/shared'
import { cleanText } from './errors'
import { hostOfUrl } from './manifest'
import type { WireFailure, WireRequest, WireResponse } from './runtime/protocol'

/** The methods a plugin may use. */
export const PLUGIN_METHODS = ['GET', 'HEAD', 'POST'] as const

/** The request headers a plugin may send (lower case). Every other header is refused. */
export const PLUGIN_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'range',
] as const

/** The broker's limits. */
export interface BrokerLimits {
  /** A response body, in bytes. */
  readonly responseBytes: number
  /** A request body, in characters. */
  readonly requestBodyChars: number
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
  requestBodyChars: 256 * 1024,
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

/** The broker of one plugin. */
export interface FetchBroker {
  /**
   * Checks one request and sends it through `ctx.fetch`. Resolves with the response or with why
   * it failed; rejects only with the reason of `ctx.signal` when the caller cancels.
   */
  fetch(request: WireRequest, ctx: ProviderContext): Promise<WireResponse>
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

  function failed(id: number, error: WireFailure): WireResponse {
    return { id, ok: false, error }
  }

  async function send(request: WireRequest, ctx: ProviderContext): Promise<WireResponse> {
    const { id } = request
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return failed(id, {
        code: 'bad-request',
        fxmCode: 'Unsupported',
        message: 'ctx.fetch needs an absolute URL',
      })
    }
    const host = hostOfUrl(url)
    if (host === undefined || !plugin.hosts.includes(host)) {
      return failed(id, {
        code: 'host-not-declared',
        fxmCode: 'Unsupported',
        message: `${plugin.name} may not contact ${cleanText(url.host, 100) || 'that address'}: its manifest doesn't declare it (only https:// addresses on its declared hosts)`,
      })
    }
    if (!(PLUGIN_METHODS as readonly string[]).includes(request.method)) {
      return failed(id, {
        code: 'bad-request',
        fxmCode: 'Unsupported',
        message: `ctx.fetch sends GET, HEAD or POST, not ${request.method}`,
      })
    }
    const headers: Record<string, string> = {}
    for (const [rawName, value] of request.headers) {
      const name = rawName.toLowerCase()
      if (!(PLUGIN_REQUEST_HEADERS as readonly string[]).includes(name)) {
        return failed(id, {
          code: 'bad-request',
          fxmCode: 'Unsupported',
          message: `ctx.fetch may not send the ${cleanText(rawName, 60)} header (only ${PLUGIN_REQUEST_HEADERS.join(', ')})`,
        })
      }
      headers[name] = printable(value, 1024)
    }
    if (request.body !== undefined && request.method !== 'POST') {
      return failed(id, {
        code: 'bad-request',
        fxmCode: 'Unsupported',
        message: 'Only a POST has a body',
      })
    }
    if (request.body !== undefined && request.body.length > limits.requestBodyChars) {
      return failed(id, {
        code: 'bad-request',
        fxmCode: 'Unsupported',
        message: `A request body may have at most ${limits.requestBodyChars} characters`,
      })
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
      await budget.acquire('interactive')
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
        headers,
        credentials: 'omit',
        timeoutMs: limits.timeoutMs,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      return failed(id, describeFailure(error, limits.timeoutMs))
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
        return failed(id, {
          code: 'redirect',
          fxmCode: 'Unsupported',
          message: `The answer came from ${cleanText(final?.host ?? 'another address', 100)}, which ${plugin.name} doesn't declare`,
        })
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
      return failed(id, describeFailure(error, limits.timeoutMs))
    }
    if (body === undefined) {
      return failed(id, {
        code: 'too-large',
        fxmCode: 'Parse',
        message: `The answer is larger than ${limits.responseBytes} bytes`,
      })
    }
    const pairs: [string, string][] = []
    response.headers.forEach((value, name) => {
      if (pairs.length < 64 && TOKEN.test(name) && name.toLowerCase() !== 'set-cookie') {
        pairs.push([name.toLowerCase(), printable(value, 1024)])
      }
    })
    return {
      id,
      ok: true,
      status: response.status,
      statusText: printable(response.statusText, 100),
      url: response.url === '' ? url.href : response.url,
      headers: pairs,
      body,
    }
  }

  return {
    budget,
    fetch(request, ctx) {
      if (ctx.signal?.aborted) return Promise.reject(ctx.signal.reason)
      return send(request, ctx)
    },
    pausedUntil() {
      return pausedUntil > clock.now() ? pausedUntil : undefined
    },
  }
}

/** Why a request failed once sent, for the plugin. */
function describeFailure(error: unknown, timeoutMs: number): WireFailure {
  if (isTransportError(error) || isRouteUnavailable(error)) {
    return {
      code: 'refused',
      fxmCode: 'Unsupported',
      message: cleanText(error.message, 300),
    }
  }
  if (isFxmError(error)) {
    return {
      code: error.code === 'RateLimited' ? 'rate-limited' : 'network',
      fxmCode: error.code,
      message: cleanText(error.message, 300),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    }
  }
  const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
  return {
    code: 'network',
    fxmCode: 'Network',
    message: timedOut ? `No answer within ${timeoutMs} ms` : 'The request failed',
  }
}
