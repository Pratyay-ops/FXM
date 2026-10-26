package io.github.pratyayops.fxm.spotify

import org.json.JSONObject

/**
 * The FxmSpotifyLogin plugin's messages, as packages/platform/src/android-spotify-login.ts sends
 * and reads them.
 */
object LoginMessages {
  /**
   * The token parameters of a `requestToken` call: `params`, an object of strings. Which names and
   * forms are allowed is [SpotifyTokenCall.tokenUrl]'s to check.
   */
  fun tokenParams(options: JSONObject): Map<String, String> {
    val params =
      options.optJSONObject("params")
        ?: throw LoginFailure(LoginErrorCode.BAD_REQUEST, "The token parameters must be an object")
    val result = LinkedHashMap<String, String>()
    for (name in params.keys()) {
      result[name] =
        params.opt(name) as? String
          ?: throw LoginFailure(LoginErrorCode.BAD_REQUEST, "Token parameters must be strings")
    }
    return result
  }

  /** Where the login stands: the result of `status`, `login` and `logout`. */
  fun state(loggedIn: Boolean, available: Boolean): JSONObject =
    JSONObject().put("loggedIn", loggedIn).put("available", available)

  /** The result of `requestToken`: Spotify's status and JSON body. */
  fun answer(answer: TokenAnswer): JSONObject =
    JSONObject().put("status", answer.status).put("json", answer.json)
}
