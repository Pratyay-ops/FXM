package io.github.pratyayops.fxm.http

import java.io.IOException
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request

/**
 * A request that failed for a reason the plugin reports as bridge error [code]: FXM's network
 * rules refused it, a redirect could not be followed, or the plugin's message was malformed. It is
 * an [IOException] so OkHttp delivers it to the caller like any failed call.
 */
class FxmHttpException(val code: BridgeErrorCode, message: String) : IOException(message)

/** Where a request goes: a host on FXM's table, or one the user approved. */
data class Target(
  /** The host's rule; `null` for a user-approved host. */
  val rule: HostRule?,
) {
  /** The host's class; `null` for a user-approved host. */
  val hostClass: HostClass?
    get() = rule?.hostClass
}

/**
 * FXM's rules for every native request, applied before anything is sent (and again to each
 * redirect) by [PolicyInterceptor]:
 *
 * - **Hosts:** HTTPS only, and only hosts on FXM's host table or approved by the user
 *   ([ApprovedHosts]). User hosts get `GET` and `HEAD` only, and of the caller's headers only
 *   [USER_HOST_HEADERS], so no token or cookie meant for a service can reach them.
 * - **Origin:** an empty `Origin` means none. Any other must be one the host may receive
 *   ([allowedOrigins]): YouTube's own origins for YouTube, Spotify's for Spotify, nothing for the
 *   rest. So the WebView's origin (`https://localhost`) never reaches a service. `Referer` follows
 *   the same rule.
 * - **Cookies:** a `Cookie` header from the caller is dropped; only [FxmCookieJar] adds cookies.
 * - **Framing:** headers OkHttp manages itself (`Host`, `Connection`, `Content-Length`,
 *   `Transfer-Encoding`, `Accept-Encoding`, …) are dropped, so bodies are always decoded.
 * - **User-Agent:** a request without one gets the browser agent; Spotify always gets a browser
 *   agent, because it refuses others with `403 Client/request not allowed`.
 */
