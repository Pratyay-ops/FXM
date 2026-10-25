package io.github.pratyayops.fxm.http

import java.net.CookieHandler
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The plan's test for stage 6.2: a WebView cookie for `youtube.com` never appears on a native
 * request. Capacitor installs a process-wide `CookieHandler` backed by the WebView's cookie jar
 * (`CapacitorCookies.load()` calls `CookieHandler.setDefault`), so these tests install one that
 * holds a YouTube login cookie, as the WebView's jar would after the user visited YouTube.
 */
class WebViewCookieIsolationTest {
  /** A stand-in for Capacitor's `CapacitorCookieManager`, which reads the WebView's jar. */
  private class WebViewCookieHandler : CookieHandler() {
    val asked = CopyOnWriteArrayList<URI>()
    val stored = CopyOnWriteArrayList<URI>()

    override fun get(uri: URI, requestHeaders: Map<String, List<String>>): Map<String, List<String>> {
      asked.add(uri)
      return if (uri.host == "youtube.com" || uri.host.endsWith(".youtube.com")) {
        mapOf("Cookie" to listOf(WEBVIEW_COOKIE))
      } else {
        emptyMap()
      }
    }

    override fun put(uri: URI, responseHeaders: Map<String, List<String>>) {
      stored.add(uri)
    }
  }

  private val webView = WebViewCookieHandler()
  private var previous: CookieHandler? = null
  private lateinit var internet: FakeInternet

  @Before
  fun setUp() {
    previous = CookieHandler.getDefault()
    CookieHandler.setDefault(webView)
    internet = FakeInternet()
  }

  @After
  fun tearDown() {
    CookieHandler.setDefault(previous)
    internet.close()
  }

  @Test
  fun `a native request to YouTube never carries the WebView's youtube_com cookie`() {
    internet.server.enqueue(
      MockResponse.Builder()
        .addHeader("Set-Cookie", "VISITOR_INFO1_LIVE=abc; Domain=.youtube.com; Path=/; Secure")
        .body("{}")
        .build(),
    )
    val search =
      Request.Builder()
        .url("https://music.youtube.com/youtubei/v1/search?prettyPrint=false")
        .post("""{"context":{"client":{"clientName":"WEB_REMIX"}}}""".toRequestBody(TEXT))
        .build()
    internet.client().newCall(search).execute().use { assertEquals(200, it.code) }

    val recorded = internet.take()
    assertEquals("music.youtube.com", recorded.url.host)
    assertNull("the WebView's cookie went out", recorded.headers["Cookie"])
    assertTrue("OkHttp asked the WebView's jar", webView.asked.isEmpty())
    assertTrue("OkHttp stored a cookie in the WebView's jar", webView.stored.isEmpty())
  }

  @Test
  fun `nor does a request the web app sends through the plugin, even with a Cookie header`() {
    internet.server.enqueue(MockResponse.Builder().body("{}").build())
    val executor = Executors.newCachedThreadPool()
    try {
      val exchanges = Exchanges(internet.client(), executor)
      val options =
        JSONObject()
          .put("id", "r1")
          .put("url", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
          .put("method", "POST")
          .put(
            "headers",
            JSONObject()
              .put("content-type", "text/plain;charset=UTF-8")
              .put("origin", "")
              .put("cookie", "SID=a-cookie-from-javascript"),
          )
          .put("body", """{"videoId":"x"}""")
      val (id, request) = BridgeMessages.request(options)
      val head = Recorded<ResponseHead>()
      exchanges.start(id, request, head)
      assertEquals(200, head.value().status)
    } finally {
      executor.shutdownNow()
    }

    val recorded = internet.take()
    assertNull(recorded.headers["Cookie"])
    assertTrue(webView.asked.isEmpty())
  }

  @Test
  fun `cookies YouTube sets are neither kept nor sent back`() {
    val client = internet.client()
    internet.server.enqueue(
      MockResponse.Builder().addHeader("Set-Cookie", "YSC=xyz; Path=/; Secure").body("a").build(),
    )
    internet.server.enqueue(MockResponse.Builder().body("b").build())
    for (path in listOf("/sw.js_data", "/iframe_api")) {
      client.newCall(Request.Builder().url("https://www.youtube.com$path").build()).execute().close()
    }
    assertNull(internet.take().headers["Cookie"])
    assertNull(internet.take().headers["Cookie"])
    assertTrue(internet.cookieJar.loadForRequest("https://www.youtube.com/".toHttpUrl()).isEmpty())
    assertTrue(webView.stored.isEmpty())
  }

  @Test
  fun `HttpURLConnection, which CapacitorHttp uses, does send the WebView's cookie`() {
    // The hazard the plugin avoids: every HttpURLConnection consults the process-wide handler.
    MockWebServer().use { proxy ->
      proxy.start()
      proxy.enqueue(MockResponse.Builder().body("{}").build())
      val connection =
        URL("http://music.youtube.com/youtubei/v1/search").openConnection(proxy.proxyAddress)
          as HttpURLConnection
      assertEquals(200, connection.responseCode)
      connection.disconnect()
      assertEquals(WEBVIEW_COOKIE, proxy.takeRequest().headers["Cookie"])
    }
    assertTrue(webView.asked.isNotEmpty())
  }

  @Test
  fun `only cookies native code adds reach the requests they match`() {
    // Stage 6.5 sends the Spotify login cookie on the token call alone this way.
    internet.cookieJar.add(
      Cookie.Builder()
        .name("sp_dc")
        .value("native-only")
        .hostOnlyDomain("open.spotify.com")
        .path("/api/token")
        .secure()
        .build(),
    )
    val client = internet.client()
    for (url in
      listOf(
        "https://open.spotify.com/api/token",
        "https://api-partner.spotify.com/pathfinder/v2/query",
        "https://music.youtube.com/youtubei/v1/next",
      )) {
      internet.server.enqueue(MockResponse.Builder().body("{}").build())
      client.newCall(Request.Builder().url(url).build()).execute().close()
    }
    assertEquals("sp_dc=native-only", internet.take().headers["Cookie"])
    assertNull(internet.take().headers["Cookie"])
    assertNull(internet.take().headers["Cookie"])
  }

  companion object {
    private const val WEBVIEW_COOKIE = "SID=webview-login-cookie"
    private val TEXT = "text/plain;charset=UTF-8".toMediaType()
  }
}
