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
 * The client keeps no cookies at all ([CookieJar.NO_COOKIES]), applies [RequestPolicy] to every
 * request and redirect ([PolicyInterceptor]) and gives requests without a `User-Agent` a reduced
 * Chrome agent ([browserUserAgent]). Native code that must send a cookie builds a client of its
 * own with [withCookies].
 *
 * Only the application context is kept, never the activity a plugin hands in, so the shared
 * client outlives any activity without holding it, its WebView or its bridge.
 */
object FxmHttp {
  /** A `User-Agent` for when the WebView's is unknown: Chrome for Android's reduced form. */
  const val FALLBACK_USER_AGENT =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/140.0.0.0 Mobile Safari/537.36"

  /** The Chrome major version in a `User-Agent`. */
  private val CHROME_VERSION = Regex("""\bChrome/(\d{1,4})\.""")

  /**
   * The browser `User-Agent` to send instead of the reduced WebView one, from
   * `plugins.FxmHttp.userAgent` in capacitor.config.ts. It must stay a browser's: Spotify refuses
   * app agents.
   */
  @Volatile var userAgentOverride: String? = null

  @Volatile private var webViewUserAgent: String? = null

  @Volatile private var approved: ApprovedHosts? = null

  @Volatile private var shared: OkHttpClient? = null

  /** The shared client, created on first use. Only [context]'s application context is kept. */
  fun client(context: Context): OkHttpClient {
    val app = context.applicationContext
    return shared
      ?: synchronized(this) {
        shared
          ?: newClient(RequestPolicy(approvedHosts(app), { browserUserAgent(app) }))
            .also { shared = it }
      }
  }

  /**
   * The hosts the user approved, kept in the app's private preferences. Only [context]'s
   * application context is kept.
   */
  fun approvedHosts(context: Context): ApprovedHosts {
    val app = context.applicationContext
    return approved
      ?: synchronized(this) {
        approved ?: PreferencesApprovedHosts.open(app).also { approved = it }
      }
  }

  /**
   * Remembers the WebView's default `User-Agent`. The plugin calls it on the main thread when it
   * loads; otherwise the agent is looked up on first use.
   */
  fun rememberWebViewUserAgent(context: Context) {
    webViewUserAgent =
      runCatching { WebSettings.getDefaultUserAgent(context.applicationContext) }.getOrNull()
  }

  /**
   * The browser `User-Agent` native requests get when they carry none: [userAgentOverride], or
   * the WebView's reduced to what Chrome itself sends ([reducedUserAgent]).
   */
  fun browserUserAgent(context: Context): String =
    userAgentOverride
      ?: reducedUserAgent(
        webViewUserAgent
          ?: runCatching { WebSettings.getDefaultUserAgent(context.applicationContext) }
            .getOrNull()
            ?.also { webViewUserAgent = it },
      )

  /**
   * Chrome for Android's reduced `User-Agent` with [agent]'s Chrome major version, and without
   * what the WebView's own agent adds: the device model, the Android version and build, and the
   * WebView's `; wv`, which together single the device out to every server it contacts.
   * [FALLBACK_USER_AGENT] when [agent] names no Chrome version.
   */
  fun reducedUserAgent(agent: String?): String {
    if (agent == null) return FALLBACK_USER_AGENT
    val major = CHROME_VERSION.find(agent)?.groupValues?.get(1) ?: return FALLBACK_USER_AGENT
    val mobile = if (agent.contains(" Mobile")) "Mobile " else ""
    return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/$major.0.0.0 ${mobile}Safari/537.36"
  }

  /**
   * A client with FXM's rules from its parts: [client] builds the shared one with it, and tests
   * build theirs. It sends and keeps no cookies ([CookieJar.NO_COOKIES]). OkHttp's own redirect
   * following stays off, because [PolicyInterceptor] follows redirects after checking each one.
   * No HTTP cache: providers cache what they need.
   */
  fun newClient(
    policy: RequestPolicy,
    configure: OkHttpClient.Builder.() -> Unit = {},
  ): OkHttpClient =
    OkHttpClient.Builder()
      .cookieJar(CookieJar.NO_COOKIES)
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

  /**
   * A client for native code alone that also sends the cookies native code put in [jar]:
   * [client]'s connections, rules and timeouts, plus the jar, whose cookies OkHttp adds after
   * [RequestPolicy] has dropped every caller's `Cookie` header. Stage 6.5's token command can send
   * the Spotify login cookie this way. Never give it to the FxmHttp plugin, or to anything else
   * JavaScript can reach: the plugin's client sends no cookies at all.
   */
  fun withCookies(client: OkHttpClient, jar: FxmCookieJar): OkHttpClient =
    client.newBuilder().cookieJar(jar).build()
}

/**
 * Removes `Set-Cookie` from every response before OkHttp's cookie handling sees it, so no cookie
 * a server sets is parsed, kept or handed to JavaScript: `credentials: 'omit'`, as on the web,
 * whatever jar a client derived from the shared one has. It is a network interceptor, so it runs
 * on each hop, below OkHttp's cookie handling.
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
