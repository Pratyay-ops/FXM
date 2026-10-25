/**
 * How YouTube's failures become `FxmError`s: HTTP statuses, bot checks hidden in successful
 * responses, and network failures.
 *
 * @module
 */

import { FxmError, type FxmErrorCode, isFxmError } from '@fxm/core'
import { asArray, asString, at, stringAt } from './json'

/** What a bot check says, in YouTube's English text or its status codes. */
const BOT_CHECK_TEXT = /confirm you.?re not a bot|not a robot|unusual traffic|\/sorry\//iu

/** Longest excerpt of a response body kept in an error message. */
const EXCERPT = 160

/**
 * Reads a `Retry-After` header, either delta seconds or an HTTP date, as milliseconds from
 * `now`. `undefined` when it is absent or unreadable.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined
  const value = header.trim()
  if (/^\d+$/u.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function excerpt(body: string): string {
  const message = messageOf(body)
  const text = (message ?? body).replace(/\s+/gu, ' ').trim()
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text
}

/** InnerTube's own error message, from a JSON error body. */
function messageOf(body: string): string | undefined {
  try {
    return stringAt(JSON.parse(body), 'error', 'message')
  } catch {
    return undefined
  }
}

/** What an HTTP error response was for. */
export interface FailedRequest {
  /** E.g. `browse MPREb_…`, for the message. */
  what: string
  /** Whether the request named one entity, so a 400 means that entity cannot exist. */
  entity: boolean
}

/**
 * The error for an InnerTube response that is not 2xx:
 *
 * - 429, and 503 with `Retry-After`: `RateLimited`, with `retryAfterMs` from the header
 * - a bot check page or message (`Sign in to confirm you're not a bot`): `BotCheck`
 * - 404 and 410, and 400 for a request that names an entity: `NotFound`
 * - another 400: `Parse`, because YouTube refused the request's shape (an outdated config)
 * - 401: `AuthRequired`; 403: `Unsupported`, because InnerTube refuses the page's origin
 * - anything else, 5xx included: `Network`, which is worth retrying later
 */
export function httpError(
  status: number,
  retryAfter: string | null,
  body: string,
  request: FailedRequest,
  now = Date.now(),
): FxmError {
  const detail = `YouTube answered ${request.what} with HTTP ${status}: ${excerpt(body)}`
  const retryAfterMs = parseRetryAfter(retryAfter, now)
  if (status === 429 || (status === 503 && retryAfterMs !== undefined)) {
    return new FxmError('RateLimited', detail, retryAfterMs === undefined ? {} : { retryAfterMs })
  }
  if (BOT_CHECK_TEXT.test(body)) return new FxmError('BotCheck', detail)
  const code: FxmErrorCode =
    status === 404 || status === 410 || (status === 400 && request.entity)
      ? 'NotFound'
      : status === 400
        ? 'Parse'
        : status === 401
          ? 'AuthRequired'
          : status === 403
            ? 'Unsupported'
            : 'Network'
  return new FxmError(code, detail)
}

/**
 * Why a successful (2xx) response is really a bot check, or `undefined` when it is not. YouTube
 * reports them as a `LOGIN_REQUIRED` playability status, or as an alert or reason that asks the
 * visitor to sign in to confirm they are not a bot.
 */
export function botCheckIn(json: unknown): string | undefined {
  const status = stringAt(json, 'playabilityStatus', 'status')
  const reason = stringAt(json, 'playabilityStatus', 'reason')
  if (status === 'LOGIN_REQUIRED') return reason ?? 'LOGIN_REQUIRED'
  if (reason !== undefined && BOT_CHECK_TEXT.test(reason)) return reason
  for (const alert of asArray(at(json, 'alerts'))) {
    const text = alertText(alert)
    if (text !== undefined && BOT_CHECK_TEXT.test(text)) return text
  }
  return undefined
}

function alertText(alert: unknown): string | undefined {
  for (const name of ['alertRenderer', 'alertWithButtonRenderer']) {
    const text = at(alert, name, 'text')
    const simple = stringAt(text, 'simpleText')
    if (simple !== undefined) return simple
    const runs = asArray(at(text, 'runs'))
      .map((run) => stringAt(run, 'text') ?? '')
      .join('')
    if (runs !== '') return runs
  }
  return undefined
}

/** Whether a response body is an HTML bot check page rather than JSON. */
export function isBotCheckPage(body: string): boolean {
  return body.trimStart().startsWith('<') && BOT_CHECK_TEXT.test(body)
}

/** Whether `error` is the caller cancelling, which is rethrown as it is. */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

/**
 * The error to throw when the request itself failed: the caller's cancellation as it is (the
 * signal's reason), anything already an `FxmError` as it is, and everything else, a timeout
 * included, as `Network`.
 */
export function requestFailure(error: unknown, what: string, signal?: AbortSignal): unknown {
  if (isFxmError(error)) return error
  if (signal?.aborted) return signal.reason ?? error
  if (isAbort(error)) return error
  const reason =
    error instanceof Error && error.name === 'TimeoutError'
      ? 'timed out'
      : (asString((error as { message?: unknown } | null)?.message) ?? 'failed')
  return new FxmError('Network', `The request for ${what} ${reason}`, { cause: error })
}
