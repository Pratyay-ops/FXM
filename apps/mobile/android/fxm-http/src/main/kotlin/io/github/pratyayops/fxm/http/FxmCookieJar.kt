package io.github.pratyayops.fxm.http

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * FXM's own cookie jar, separate from the WebView's.
 *
 * Capacitor installs a process-wide `java.net.CookieHandler` backed by the WebView's cookie jar,
 * which every `HttpURLConnection` (and so `CapacitorHttp`) uses to send and store cookies. OkHttp
 * never consults that handler: it only uses the [CookieJar] it is built with, and this one.
 *
 * Like `credentials: 'omit'` on the web, it keeps none of the cookies servers set (the client
 * drops `Set-Cookie` before OkHttp parses it, see [DropServerCookies]), so nothing a service sets
 * comes back on the next request. It sends only cookies native code adds with [add]:
 * stage 6.5 adds the Spotify login cookie for the token call alone. JavaScript can never add one,
 * because [RequestPolicy] drops `Cookie` headers.
 */
class FxmCookieJar(private val now: () -> Long = System::currentTimeMillis) : CookieJar {
  private val cookies = mutableListOf<Cookie>()

  /** Keeps nothing a server sets. */
  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {}

  @Synchronized override fun loadForRequest(url: HttpUrl): List<Cookie> {
    val time = now()
    cookies.removeAll { it.expiresAt <= time }
    return cookies.filter { it.matches(url) }
  }

  /** Adds a cookie for native requests that match it, replacing one with its name, domain and path. */
  @Synchronized fun add(cookie: Cookie) {
    cookies.removeAll {
      it.name == cookie.name && it.domain == cookie.domain && it.path == cookie.path
    }
    cookies.add(cookie)
  }

  /** Removes every cookie. */
  @Synchronized fun clear() {
    cookies.clear()
  }
}
