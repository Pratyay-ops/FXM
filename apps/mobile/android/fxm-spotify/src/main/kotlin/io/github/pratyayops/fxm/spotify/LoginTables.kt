// Generated from @fxm/platform by apps/mobile/scripts/native-tables.ts. Do not edit: after
// changing packages/platform/src/android-spotify-login.ts, run
// `scripts/run.sh pnpm vitest run apps/mobile/scripts -u` and commit the result.
package io.github.pratyayops.fxm.spotify

/**
 * The codes the FxmSpotifyLogin plugin rejects with: `FXM_SPOTIFY_LOGIN_ERROR_CODES` in
 * packages/platform/src/android-spotify-login.ts, which documents each.
 */
enum class LoginErrorCode {
  BAD_REQUEST,
  LOGGED_OUT,
  BUSY,
  NO_ACTIVITY,
  RATE_LIMITED,
  NETWORK,
  TIMEOUT,
  TOO_LARGE,
  STORAGE,
}

/** The FxmSpotifyLogin bridge's constants, from packages/platform/src/android-spotify-login.ts. */
object LoginProtocol {
  /** The plugin's name on the Capacitor bridge. */
  const val PLUGIN_NAME = "FxmSpotifyLogin"

  /**
   * The token request's query parameters, in the order they are sent, and the form each must
   * have: FXM Connect's allow-list (`SPOTIFY_TOKEN_PARAM_FORMS` in
   * packages/platform/src/connect.ts).
   */
  val TOKEN_PARAMS: Map<String, Regex> =
    linkedMapOf(
      "reason" to Regex("^[A-Za-z][A-Za-z0-9_-]{0,31}\$"),
      "productType" to Regex("^[A-Za-z][A-Za-z0-9_-]{0,31}\$"),
      "totp" to Regex("^[0-9]{6,10}\$"),
      "totpServer" to Regex("^[0-9]{6,10}\$"),
      "totpVer" to Regex("^[0-9]{1,4}\$"),
    )

  /** How many token requests may be sent in [RATE_LIMIT_WINDOW_MS]. */
  const val RATE_LIMIT_MAX = 10

  /** The rate limit's rolling window. */
  const val RATE_LIMIT_WINDOW_MS = 60000L

  /** The largest token endpoint answer that is read. */
  const val MAX_TOKEN_BYTES = 65536L

  /** How long one token request may take, the response included. */
  const val TOKEN_TIMEOUT_MS = 15000L
}
