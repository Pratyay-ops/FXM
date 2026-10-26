package io.github.pratyayops.fxm.http

import okhttp3.CookieJar
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class FxmHttpTest {
  @Test
  fun `the browser agent is Chrome's reduced one, without the device or the WebView`() {
    val phone =
      "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36"
    val tablet =
      "Mozilla/5.0 (Linux; Android 13; SM-X710 Build/TP1A.220624.014; wv) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Version/4.0 Chrome/139.0.7258.158 Safari/537.36"
    assertEquals(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/141.0.0.0 Mobile Safari/537.36",
      FxmHttp.reducedUserAgent(phone),
    )
    assertEquals(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/139.0.0.0 Safari/537.36",
      FxmHttp.reducedUserAgent(tablet),
    )
    for (agent in listOf(null, "", "Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/AP2A.240805.005)")) {
      assertEquals(FxmHttp.FALLBACK_USER_AGENT, FxmHttp.reducedUserAgent(agent))
    }
    for (agent in listOf(phone, tablet, null)) {
      val reduced = FxmHttp.reducedUserAgent(agent)
      assertFalse(reduced, reduced.contains("Build/"))
      assertFalse(reduced, reduced.contains("; wv"))
      assertFalse(reduced, reduced.contains("SM-"))
      assertTrue(reduced, RequestPolicy.isBrowserAgent(reduced))
    }
  }

  @Test
  fun `clients built with FXM's rules keep no cookies, unless native code adds a jar`() {
    val client = FxmHttp.newClient(RequestPolicy(InMemoryApprovedHosts(), { BROWSER_AGENT }))
    assertSame(CookieJar.NO_COOKIES, client.cookieJar)
    assertFalse(client.followRedirects)
    val jar = FxmCookieJar()
    val nativeOnly = FxmHttp.withCookies(client, jar)
    assertSame(jar, nativeOnly.cookieJar)
    assertSame(client.connectionPool, nativeOnly.connectionPool)
    assertEquals(client.interceptors, nativeOnly.interceptors)
    assertSame(CookieJar.NO_COOKIES, client.cookieJar)
  }
}
