/**
 * What the download manager does after a failure: one pure decision per error, so the rules
 * (ARCHITECTURE.md §14) are in one place and tested on their own.
 *
 * @module
 */

import { type FxmErrorCode, isFxmError, type Platform, playbackProblemOf } from '@fxm/core'
import { NoDownloadableStreamError } from './resolver'
import { isStorageFullError, isStorageUnavailableError } from './storage'
import { DownloadHttpError, DownloadNetworkError, DownloadProtocolError } from './transfer'
import type { DownloadErrorCode } from './types'

/**
 * What to do next:
 *
 * - `url`: the stream URL stopped working (refused, expired, gone, or unreadable after a
 *   redirect): resolve afresh and continue from the stored bytes
 * - `transient`: a passing problem (a dropped connection, a busy server): wait, then try the same
 *   URL again
 * - `throttled`: the request budget or a source asks to slow down: give the slot back and wait
 *   `retryAfterMs`, with every download of the same lane, without counting an attempt
 * - `offline`: the device is offline: wait for the network, without counting an attempt, then
 *   resolve afresh (the IP address, which YouTube's URLs are bound to, may have changed)
 * - `restart`: the stored bytes can't be continued (the file changed on the server): start the
 *   file over
 * - `fatal`: no retry can help until the user acts: the download fails with `code`
 */
export type DownloadFailureKind =
  | 'url'
  | 'transient'
  | 'throttled'
  | 'offline'
  | 'restart'
  | 'fatal'

/** The decision for one failure. */
export interface DownloadFailure {
  /** What to do next. */
  readonly kind: DownloadFailureKind
  /** The error code the download fails with, if it ends here (or retries run out). */
  readonly code: DownloadErrorCode
  /** How long the server or the request budget asked to wait, when it did. */
  readonly retryAfterMs?: number
}

/** What {@link classifyDownloadFailure} needs to know besides the error. */
export interface DownloadFailureFacts {
  /** Whether the device is online. */
  online: boolean
  /**
   * Whether the stream's URL is signed and bound to the IP address that resolved it (YouTube's
   * are). On the web, a request to such a URL that gets no answer may be a redirect to another
   * googlevideo host, whose bytes a page can't read: only a fresh resolution helps there.
   */
  ipBound: boolean
  /**
   * Where the download runs. Only a browser page can't read a redirected answer; native HTTP on
   * desktop and Android follows redirects like any other request.
   */
  platform: Platform
}

const STORAGE_PASSING: ReadonlySet<string> = new Set([
  'NotFoundError',
  'NoModificationAllowedError',
  'InvalidStateError',
  'InvalidModificationError',
])

const FATAL_FXM: Readonly<Partial<Record<FxmErrorCode, DownloadErrorCode>>> = {
  Unsupported: 'unsupported',
  AuthRequired: 'unsupported',
  BotCheck: 'bot-check',
  NotFound: 'unavailable',
  Unavailable: 'unavailable',
  GeoBlocked: 'unavailable',
}

function decide(
  kind: DownloadFailureKind,
  code: DownloadErrorCode,
  retryAfterMs?: number,
): DownloadFailure {
  return retryAfterMs === undefined ? { kind, code } : { kind, code, retryAfterMs }
}

function networkFailure(facts: DownloadFailureFacts): DownloadFailure {
  return decide(facts.online ? 'transient' : 'offline', 'network')
}

function httpFailure(error: DownloadHttpError): DownloadFailure {
  const { status } = error
  if (status === 401 || status === 403 || status === 410) return decide('url', 'server')
  if (status === 404) return decide('url', 'unavailable')
  if (status === 416) return decide('restart', 'server')
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return decide('transient', 'server', error.retryAfterMs)
  }
  return decide('fatal', 'server')
}

function protocolFailure(error: DownloadProtocolError): DownloadFailure {
  switch (error.problem) {
    case 'range-mismatch':
      return decide('transient', 'server')
    case 'not-media':
      return decide('url', 'server')
    case 'too-large':
      return decide('fatal', 'too-large')
    default:
      return decide('restart', 'server')
  }
}

/**
 * What to do after `error` ended an attempt at a download:
 *
 * | Error | Next |
 * |---|---|
 * | The storage is full (`QuotaExceededError`) | `fatal`, `storage-full` |
 * | The storage can't work here (`SecurityError`, `NotAllowedError`, `NotSupportedError`) | `fatal`, `storage` |
 * | HTTP 401, 403, 410 (and 404) | `url`: resolve afresh |
 * | HTTP 408, 425, 429, 5xx | `transient`, honouring `Retry-After` |
 * | HTTP 416, or a file that changed on the server | `restart` |
 * | A page or an empty file instead of the file | `url` |
 * | A file far larger than the track can be | `fatal`, `too-large` |
 * | No answer, offline | `offline` |
 * | On the web, a request to a signed, IP-bound URL that got no answer (what a googlevideo redirect looks like) | `url`; `unverified` once fresh resolutions run out |
 * | No answer otherwise, or an answer that broke off (the URL works) | `transient` |
 * | No stream passed the end-of-file probe | `url`; `unverified` once fresh resolutions run out |
 * | `RateLimited` from the resolver: the request budget refused, or a source asks to slow down | `throttled` |
 * | `Unsupported`, `AuthRequired`, `BotCheck` | `fatal`: the user must act |
 * | Nothing to download (`Unavailable` and its kin; a match that needs review) | `fatal` |
 * | `Network`, `Parse` from the resolver; a passing storage error | `transient` |
 */
export function classifyDownloadFailure(
  error: unknown,
  facts: DownloadFailureFacts,
): DownloadFailure {
  if (isStorageFullError(error)) return decide('fatal', 'storage-full')
  if (error instanceof DownloadHttpError) return httpFailure(error)
  if (error instanceof DownloadNetworkError) {
    if (!facts.online) return decide('offline', 'network')
    const redirected = error.phase === 'request' && facts.ipBound && facts.platform === 'web'
    return redirected ? decide('url', 'unverified') : decide('transient', 'network')
  }
  if (error instanceof DownloadProtocolError) return protocolFailure(error)
  if (error instanceof NoDownloadableStreamError) {
    return error.reason === 'unverified'
      ? decide('url', 'unverified')
      : decide('fatal', 'unavailable')
  }
  if (isFxmError(error)) {
    const fatal = FATAL_FXM[error.code]
    if (fatal !== undefined) {
      const problem = playbackProblemOf(error)
      return decide('fatal', problem?.type === 'needs-review' ? 'needs-review' : fatal)
    }
    if (error.code === 'Expired') return decide('url', 'server')
    if (error.code === 'Network') return networkFailure(facts)
    if (error.code === 'RateLimited') return decide('throttled', 'server', error.retryAfterMs)
    return decide('transient', 'server', error.retryAfterMs)
  }
  if (isStorageUnavailableError(error)) return decide('fatal', 'storage')
  if (error instanceof Error && STORAGE_PASSING.has(error.name)) {
    return decide('transient', 'storage')
  }
  if (error instanceof TypeError) return networkFailure(facts)
  return decide('transient', 'unknown')
}
