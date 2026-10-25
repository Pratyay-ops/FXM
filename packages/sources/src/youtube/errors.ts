/**
 * How YouTube's failures become `FxmError`s: HTTP statuses, bot checks hidden in successful
 * responses, and network failures.
 *
 * @module
 */

import { FxmError, type FxmErrorCode, isFxmError } from '@fxm/core'
import { asArray, asString, at, stringAt } from './json'
import { textOf } from './parse/text'

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

/** InnerTube's JSON error, `{ "error": { "code", "message", "status" } }`, as far as it is one. */
interface InnerTubeError {
  /** E.g. `Request contains an invalid argument.` */
  readonly message?: string
  /** E.g. `INVALID_ARGUMENT`, `FAILED_PRECONDITION` or `NOT_FOUND`. */
  readonly status?: string
}

function errorOf(body: string): InnerTubeError {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return {}
  }
  const message = stringAt(json, 'error', 'message')
  const status = stringAt(json, 'error', 'status')
  return {
    ...(message === undefined ? {} : { message }),
    ...(status === undefined ? {} : { status }),
  }
}

function excerpt(body: string, error: InnerTubeError): string {
  const text = (error.message ?? body).replace(/\s+/gu, ' ').trim()
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text
}

/** What an HTTP error response was for. */
export interface FailedRequest {
  /** E.g. `browse MPREb_…`, for the message. */
  what: string
  /**
   * Whether the request named one entity by its ID and nothing else (no `params`, query or
   * continuation), so that YouTube refusing its argument (`INVALID_ARGUMENT`) means that the
   * entity cannot exist. The IDs are checked against their patterns before any request.
   */
  entity: boolean
}

/**
 * The error for an InnerTube response that is not 2xx. InnerTube answers a missing album, video,
 * playlist or channel with HTTP 200 and an empty page, which the parsers report as `NotFound`; an
 * error status is about the request itself. An invalid client version, for one, gets HTTP 404
 * `NOT_FOUND` (measured 2026-10-26), which must not read as a missing entity:
 *
 * - 429, and 503 with `Retry-After`: `RateLimited`, with `retryAfterMs` from the header
 * - a bot check page or message (`Sign in to confirm you're not a bot`): `BotCheck`
 * - 400 `INVALID_ARGUMENT` for a request that names one entity and nothing else: `NotFound`, since
 *   YouTube refused the ID itself
 * - 401: `AuthRequired`; 403: `Unsupported`, because InnerTube refuses the page's origin
 * - 408: `Network`
 * - any other 4xx, such as 404 `NOT_FOUND` for an unknown client version or 400
 *   `FAILED_PRECONDITION`: `Parse`, because YouTube refused the request, which a newer config
 *   fixes. The message names YouTube's status.
 * - anything else, 5xx included: `Network`, which is worth retrying later
 */
export function httpError(
  status: number,
  retryAfter: string | null,
  body: string,
  request: FailedRequest,
  now = Date.now(),
): FxmError {
  const error = errorOf(body)
  const named = error.status === undefined ? '' : ` (${error.status})`
  const detail = `YouTube answered ${request.what} with HTTP ${status}${named}: ${excerpt(body, error)}`
  const retryAfterMs = parseRetryAfter(retryAfter, now)
  if (status === 429 || (status === 503 && retryAfterMs !== undefined)) {
    return new FxmError('RateLimited', detail, retryAfterMs === undefined ? {} : { retryAfterMs })
  }
  if (BOT_CHECK_TEXT.test(body)) return new FxmError('BotCheck', detail)
  const code = httpCode(status, error.status, request.entity)
  return new FxmError(code, code === 'Parse' ? `${detail} (${REFUSED})` : detail)
}

/** What a refused request means for the user of the error. */
const REFUSED = 'YouTube refused the request; the YouTube config may be outdated'

function httpCode(status: number, errorStatus: string | undefined, entity: boolean): FxmErrorCode {
  if (status === 400 && errorStatus === 'INVALID_ARGUMENT' && entity) return 'NotFound'
  if (status === 401) return 'AuthRequired'
  if (status === 403) return 'Unsupported'
  if (status === 408) return 'Network'
  return status >= 400 && status < 500 ? 'Parse' : 'Network'
}

/** The texts of a playability status: its reason, its messages and its error screen's. */
function playabilityTexts(status: unknown): string[] {
  const screen = at(status, 'errorScreen', 'playerErrorMessageRenderer')
  return [
    stringAt(status, 'reason'),
    ...asArray(at(status, 'messages')).map(asString),
    textOf(at(screen, 'reason')),
    textOf(at(screen, 'subreason')),
  ].filter((text): text is string => text !== undefined && text.trim() !== '')
}

/** The texts of a response's alerts. */
function alertTexts(json: unknown): string[] {
  return asArray(at(json, 'alerts')).flatMap((alert) => {
    for (const name of ['alertRenderer', 'alertWithButtonRenderer']) {
      const text = textOf(at(alert, name, 'text'))
      if (text !== undefined) return [text]
    }
    return []
  })
}

/**
 * Why a successful (2xx) response is really a bot check, or `undefined` when it is not:
 *
 * - its playability status, error screen or alerts ask the visitor to confirm they are not a bot
 *   ("Sign in to confirm you're not a bot"), whatever the status;
 * - a `LOGIN_REQUIRED` playability status that gives no reason at all.
 *
 * Any other `LOGIN_REQUIRED` is no bot check: YouTube also answers age-restricted videos ("Sign
 * in to confirm your age", `desktopLegacyAgeGateReason`) and private videos with it. Such an
 * answer stays the caller's to read, e.g. as an unavailable state, and the session keeps its
 * visitorData. The texts are matched in English, the language the stream calls ask for.
 */
export function botCheckIn(json: unknown): string | undefined {
  const playability = at(json, 'playabilityStatus')
  const texts = playabilityTexts(playability)
  const said = [...texts, ...alertTexts(json)].find((text) => BOT_CHECK_TEXT.test(text))
  if (said !== undefined) return said
  const ageGate = at(playability, 'desktopLegacyAgeGateReason')
  const silent = texts.length === 0 && (ageGate === undefined || ageGate === 0)
  return stringAt(playability, 'status') === 'LOGIN_REQUIRED' && silent
    ? 'LOGIN_REQUIRED'
    : undefined
}

/** Whether a response body is an HTML bot check page rather than JSON. */
export function isBotCheckPage(body: string): boolean {
  return body.trimStart().startsWith('<') && BOT_CHECK_TEXT.test(body)
}

/**
 * The error to throw when the request itself failed: the caller's cancellation as it is (the
 * signal's reason), anything already an `FxmError` as it is, and everything else as `Network`,
 * including a timeout and an abort the caller did not ask for, which is how some transports
 * report the deadline.
 */
export function requestFailure(error: unknown, what: string, signal?: AbortSignal): unknown {
  if (isFxmError(error)) return error
  if (signal?.aborted) return signal.reason ?? error
  const failure = error as { name?: unknown; message?: unknown } | null
  const reason =
    failure?.name === 'TimeoutError' || failure?.name === 'AbortError'
      ? 'timed out'
      : (asString(failure?.message) ?? 'failed')
  return new FxmError('Network', `The request for ${what} ${reason}`, { cause: error })
}
