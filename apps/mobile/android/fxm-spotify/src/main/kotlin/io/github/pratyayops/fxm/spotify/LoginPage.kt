package io.github.pratyayops.fxm.spotify

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Where a navigation of the login window's main frame may go ([LoginPage.navigation]). */
sealed interface Navigation {
  /** Spotify's login pages, and Apple's sign-in, which works in app windows. */
  data object Allowed : Navigation

  /** Anywhere else, other schemes (`intent:`, `spotify:`) included: the window stays on Spotify. */
  data object Elsewhere : Navigation

  /** A sign-in that refuses app windows; [provider] names it for the window's notice. */
  data class NotHere(val provider: String) : Navigation
}

/** What the login window knows about Spotify's login page, as plain functions the tests run. */
object LoginPage {
  /** Where a login starts: Spotify's login page, which goes on to its web player once signed in. */
  const val START_URL =
    "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F"

  /**
   * Spotify's password reset, where an account made with Google or Facebook gets a password for
   * logging in with its email address ("Logging in to Spotify with Google", Spotify's support).
   */
  const val PASSWORD_RESET_URL = "https://www.spotify.com/password-reset"

  /** A URL the login cookie is sent to: Spotify sets `sp_dc` for every `spotify.com` host. */
  const val COOKIE_URL = "https://open.spotify.com/"

  /** Spotify's login cookie, the only one FXM keeps. */
  const val SESSION_COOKIE = "sp_dc"

  /** The longest cookie value kept: browsers keep cookies of up to 4096 bytes, name included. */
  private const val MAX_COOKIE_CHARS = 4096

  /** RFC 6265's `cookie-octet`s: no spaces, quotes, commas, semicolons or backslashes. */
  private val COOKIE_VALUE = Regex("[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]+")

  /** The Chrome major version in a `User-Agent`. */
  private val CHROME_VERSION = Regex("""\bChrome/(\d{1,4})\.""")

  /** Whether [value] is a cookie value FXM keeps. */
  fun isCookieValue(value: String): Boolean =
    value.length in 1..MAX_COOKIE_CHARS && COOKIE_VALUE.matches(value)

  /**
   * The `sp_dc` value in what `CookieManager.getCookie` answers (`a=1; b=2`), or `null` when there
   * is none or it is not a cookie value.
   */
  fun sessionCookie(cookies: String?): String? {
    if (cookies == null) return null
    for (pair in cookies.split(';')) {
      val separator = pair.indexOf('=')
      if (separator < 0 || pair.substring(0, separator).trim() != SESSION_COOKIE) continue
      return pair.substring(separator + 1).trim().takeIf(::isCookieValue)
    }
    return null
  }

  /**
   * Where the main frame may go: Spotify's hosts and Apple's sign-in, over HTTPS. Google and
   * Facebook refuse sign-ins in app windows (Google since 2021, with `disallowed_useragent`;
   * Facebook's login dropped Android WebViews in 2021), so the window says so instead of showing
   * their error. Anything else stays closed.
   */
  fun navigation(url: String): Navigation {
    val parsed = url.toHttpUrlOrNull() ?: return Navigation.Elsewhere
    if (parsed.scheme != "https") return Navigation.Elsewhere
    val host = parsed.host
    return when {
      within(host, "spotify.com") || host == "appleid.apple.com" -> Navigation.Allowed
      host == "accounts.google.com" -> Navigation.NotHere("Google")
      within(host, "facebook.com") -> Navigation.NotHere("Facebook")
      else -> Navigation.Elsewhere
    }
  }

  /**
   * The login window's `User-Agent`: [agent], the WebView's, as Chrome for Android sends it, with
   * the Android version and device model fixed and the Chrome version reduced, so neither Spotify's
   * page nor what it loads learns the phone's model. It keeps the WebView's `; wv`: sign-ins that
   * refuse app windows see the window for what it is. [agent] as it is when it names no Chrome.
   */
  fun loginUserAgent(agent: String): String {
    val major = CHROME_VERSION.find(agent)?.groupValues?.get(1) ?: return agent
    val mobile = if (agent.contains(" Mobile")) "Mobile " else ""
    return "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Version/4.0 Chrome/$major.0.0.0 ${mobile}Safari/537.36"
  }

  private fun within(host: String, domain: String): Boolean =
    host == domain || host.endsWith(".$domain")
}
