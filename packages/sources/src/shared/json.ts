/**
 * JSON over the injected `fetch`, with the error handling the free-source providers share
 * (Internet Archive, Jamendo and MusicBrainz): timeouts, cancellation, unreachable hosts and
 * unreadable bodies become an `FxmError`, and each provider maps the HTTP status itself.
 *
 * Requests never carry credentials, and they send only the headers a caller passes: in a browser
 * page anything beyond CORS-safelisted headers costs a preflight, so web requests send none.
 *
 * @module
 */

import { FxmError, type FxmErrorCode, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from './index'

/** How {@link getJson} sends one request. */
export interface JsonRequestOptions {
  /** The service's name, for error messages, e.g. `Internet Archive`. */
  service: string
  /** Abort the request after this many milliseconds. */
  timeoutMs: number
  /** Request headers, e.g. a `User-Agent` on desktop and Android. None by default. */
  headers?: Record<string, string>
}

/** What a service answered. The status is not interpreted: each provider maps its own. */
export interface JsonReply {
  /** The HTTP status. */
  status: number
  /** The response headers. */
  headers: Headers
  /**
   * The parsed body. For a 2xx answer it is always present; for any other status it is
   * `undefined` when the body is empty or not JSON.
   */
  body: unknown
}

/** The error to throw when the request itself failed: the caller's cancellation, or `Network`. */
function requestFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  { service, timeoutMs }: JsonRequestOptions,
): unknown {
  if (signal?.aborted) return signal.reason
  const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
  const message = timedOut
    ? `${service} did not answer within ${timeoutMs} ms`
    : `${service} could not be reached`
  return new FxmError('Network', message, { cause: error })
}

/**
 * GETs `url` with `ctx.fetch` and parses the JSON body. Rejects with the signal's reason when
 * `ctx.signal` cancels the request, with a `Network` `FxmError` when the service cannot be
 * reached or does not answer within `timeoutMs`, and with a `Parse` one when a 2xx body is not
 * JSON. Any other status resolves, for the caller to map.
 */
export async function getJson(
  ctx: ProviderContext,
  url: string,
  options: JsonRequestOptions,
): Promise<JsonReply> {
  const { signal } = ctx
  signal?.throwIfAborted()
  let response: Response
  let text: string
  try {
    response = await fetchWithTimeout(ctx.fetch, url, {
      credentials: 'omit',
      timeoutMs: options.timeoutMs,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(signal === undefined ? {} : { signal }),
    })
    text = await response.text()
  } catch (error) {
    throw requestFailure(error, signal, options)
  }
  const ok = response.status >= 200 && response.status < 300
  let body: unknown
  try {
    body = text.trim() === '' ? undefined : JSON.parse(text)
  } catch (error) {
    if (ok) {
      throw new FxmError('Parse', `${options.service} answered with invalid JSON`, { cause: error })
    }
  }
  if (ok && body === undefined) {
    throw new FxmError('Parse', `${options.service} answered with an empty body`)
  }
  return { status: response.status, headers: response.headers, body }
}

/** The longest `Retry-After` FXM takes at its word: an hour. */
const MAX_RETRY_AFTER_MS = 3_600_000

/**
 * Milliseconds to wait from a `Retry-After` header, which holds seconds or an HTTP date, capped
 * at an hour. `fallbackMs` when the header is missing or unreadable. `0` is a valid answer
 * (MusicBrainz sends `Retry-After: 0`), so callers apply their own minimum.
 */
export function retryAfterMs(header: string | null, fallbackMs: number, now = Date.now()): number {
  const value = header?.trim() ?? ''
  const seconds = /^\d+(?:\.\d+)?$/u.test(value)
  // An HTTP date names its weekday and month; Date.parse alone would also take "-1".
  const date = !seconds && /[a-z]/iu.test(value)
  const ms = seconds ? Number(value) * 1000 : date ? Date.parse(value) - now : Number.NaN
  return Number.isFinite(ms)
    ? Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS)
    : fallbackMs
}

/**
 * The `FxmError` for an HTTP status that is not a success: `NotFound` for 404 and 410,
 * `RateLimited` for 429 (with the `Retry-After` delay, a minute when absent), and `Unavailable`
 * for everything else. `what` names the request in the message, e.g. `the item metadata`.
 */
export function statusError(
  service: string,
  what: string,
  reply: Pick<JsonReply, 'status' | 'headers'>,
): FxmError {
  const { status } = reply
  const message = `${service} answered ${what} with HTTP ${status}`
  if (status === 429) {
    return new FxmError('RateLimited', message, {
      retryAfterMs: retryAfterMs(reply.headers.get('retry-after'), 60_000),
    })
  }
  const code: FxmErrorCode = status === 404 || status === 410 ? 'NotFound' : 'Unavailable'
  return new FxmError(code, message)
}

/** `value` as a plain object, or `undefined` when it is not one (arrays and `null` included). */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A string with something besides whitespace in it, trimmed; otherwise `undefined`. */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * A release date as `Track.releaseDate` holds it, ISO 8601 and possibly partial (`2008`,
 * `2008-03` or `2008-03-02`), from what a source sends: such a date, the start of an ISO date-time
 * (`2008-03-02T00:00:00Z`) or a year as a number. `undefined` for anything else, including
 * Jamendo's `0000-00-00`.
 */
export function releaseDate(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1000 && value <= 9999 ? String(value) : undefined
  }
  const match = text(value)?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:$|T)/u)
  if (!match) return undefined
  const [, year = '', month, day] = match
  if (year === '0000') return undefined
  if (month === undefined || month === '00') return year
  if (Number(month) > 12) return year
  if (day === undefined || day === '00' || Number(day) > 31) return `${year}-${month}`
  return `${year}-${month}-${day}`
}
