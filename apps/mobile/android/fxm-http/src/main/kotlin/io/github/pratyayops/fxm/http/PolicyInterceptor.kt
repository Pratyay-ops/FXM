package io.github.pratyayops.fxm.http

import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/** Redirect handling for one request, as `RequestInit.redirect` in `fetch`. */
enum class RedirectMode {
  /** Follow redirects within FXM's rules (the default, and what Media3 gets). */
  FOLLOW,

  /** Return the redirect response itself, as Node's `fetch` does. */
  MANUAL,

  /** Fail on any redirect. */
  ERROR,
}

/** How many redirects led to a response: a tag on the request of the response's last hop. */
data class Redirects(val count: Int)

/**
 * Applies [RequestPolicy] to every request of the shared client, before OkHttp opens any
 * connection, and follows redirects itself so that each hop is checked the same way: the client
 * is built with OkHttp's own redirect following off. A request may carry a [RedirectMode] tag;
 * without one it follows redirects, as Media3's requests do.
 */
class PolicyInterceptor(private val policy: RequestPolicy) : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val original = chain.request()
    val mode = original.tag(RedirectMode::class.java) ?: RedirectMode.FOLLOW
    var request: Request = checked { policy.apply(original) }
    var count = 0
    while (true) {
      val response = chain.proceed(request)
      if (response.code !in REDIRECT_STATUSES || mode == RedirectMode.MANUAL) return response
      val location = response.header("Location") ?: return response
      response.close()
      if (mode == RedirectMode.ERROR) {
        throw FxmHttpException(BridgeErrorCode.REDIRECT, "${request.url.host} redirected")
      }
      count += 1
      if (count > MAX_REDIRECTS) {
        throw FxmHttpException(BridgeErrorCode.REDIRECT, "More than $MAX_REDIRECTS redirects")
      }
      val next =
        request.url.resolve(location)
          ?: throw FxmHttpException(
            BridgeErrorCode.REDIRECT,
            "${request.url.host} redirected to an invalid URL",
          )
      val previous = request
      request = checked {
        policy
          .redirect(previous, next, response.code)
          .newBuilder()
          .tag(Redirects::class.java, Redirects(count))
          .build()
      }
    }
  }

  /**
   * Runs [block], turning an unchecked exception into an [FxmHttpException]: on OkHttp's
   * dispatcher threads only an `IOException` reaches the caller, anything else would crash the app.
   */
  private inline fun <T> checked(block: () -> T): T =
    try {
      block()
    } catch (e: IllegalArgumentException) {
      throw FxmHttpException(BridgeErrorCode.BAD_REQUEST, e.message ?: "Invalid request")
    } catch (e: IllegalStateException) {
      throw FxmHttpException(BridgeErrorCode.BAD_REQUEST, e.message ?: "Invalid request")
    }

  companion object {
    /** The statuses `fetch` follows. */
    val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)

    /** As in `fetch`. */
    const val MAX_REDIRECTS = 20
  }
}
