/**
 * Typed errors. Providers reject with an {@link FxmError} so the app can react to the reason
 * (retry later, ask the user to log in, offer FXM Connect, try another source) instead of
 * parsing messages.
 *
 * @module
 */

/** Every {@link FxmErrorCode}. */
export const FXM_ERROR_CODES = [
  'NotFound',
  'RateLimited',
  'AuthRequired',
  'Unavailable',
  'GeoBlocked',
  'Expired',
  'BotCheck',
  'Unsupported',
  'Network',
  'Parse',
] as const

/**
 * Why an operation failed:
 *
 * - `NotFound`: the entity does not exist (or no longer does)
 * - `RateLimited`: the source asks to slow down; see {@link FxmError.retryAfterMs}
 * - `AuthRequired`: the operation needs a login, or the login expired
 * - `Unavailable`: the entity exists but cannot be played or loaded (removed, private, region
 *   rights unknown)
 * - `GeoBlocked`: not available in the user's region
 * - `Expired`: a signed URL or token is past its lifetime; resolve it again
 * - `BotCheck`: the source wants proof of a real user (captcha, sign-in, PO token)
 * - `Unsupported`: the platform lacks a needed capability, e.g. a browser without FXM Connect
 * - `Network`: the request failed or timed out
 * - `Parse`: the source answered with something FXM does not understand
 */
export type FxmErrorCode = (typeof FXM_ERROR_CODES)[number]

/** Options for the {@link FxmError} constructor. */
export interface FxmErrorOptions {
  /** The underlying error, kept as the standard `Error.cause`. */
  cause?: unknown
  /** For `RateLimited`: how long to wait before retrying, when the source says. */
  retryAfterMs?: number
}

/** An error with a machine-readable {@link FxmErrorCode}. */
export class FxmError extends Error {
  /** Always `FxmError`. */
  override readonly name = 'FxmError'
  /** Why the operation failed. */
  readonly code: FxmErrorCode
  /** For `RateLimited`: milliseconds to wait before retrying, when known. */
  readonly retryAfterMs: number | undefined

  /**
   * @param code Why the operation failed.
   * @param message Human-readable details, for logs.
   * @param options The underlying cause and, for `RateLimited`, the retry delay.
   */
  constructor(code: FxmErrorCode, message: string, options: FxmErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.code = code
    this.retryAfterMs = options.retryAfterMs
  }
}

function isFxmErrorCode(value: unknown): value is FxmErrorCode {
  return typeof value === 'string' && (FXM_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Whether `value` is an {@link FxmError}, optionally with a given `code`. Besides `instanceof`,
 * it accepts an `Error` named `FxmError` with a valid code, so errors from a second copy of this
 * module (e.g. in another bundle) are recognized too.
 */
export function isFxmError(value: unknown, code?: FxmErrorCode): value is FxmError {
  const matches =
    value instanceof FxmError ||
    (value instanceof Error &&
      value.name === 'FxmError' &&
      isFxmErrorCode((value as { code?: unknown }).code))
  return matches && (code === undefined || (value as FxmError).code === code)
}
