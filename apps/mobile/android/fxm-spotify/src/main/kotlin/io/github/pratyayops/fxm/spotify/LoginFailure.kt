package io.github.pratyayops.fxm.spotify

/**
 * A failure the FxmSpotifyLogin plugin reports to JavaScript as the bridge error [code]. Messages
 * never hold the cookie, a token or the token parameters' values.
 */
class LoginFailure(
  val code: LoginErrorCode,
  message: String,
  /** For [LoginErrorCode.RATE_LIMITED]: how long to wait, in milliseconds (`data.retryAfterMs`). */
  val retryAfterMs: Long? = null,
) : Exception(message)
