package io.github.pratyayops.fxm.http

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * A cookie jar for native code alone, separate from the WebView's.
 *
 * Capacitor installs a process-wide `java.net.CookieHandler` backed by the WebView's cookie jar,
 * which every `HttpURLConnection` (and so `CapacitorHttp`) uses to send and store cookies. OkHttp
 * never consults that handler: it only uses the [CookieJar] it is built with.
 *
 * The shared client, and so every request of the FxmHttp plugin, has no jar at all
 * ([CookieJar.NO_COOKIES]). This one goes only on a client native code builds for itself with
 * [FxmHttp.withCookies], which JavaScript can never reach: stage 6.5's token command can send the
 * Spotify login cookie on the token call this way. It sends only the cookies native code adds with
 * [add], and keeps none of those servers set (the client also drops `Set-Cookie` before OkHttp
 * parses it, see [DropServerCookies]).
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