class RequestPolicy(
  private val approvedHosts: ApprovedHosts,
  /** The browser `User-Agent`: the WebView's own on a device. */
  private val browserUserAgent: () -> String,
  private val rules: List<HostRule> = HOST_RULES,
) {
  /** Classifies [url], or throws a [FxmHttpException] when FXM may not contact it. */
  fun classify(url: HttpUrl): Target {
    if (url.scheme != "https") {
      throw FxmHttpException(BridgeErrorCode.HOST_NOT_ALLOWED, "FXM only uses HTTPS (${url.host})")
    }
    if (url.username.isNotEmpty() || url.password.isNotEmpty()) {
      throw FxmHttpException(BridgeErrorCode.HOST_NOT_ALLOWED, "URLs with credentials are refused")
    }
    val rule = Hosts.ruleFor(url, rules)
    if (rule != null) return Target(rule)
    if (Hosts.hostPort(url) in approvedHosts) return Target(null)
    if (rules.any { Hosts.matches(url.host, it.host) }) {
      throw FxmHttpException(
        BridgeErrorCode.HOST_NOT_ALLOWED,
        "FXM does not contact ${Hosts.hostPort(url)} at that port or path",
      )
    }
    throw FxmHttpException(
      BridgeErrorCode.HOST_NOT_APPROVED,
      "The user has not approved ${Hosts.hostPort(url)}",
    )
  }

  /** Checks [request] and returns it with FXM's header rules applied. */
  fun apply(request: Request): Request {
    val target = classify(request.url)
    val method = checkMethod(request.method, target, request.url)
    val headers = Headers.Builder()
    for ((name, value) in request.headers) {
      val lower = name.lowercase()
      if (lower in DROPPED || (target.rule == null && lower !in USER_HOST_HEADERS)) continue
      if (lower == "origin" || lower == "referer") {
        if (value.isEmpty()) continue
        if (originOf(lower, value) !in allowedOrigins(target.hostClass)) {
          throw FxmHttpException(
            BridgeErrorCode.HEADER_NOT_ALLOWED,
            "${request.url.host} may not receive that $lower header",
          )
        }
      }
      headers.add(name, value)
    }
    setUserAgent(headers, target)
    return request.newBuilder().method(method, request.body).headers(headers.build()).build()
  }

  /**
   * The request for the next hop of a redirect from [previous] to [location] with [status], or a
   * [FxmHttpException] when FXM may not follow it. As in `fetch`: a `POST` answered with 301 or
   * 302, or anything but `GET` and `HEAD` answered with 303, becomes a body-less `GET`, and
   * `Authorization` is dropped when the origin changes. An `Origin` or `Referer` the new host may
   * not receive is dropped too.
   */
  fun redirect(previous: Request, location: HttpUrl, status: Int): Request {
    val target = classify(location)
    var method = previous.method
    var body = previous.body
    val toGet =
      ((status == 301 || status == 302) && method == "POST") ||
        (status == 303 && method != "GET" && method != "HEAD")
    if (toGet) {
      method = "GET"
      body = null
    }
    method = checkMethod(method, target, location)
    val sameOrigin =
      previous.url.scheme == location.scheme &&
        previous.url.host == location.host &&
        previous.url.port == location.port
    val headers = Headers.Builder()
    for ((name, value) in previous.headers) {
      val lower = name.lowercase()
      if (target.rule == null && lower !in USER_HOST_HEADERS) continue
      if (toGet && lower in BODY_HEADERS) continue
      if (lower == "authorization" && !sameOrigin) continue
      if ((lower == "origin" || lower == "referer") &&
        originOf(lower, value) !in allowedOrigins(target.hostClass)
      ) {
        continue
      }
      headers.add(name, value)
    }
    setUserAgent(headers, target)
    return previous.newBuilder()
      .url(location)
      .method(method, body)
      .headers(headers.build())
      .build()
  }

  private fun checkMethod(method: String, target: Target, url: HttpUrl): String {
    if (method in FORBIDDEN_METHODS) {
      throw FxmHttpException(BridgeErrorCode.METHOD_NOT_ALLOWED, "$method requests are refused")
    }
    if (target.rule == null && method != "GET" && method != "HEAD") {
      throw FxmHttpException(
        BridgeErrorCode.METHOD_NOT_ALLOWED,
        "Only GET and HEAD requests go to ${Hosts.hostPort(url)}",
      )
    }
    return method
  }

  private fun setUserAgent(headers: Headers.Builder, target: Target) {
    val agent = headers["User-Agent"]
    val needsBrowser = target.hostClass == HostClass.SPOTIFY && !isBrowserAgent(agent)
    if (agent.isNullOrBlank() || needsBrowser) headers.set("User-Agent", browserUserAgent())
  }

  companion object {
    /** Headers never sent on a caller's behalf: cookies, and what OkHttp manages itself. */
    val DROPPED: Set<String> =
      setOf(
        "cookie",
        "cookie2",
        "host",
        "connection",
        "keep-alive",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "accept-encoding",
        "expect",
      )

    /**
     * The only caller headers a user-approved host receives: what a media player needs for byte
     * ranges and content negotiation. The web transports send user hosts no header at all.
     */
    val USER_HOST_HEADERS: Set<String> =
      setOf("range", "if-range", "accept", "accept-language", "user-agent")

    /** Methods `fetch` forbids. */
    private val FORBIDDEN_METHODS = setOf("CONNECT", "TRACE", "TRACK")

    /** Headers that describe a body, dropped when a redirect turns a request into a `GET`. */
    private val BODY_HEADERS =
      setOf("content-type", "content-encoding", "content-language", "content-location")

    private val YOUTUBE_ORIGINS = setOf("https://www.youtube.com", "https://music.youtube.com")
    private val SPOTIFY_ORIGINS = setOf("https://open.spotify.com")

    /**
     * The `Origin` values a host may receive besides none: YouTube's own origins for YouTube's
     * API and media hosts, Spotify's web player for Spotify, nothing for the rest (including
     * user hosts). The platform transport sends none except Spotify's.
     */
    fun allowedOrigins(hostClass: HostClass?): Set<String> =
      when (hostClass) {
        HostClass.INNERTUBE, HostClass.GOOGLEVIDEO -> YOUTUBE_ORIGINS
        HostClass.SPOTIFY -> SPOTIFY_ORIGINS
        else -> emptySet()
      }

    /** Whether [agent] looks like a browser's, which Spotify requires. */
    fun isBrowserAgent(agent: String?): Boolean = agent != null && agent.startsWith("Mozilla/5.0 (")

    /** The origin an `Origin` value names, or that a `Referer` URL belongs to. */
    private fun originOf(header: String, value: String): String? {
      if (header == "origin") return value
      val url = value.toHttpUrlOrNull() ?: return null
      val port = if (url.port == HttpUrl.defaultPort(url.scheme)) "" else ":${url.port}"
      return "${url.scheme}://${url.host}$port"
    }
  }
}
