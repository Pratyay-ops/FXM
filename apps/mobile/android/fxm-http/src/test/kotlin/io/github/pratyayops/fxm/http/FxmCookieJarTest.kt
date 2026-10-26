package io.github.pratyayops.fxm.http

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FxmCookieJarTest {
  private var now = 1_000_000L
  private val jar = FxmCookieJar { now }
  private val token = "https://open.spotify.com/api/token".toHttpUrl()

  private fun cookie(value: String, expiresAt: Long = Long.MAX_VALUE) =
    Cookie.Builder()
      .name("sp_dc")
      .value(value)
      .hostOnlyDomain("open.spotify.com")
      .path("/api/token")
      .expiresAt(expiresAt)
      .build()

  @Test
  fun `keeps nothing servers set`() {
    jar.saveFromResponse(token, listOf(cookie("from-server")))
    assertTrue(jar.loadForRequest(token).isEmpty())
  }

  @Test
  fun `sends cookies native code added to matching URLs only, replacing older ones`() {
    jar.add(cookie("one"))
    jar.add(cookie("two"))
    assertEquals(listOf("two"), jar.loadForRequest(token).map { it.value })
    assertTrue(jar.loadForRequest("https://open.spotify.com/".toHttpUrl()).isEmpty())
    assertTrue(jar.loadForRequest("https://api-partner.spotify.com/api/token".toHttpUrl()).isEmpty())
    jar.clear()
    assertTrue(jar.loadForRequest(token).isEmpty())
  }

  @Test
  fun `drops cookies once they expire`() {
    jar.add(cookie("short", expiresAt = now + 10))
    assertEquals(1, jar.loadForRequest(token).size)
    now += 11
    assertTrue(jar.loadForRequest(token).isEmpty())
  }
}
