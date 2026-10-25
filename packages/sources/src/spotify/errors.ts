/**
 * Typed errors of the Spotify provider. Every failure a provider call reports is a
 * {@link SpotifyError}: an `FxmError` (so `isFxmError` and its `code` work as for any provider)
 * with a Spotify-specific {@link SpotifyErrorReason} that says exactly what went wrong, e.g. to
 * tell "Spotify is paused: its secret stopped working" from "Spotify asked FXM to slow down".
 * Each reason has exactly one code ({@link SPOTIFY_REASON_CODES}), so the constructor takes the
 * reason only.
 *
 * Messages never contain an access token, a TOTP code, the TOTP secret or a token-request URL.
 * Only a caller's own abort escapes untyped: it rejects with the signal's reason, as `fetch` does.
 * Invalid arguments to the synchronous setters (a secret source that is not https, a config
 * that is not valid) throw a `TypeError` at once instead.
 *
 * @module
 */

import { FxmError, type FxmErrorCode, type FxmErrorOptions, isFxmError } from '@fxm/core'

/**
 * The `FxmError` code of every {@link SpotifyErrorReason}. What each reason means:
 *
 * - `disabled`: the user switched Spotify off in the settings
 * - `unreachable`: the platform cannot reach Spotify (`capabilities.spotify` is `unreachable`)
 * - `account-unsupported`: an account feature, but the platform has no logged-in token source
 *   (`capabilities.spotify` is not `account`, or no `SessionTokenSource` was given), or that
 *   source cannot be used here (e.g. FXM Connect's `private-tab`)
 * - `account-disabled`: an account feature, but the user has not connected their account
 *   (Settings → Spotify → Connect your account is off, or `disconnect()` was called)
 * - `login-required`: an account feature, but the user is not logged in to Spotify, or the
 *   login source refused (e.g. FXM Connect's `login-disabled`)
 * - `token-rejected`: Spotify answered 401 even to a freshly minted token
 * - `operation-unsupported`: the config has no cleanly sourced hash for the operation
 * - `operation-broken`: Spotify rejected the operation's hash (HTTP 412) or its variables this
 *   session; a config with a new hash fixes it
 * - `client-rejected`: `403 Client/request not allowed`, the transport's User-Agent is refused.
 *   Not retried
 * - `forbidden`: any other HTTP 403
 * - `secret-unavailable`: no TOTP secret could be loaded or understood; minting pauses for a
 *   short while
 * - `secret-rejected`: the token endpoint refused the TOTP even with a freshly fetched secret;
 *   minting pauses
 * - `paused`: repeated 429 or 5xx answers paused the provider; see `retryAfterMs`
 * - `rate-limited`: the token endpoint or a logged-in token source reported a rate limit; see
 *   `retryAfterMs` when known
 * - `not-found`: the entity does not exist, or its ID is malformed
 * - `graphql`: Spotify answered with GraphQL errors and no data
 * - `http`: any other unexpected HTTP status
 * - `bad-response`: a response FXM does not understand
 * - `network`: the request failed or timed out
 * - `unsupported-seed`: a radio seed that cannot be mapped to a Spotify track or artist
 * - `foreign-id`: an ID of another source, or of another kind, was passed in
 * - `bad-cursor`: a page cursor this provider did not make, e.g. a damaged one restored from
 *   storage. Load the first page again
 */
export const SPOTIFY_REASON_CODES = Object.freeze({
  disabled: 'Unsupported',
  unreachable: 'Unsupported',
  'account-unsupported': 'Unsupported',
  'account-disabled': 'Unsupported',
  'login-required': 'AuthRequired',
  'token-rejected': 'AuthRequired',
  'operation-unsupported': 'Unsupported',
  'operation-broken': 'Unavailable',
  'client-rejected': 'Unsupported',
  forbidden: 'Unavailable',
  'secret-unavailable': 'Unavailable',
  'secret-rejected': 'Unavailable',
  paused: 'RateLimited',
  'rate-limited': 'RateLimited',
  'not-found': 'NotFound',
  graphql: 'Unavailable',
  http: 'Unavailable',
  'bad-response': 'Parse',
  network: 'Network',
  'unsupported-seed': 'Unsupported',
  'foreign-id': 'Unsupported',
  'bad-cursor': 'Unsupported',
} as const satisfies Record<string, FxmErrorCode>)

/** What went wrong, beyond the `FxmError` code. See {@link SPOTIFY_REASON_CODES}. */
export type SpotifyErrorReason = keyof typeof SPOTIFY_REASON_CODES

/** Every {@link SpotifyErrorReason}. */
export const SPOTIFY_ERROR_REASONS: readonly SpotifyErrorReason[] = Object.freeze(
  Object.keys(SPOTIFY_REASON_CODES) as SpotifyErrorReason[],
)

function isReason(value: unknown): value is SpotifyErrorReason {
  return typeof value === 'string' && Object.hasOwn(SPOTIFY_REASON_CODES, value)
}

/** An `FxmError` from the Spotify provider, with a {@link SpotifyErrorReason}. */
export class SpotifyError extends FxmError {
  /** What went wrong, more precisely than `code`. */
  readonly reason: SpotifyErrorReason

  /**
   * @param reason What went wrong. It decides the `FxmError` code ({@link SPOTIFY_REASON_CODES}).
   * @param message Human-readable details, for logs. Never pass a token or secret.
   * @param options The underlying cause and, for `RateLimited`, how long to wait.
   */
  constructor(reason: SpotifyErrorReason, message: string, options: FxmErrorOptions = {}) {
    super(SPOTIFY_REASON_CODES[reason], message, options)
    this.reason = reason
  }
}

/**
 * Whether `value` is a {@link SpotifyError}, optionally with a given `reason`. Like `isFxmError`,
 * it also recognizes an error from a second copy of this module, by its `FxmError` shape and a
 * known reason whose code matches.
 */
export function isSpotifyError(value: unknown, reason?: SpotifyErrorReason): value is SpotifyError {
  if (!isFxmError(value)) return false
  const actual = (value as { reason?: unknown }).reason
  if (!isReason(actual) || SPOTIFY_REASON_CODES[actual] !== value.code) return false
  return reason === undefined || actual === reason
}

/** Hides what must never reach a log: query strings of URLs (TOTP codes) and bearer tokens. */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/giu, '$1?…')
    .replace(/(bearer\s+)[^\s"',;]+/giu, '$1…')
}

/** The message of an error, or the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
