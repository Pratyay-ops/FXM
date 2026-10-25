/**
 * What the download manager does after a failure: one pure decision per error, so the rules
 * (ARCHITECTURE.md §14) are in one place and tested on their own.
 *
 * @module
 */

import { type FxmErrorCode, isFxmError, playbackProblemOf } from '@fxm/core'
import { NoDownloadableStreamError } from './resolver'
import { isStorageFullError } from './storage'
import { DownloadHttpError, DownloadNetworkError, DownloadProtocolError } from './transfer'
import type { DownloadErrorCode } from './types'

/**
 * What to do next:
 *
 * - `url`: the stream URL stopped working (refused, expired, gone, or unreadable after a
 *   redirect): resolve afresh and continue from the stored bytes
 * - `transient`: a passing problem (a dropped connection, a busy server): wait, then try the same
 *   URL again
 * - `offline`: the device is offline: wait for the network, without counting an attempt, then
 *   resolve afresh (the IP address, which YouTube's URLs are bound to, may have changed)
 * - `restart`: the stored bytes can't be continued (the file changed on the server): start the
 *   file over
 * - `fatal`: no retry can help until the user acts: the download fails with `code`
 */
export type DownloadFailureKind = 'url' | 'transient' | 'offline' | 'restart' | 'fatal'

/** The decision for one failure. */
export interface DownloadFailure {
  /** What to do next. */
  readonly kind: DownloadFailureKind
  /** The error code the download fails with, if it ends here (or retries run out). */
  readonly code: DownloadErrorCode
  /** How long the server asked to wait, when it did. */
  readonly retryAfterMs?: number
}

/** What {@link classifyDownloadFailure} needs to know besides the error. */
export interface DownloadFailureFacts {
  /** Whether the device is online. */
  online: boolean
  /**
   * Whether the stream's URL is signed and bound to the IP address that resolved it (YouTube's
   * are). A request to such a URL that fails without an answer may be a redirect to another
   * googlevideo host, whose bytes a page can't read: only a fresh resolution helps there.
   */
  ipBound: boolean
}

const STORAGE_PASSING: ReadonlySet<string> = new Set([
  'NotFoundError',
  'NoModificationAllowedError',
  'InvalidStateError',
  'InvalidModificationError',
])

const STORAGE_BLOCKED: ReadonlySet<string> = new Set(['SecurityError', 'NotAllowedError'])

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

/**
 * What to do after `error` ended an attempt at a download:
 *
 * | Error | Next |
 * |---|---|
 * | The storage is full (`QuotaExceededError`) | `fatal`, `storage-full` |
 * | HTTP 401, 403, 410 (and 404) | `url`: resolve afresh |
 * | HTTP 408, 425, 429, 5xx | `transient`, honouring `Retry-After` |
 * | HTTP 416, or a file that changed on the server | `restart` |
 * | No answer, offline | `offline` |
 * | No answer from a signed, IP-bound URL (on the web, a googlevideo redirect looks so) | `url` |
 * | No answer otherwise, or an answer that broke off | `transient` |
 * | No stream passed the end-of-file probe | `url`; `unverified` once fresh resolutions run out |
 * | `Unsupported`, `AuthRequired`, `BotCheck` | `fatal`: the user must act |
 * | Nothing to download (`Unavailable` and its kin; a match that needs review) | `fatal` |
 * | `Network`, `RateLimited`, `Parse` from the resolver; a passing storage error | `transient` |
 */
export function classifyDownloadFailure(
  error: unknown,
  facts: DownloadFailureFacts,
): DownloadFailure {
  if (isStorageFullError(error)) return decide('fatal', 'storage-full')
  if (error instanceof DownloadHttpError) return httpFailure(error)
  if (error instanceof DownloadNetworkError) {
    if (!facts.online) return decide('offline', 'network')
    return facts.ipBound ? decide('url', 'unverified') : decide('transient', 'network')
  }
  if (error instanceof DownloadProtocolError) {
    if (error.problem === 'range-mismatch') return decide('transient', 'server')
    if (error.problem === 'not-media') return decide('url', 'server')
    return decide('restart', 'server')
  }
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
    return decide('transient', 'server', error.retryAfterMs)
  }
  if (error instanceof Error && STORAGE_BLOCKED.has(error.name)) return decide('fatal', 'storage')
  if (error instanceof Error && STORAGE_PASSING.has(error.name)) {
    return decide('transient', 'storage')
  }
  if (error instanceof TypeError) return networkFailure(facts)
  return decide('transient', 'unknown')
}
