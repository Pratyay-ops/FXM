package io.github.pratyayops.fxm.spotify

import io.github.pratyayops.fxm.http.FxmCookieJar
import io.github.pratyayops.fxm.http.FxmHttp
import io.github.pratyayops.fxm.http.FxmHttpException
import io.github.pratyayops.fxm.http.RedirectMode
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/**
 * What the token endpoint answered: its status, and its body as a [JSONObject] or [JSONArray], or
 * [JSONObject.NULL] when the body is no JSON object or array. Never logged: it holds a token.
 */
class TokenAnswer(val status: Int, val json: Any)

/**
 * The token call: `GET https://open.spotify.com/api/token` with the query parameters JavaScript
 * sent ([LoginProtocol.TOKEN_PARAMS] only, each in its form) and the kept login, `sp_dc`. It is the
 * only request that ever carries the cookie.
 *
 * - **Its URL is fixed here.** JavaScript picks only the parameters' values.
 * - **The cookie goes on this call alone**: into a [FxmCookieJar] on a client built for it with
 *   [FxmHttp.withCookies], for `open.spotify.com/api/token` only, and the jar is emptied when the
 *   call ends. [client], the shared client every plugin request and Media3 use, has no cookie jar
 *   and never gets the cookie.
 * - **FXM's rules apply** as to every native request ([FxmHttp]): HTTPS, the host table, a browser
 *   `User-Agent` for Spotify, no `Set-Cookie` kept. A redirect fails the call: the cookie never
 *   follows one.
 * - **Bounded**: at most [LoginProtocol.RATE_LIMIT_MAX] calls in
 *   [LoginProtocol.RATE_LIMIT_WINDOW_MS] (as FXM Connect's bridge on the web; the Spotify provider
 *   asks about once an hour), answers of at most [LoginProtocol.MAX_TOKEN_BYTES], and
 *   [LoginProtocol.TOKEN_TIMEOUT_MS] for the whole call.
 */
class SpotifyTokenCall(
  private val client: OkHttpClient,
  private val store: SessionStore,
  private val now: () -> Long = System::currentTimeMillis,
  private val timeoutMs: Long = LoginProtocol.TOKEN_TIMEOUT_MS,
) {
  private val limiter =
    RateLimiter(LoginProtocol.RATE_LIMIT_MAX, LoginProtocol.RATE_LIMIT_WINDOW_MS)

  /** Sends the token call and waits for the answer. Throws a [LoginFailure]. */
  fun request(params: Map<String, String>): TokenAnswer {
    val url = tokenUrl(params)
    val cookie =
      store.cookie()
        ?: throw LoginFailure(LoginErrorCode.LOGGED_OUT, "No Spotify login is kept on this device")
    limiter.tryAcquire(now())?.let { wait ->
      throw LoginFailure(LoginErrorCode.RATE_LIMITED, "Too many Spotify token requests", wait)
    }
    val jar = FxmCookieJar(now).apply { add(sessionCookie(cookie)) }
    val call =
      FxmHttp.withCookies(client, jar)
        .newBuilder()
        .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .build()
        .newCall(
          Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .tag(RedirectMode::class.java, RedirectMode.ERROR)
            .build(),
        )
    try {
      return call.execute().use { response -> TokenAnswer(response.code, json(response)) }
    } catch (e: FxmHttpException) {
      throw LoginFailure(LoginErrorCode.NETWORK, "Spotify's token endpoint: ${e.message}")
    } catch (e: InterruptedIOException) {
      throw LoginFailure(LoginErrorCode.TIMEOUT, "Spotify's token endpoint took too long")
    } catch (e: IOException) {
      throw LoginFailure(LoginErrorCode.NETWORK, "Spotify's token endpoint could not be reached")
    } finally {
      jar.clear()
    }
  }

  /** The body as JSON, refusing one over [LoginProtocol.MAX_TOKEN_BYTES]. */
  private fun json(response: Response): Any {
    val body = response.body
    val max = LoginProtocol.MAX_TOKEN_BYTES
    if (body.contentLength() > max) throw tooLarge()
    val source = body.source()
    if (source.request(max + 1)) throw tooLarge()
    return parseJson(source.buffer.readUtf8())
  }

  private fun tooLarge() =
    LoginFailure(LoginErrorCode.TOO_LARGE, "Spotify's token endpoint answered with too much")

  companion object {
    /** Where the token call goes: Spotify's token endpoint, fixed in native code. */
    const val TOKEN_URL = "https://open.spotify.com/api/token"

    private const val TOKEN_HOST = "open.spotify.com"
    private const val TOKEN_PATH = "/api/token"

    /**
     * [TOKEN_URL] with [params] in [LoginProtocol.TOKEN_PARAMS]'s order, or a [LoginFailure]
     * ([LoginErrorCode.BAD_REQUEST]) for a parameter outside the allow-list or out of its form.
     */
    fun tokenUrl(params: Map<String, String>): HttpUrl {
      for ((name, value) in params) {
        val form =
          LoginProtocol.TOKEN_PARAMS[name]
            ?: throw LoginFailure(
              LoginErrorCode.BAD_REQUEST,
              "FXM's Spotify login doesn't send the token parameter ${name.take(40)}",
            )
        if (!form.matches(value)) {
          throw LoginFailure(LoginErrorCode.BAD_REQUEST, "The token parameter $name is out of form")
        }
      }
      val url = TOKEN_URL.toHttpUrl().newBuilder()
      for (name in LoginProtocol.TOKEN_PARAMS.keys) {
        params[name]?.let { url.addQueryParameter(name, it) }
      }
      return url.build()
    }

    /** [text] as a JSON object or array, or [JSONObject.NULL] for anything else. */
    fun parseJson(text: String): Any =
      try {
        val tokener = JSONTokener(text)
        val value = tokener.nextValue()
        val rest = tokener.nextClean()
        if ((value is JSONObject || value is JSONArray) && rest == 0.toChar()) value
        else JSONObject.NULL
      } catch (e: JSONException) {
        JSONObject.NULL
      }

    /** The kept login as a cookie for the token endpoint alone: that host, that path, HTTPS. */
    private fun sessionCookie(value: String): Cookie =
      Cookie.Builder()
        .name(LoginPage.SESSION_COOKIE)
        .value(value)
        .hostOnlyDomain(TOKEN_HOST)
        .path(TOKEN_PATH)
        .secure()
        .httpOnly()
        .build()
  }
}
