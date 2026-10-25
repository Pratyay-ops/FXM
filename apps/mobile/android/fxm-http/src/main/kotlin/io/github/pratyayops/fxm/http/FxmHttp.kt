package io.github.pratyayops.fxm.http

import android.content.Context
import android.webkit.WebSettings
import java.util.concurrent.TimeUnit
import okhttp3.CookieJar
import okhttp3.Dispatcher
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response

/**
 * The one OkHttp client of FXM's native code, with FXM's network rules built in. The FxmHttp
 * plugin (the web app's `fetch` on Android) uses it, and so must every other native component:
 * stage 6.3 builds Media3's data source on it (`OkHttpDataSource.Factory(FxmHttp.client(context))`).
 * Never `HttpURLConnection` (Media3's `DefaultHttpDataSource`, `CapacitorHttp`): it sends and
 * stores the WebView's cookies through Capacitor's process-wide cookie handler.
 *
 * The client has [cookieJar] as its own cookie jar, applies [RequestPolicy] to every request and
 * redirect ([PolicyInterceptor]) and gives requests without a `User-Agent` the WebView's.
 */
object FxmHttp {
  /** A `User-Agent` for when the WebView's is unknown: Chrome for Android's reduced form. */
  const val FALLBACK_USER_AGENT =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/140.0.0.0 Mobile Safari/537.36"

  /** FXM's own cookie jar, which every native request shares. */
  val cookieJar = FxmCookieJar()

  /**
   * The browser `User-Agent` to send instead of the WebView's, from `plugins.FxmHttp.userAgent` in
   * capacitor.config.ts. It must stay a browser's: Spotify refuses app agents.
   */
  @Volatile var userAgentOverride: String? = null

  @Volatile private var webViewUserAgent: String? = null

  @Volatile private var approved: ApprovedHosts? = null

  @Volatile private var shared: OkHttpClient? = null

  /** The shared client, created on first use. */
  fun client(context: Context): OkHttpClient =
    shared
      ?: synchronized(this) {
        shared
          ?: newClient(RequestPolicy(approvedHosts(context), { browserUserAgent(context) }))
            .also { shared = it }
      }

  /** The hosts the user approved, kept in the app's private preferences. */
  fun approvedHosts(context: Context): ApprovedHosts =
    approved
      ?: synchronized(this) {
        approved ?: PreferencesApprovedHosts.open(context).also { approved = it }
      }

  /**
   * Remembers the WebView's default `User-Agent`. The plugin calls it on the main thread when it
   * loads; otherwise the agent is looked up on first use.
   */
  fun rememberWebViewUserAgent(context: Context) {
    webViewUserAgent = runCatching { WebSettings.getDefaultUserAgent(context) }.getOrNull()
  }

  /** The browser `User-Agent` native requests get when they carry none. */
  fun browserUserAgent(context: Context): String =
    userAgentOverride
      ?: webViewUserAgent
      ?: runCatching { WebSettings.getDefaultUserAgent(context) }
        .getOrNull()
        ?.also { webViewUserAgent = it }
      ?: FALLBACK_USER_AGENT

  /**
   * A client with FXM's rules from its parts: [client] builds the shared one with it, and tests
   * build theirs. OkHttp's own redirect following stays off, because [PolicyInterceptor] follows
   * redirects after checking each one. No HTTP cache: providers cache what they need.
   */
  fun newClient(
    policy: RequestPolicy,
    cookieJar: CookieJar = this.cookieJar,
    configure: OkHttpClient.Builder.() -> Unit = {},
  ): OkHttpClient =
    OkHttpClient.Builder()
      .cookieJar(cookieJar)
      .followRedirects(false)
      .followSslRedirects(false)
      .addInterceptor(PolicyInterceptor(policy))
      .addNetworkInterceptor(DropServerCookies)
      .dispatcher(Dispatcher().apply { maxRequestsPerHost = 10 })
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
      .apply(configure)
      .build()
}

/**
 * Removes `Set-Cookie` from every response before OkHttp's cookie handling sees it, so no cookie
 * a server sets is parsed, kept or handed to JavaScript: `credentials: 'omit'`, as on the web.
 * It is a network interceptor, so it runs on each hop, below OkHttp's cookie handling.
 */
object DropServerCookies : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val response = chain.proceed(chain.request())
    if (response.headers("Set-Cookie").isEmpty() && response.headers("Set-Cookie2").isEmpty()) {
      return response
    }
    return response.newBuilder().removeHeader("Set-Cookie").removeHeader("Set-Cookie2").build()
  }
}
