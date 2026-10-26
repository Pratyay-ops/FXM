/**
 * How a scrobble request fails, sorted by what the offline queue does about it.
 *
 * @module
 */

import { FxmError, type FxmErrorCode, isFxmError } from '@fxm/core'
import type { ScrobbleServiceId } from './types'

/**
 * What a failed request means for the scrobbles it carried:
 *
 * - `refused`: the service refused FXM's credentials (a revoked token, a wrong secret). Keep the
 *   scrobbles and stop sending until the user connects again
 * - `rate-limited`: the service asked FXM to slow down. Keep them and try after the wait
 * - `temporary`: the service or the network failed. Keep them and try again later
 * - `rejected`: the service refused the request itself, and sending it again would get the same
 *   answer. Drop the scrobble that caused it
 */
export type ScrobbleFailure = 'refused' | 'rate-limited' | 'temporary' | 'rejected'

/** Options for a {@link ScrobbleError}. */
export interface ScrobbleErrorOptions {
  /** The underlying error. */
  cause?: unknown
  /** For `rate-limited`: how long to wait, when the service said. */
  retryAfterMs?: number
  /** The service's own code: Last.fm's `error` number, or the HTTP status. */
  serviceCode?: number
  /** The core error code, when it says more than the failure's own (e.g. `Network`). */
  code?: FxmErrorCode
}

/** The core error code each failure maps to by default. */
const CODES: Readonly<Record<ScrobbleFailure, FxmErrorCode>> = {
  refused: 'AuthRequired',
  'rate-limited': 'RateLimited',
  temporary: 'Unavailable',
  rejected: 'Unavailable',
}

/**
 * A failed scrobble request: an `FxmError` that also says which service failed, what the
 * failure means for the queue ({@link ScrobbleFailure}) and the service's own error code.
 * Messages never contain a token, a secret or a session key.
 */
export class ScrobbleError extends FxmError {
  /** The service that failed. */
  readonly service: ScrobbleServiceId
  /** What the failure means for the scrobbles. */
  readonly failure: ScrobbleFailure
  /** The service's own code: Last.fm's `error` number, or the HTTP status, when there was one. */
  readonly serviceCode: number | undefined

  constructor(
    service: ScrobbleServiceId,
    failure: ScrobbleFailure,
    message: string,
    options: ScrobbleErrorOptions = {},
  ) {
    const { code, serviceCode, ...rest } = options
    super(code ?? CODES[failure], message, rest)
    this.service = service
    this.failure = failure
    this.serviceCode = serviceCode
  }
}

/**
 * What an error means for the scrobbles of the request that threw it. A {@link ScrobbleError}
 * says so itself; another `FxmError` goes by its code (`AuthRequired` is `refused`,
 * `RateLimited` is `rate-limited`); anything else is `temporary`, so no scrobble is ever
 * dropped because of an error FXM doesn't know.
 */
export function scrobbleFailureOf(error: unknown): ScrobbleFailure {
  if (error instanceof ScrobbleError) return error.failure
  if (isFxmError(error, 'AuthRequired')) return 'refused'
  if (isFxmError(error, 'RateLimited')) return 'rate-limited'
  return 'temporary'
}
