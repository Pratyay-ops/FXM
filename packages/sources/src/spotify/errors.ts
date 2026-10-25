/**
 * Typed errors of the Spotify provider. Every failure it reports is a {@link SpotifyError}: an
 * `FxmError` (so `isFxmError` and its `code` work as for any provider) with a Spotify-specific
 * {@link SpotifyErrorReason} that says exactly what went wrong, e.g. to tell "Spotify is paused:
 * its secret stopped working" from "Spotify asked FXM to slow down".
 *
 * Messages never contain an access token, a TOTP code, the TOTP secret or a token-request URL.
 * Only a caller's own abort escapes untyped: it rejects with the signal's reason, as `fetch` does.
 *
 * @module
 */

import { FxmError, type FxmErrorCode, type FxmErrorOptions, isFxmError } from '@fxm/core'

/** Every {@link SpotifyErrorReason}. */
export const SPOTIFY_ERROR_REASONS = [
  'disabled',
  'unreachable',
  'account-unavailable',
  'login-required',
  'token-rejected',
  'operation-unavailable',
  'operation-broken',
  'client-rejected',
  'forbidden',
  'secret-unavailable',
  'secret-rejected',
  'paused',
  'rate-limited',
  'not-found',
  'graphql',
  'http',
  'bad-response',
  'network',
  'unsupported-seed',
  'foreign-id',
] as const

/**
 * What went wrong, beyond the `FxmError` code (in brackets):
 *
 * - `disabled` (`Unsupported`): the user switched Spotify off in the settings
 * - `unreachable` (`Unsupported`): the platform cannot reach Spotify (`capabilities.spotify` is
 *   `unreachable`)
 * - `account-unavailable` (`Unsupported`): an account feature, but the platform has no
 *   logged-in token source
 * - `login-required` (`AuthRequired`): an account feature, but the user is not logged in
 * - `token-rejected` (`AuthRequired`): Spotify answered 401 even to a freshly minted token
 * - `operation-unavailable` (`Unsupported`): the config has no cleanly sourced hash for the
 *   operation
 * - `operation-broken` (`Unavailable`): Spotify rejected the operation's hash (HTTP 412) or its
 *   variables this session
 * - `client-rejected` (`Unsupported`): `403 Client/request not allowed`, the transport's
 *   User-Agent is refused. Not retried
 * - `forbidden` (`Unavailable`): any other HTTP 403
 * - `secret-unavailable` (`Unavailable`): the TOTP secret source could not be read or understood
 * - `secret-rejected` (`Unavailable`): the token endpoint refused the TOTP even with a freshly
 *   fetched secret; minting pauses
 * - `paused` (`RateLimited`): repeated 429 or 5xx answers paused the provider; see
 *   `retryAfterMs`
 * - `rate-limited` (`RateLimited`): a logged-in token source reported a rate limit
 * - `not-found` (`NotFound`): the entity does not exist
 * - `graphql` (`Unavailable`): Spotify answered with GraphQL errors and no data
 * - `http` (`Unavailable`): any other unexpected HTTP status
 * - `bad-response` (`Parse`): a response FXM does not understand
 * - `network` (`Network`): the request failed or timed out
 * - `unsupported-seed` (`Unsupported`): a radio seed that cannot be mapped to a Spotify track or
 *   artist
 * - `foreign-id` (`Unsupported`): an ID of another source, or of another kind, was passed in
 */
export type SpotifyErrorReason = (typeof SPOTIFY_ERROR_REASONS)[number]

/** An `FxmError` from the Spotify provider, with a {@link SpotifyErrorReason}. */
export class SpotifyError extends FxmError {
  /** What went wrong, more precisely than `code`. */
  readonly reason: SpotifyErrorReason

  /**
   * @param code The `FxmError` code the app reacts to.
   * @param reason The Spotify-specific reason.
   * @param message Human-readable details, for logs. Never pass a token or secret.
   * @param options For `RateLimited`: how long to wait.
   */
  constructor(
    code: FxmErrorCode,
    reason: SpotifyErrorReason,
    message: string,
    options: FxmErrorOptions = {},
  ) {
    super(code, message, options)
    this.reason = reason
  }
}

/**
 * Whether `value` is a {@link SpotifyError}, optionally with a given `reason`. Like `isFxmError`,
 * it also recognizes an error from a second copy of this module, by its `FxmError` shape and a
 * known reason.
 */
export function isSpotifyError(value: unknown, reason?: SpotifyErrorReason): value is SpotifyError {
  if (!isFxmError(value)) return false
  const actual = (value as { reason?: unknown }).reason
  const known =
    typeof actual === 'string' && (SPOTIFY_ERROR_REASONS as readonly string[]).includes(actual)
  return known && (reason === undefined || actual === reason)
}

/** Hides what must never reach a log: query strings of URLs (TOTP codes) and bearer tokens. */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/giu, '$1?…')
    .replace(/(bearer\s+)[^\s"',;]+/giu, '$1…')
}
