package io.github.pratyayops.fxm.spotify

import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import okhttp3.CookieJar
import okhttp3.Request
import okio.Buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SpotifyTokenCallTest {
  private val spotify = FakeSpotify()
  private val cipher = MemoryCipher()
  private val store = SessionStore(MemoryFile(), cipher)
  private var now = 1_000_000L
  private val call = SpotifyTokenCall(spotify.client, store, { now })

  @After
  fun tearDown() = spotify.close()

  private fun failure(params: Map<String, String> = PARAMS, call: SpotifyTokenCall = this.call) =
    try {
      call.request(params)
      fail("expected a failure")
      throw AssertionError()
    } catch (e: LoginFailure) {
      e
    }

  private fun token(body: String = TOKEN_JSON) = MockResponse.Builder().body(body).build()

  @Test
  fun `sends the kept login to the token endpoint alone, with the allow-listed parameters`() {
    store.save(COOKIE)
    spotify.server.enqueue(token())
    val answer =
      call.request(
        linkedMapOf(
          "totpVer" to "61",
          "totp" to "123456",
          "reason" to "transport",
          "productType" to "web-player",
          "totpServer" to "654321",
        ),
      )

    assertEquals(200, answer.status)
    val json = answer.json as JSONObject
    assertEquals(false, json.getBoolean("isAnonymous"))
    val sent = spotify.take()
    assertEquals("open.spotify.com", sent.url.host)
    assertEquals(
      "/api/token?reason=transport&productType=web-player&totp=123456&totpServer=654321&totpVer=61",
      sent.target,
    )
    assertEquals("GET", sent.method)
    assertEquals("sp_dc=$COOKIE", sent.headers["Cookie"])
    assertEquals("application/json", sent.headers["Accept"])
    assertEquals(BROWSER_AGENT, sent.headers["User-Agent"])
    assertNull(sent.headers["Origin"])
    assertNull(sent.headers["Referer"])
  }

  @Test
  fun `never gives the cookie to the shared client, whose requests carry none`() {
    store.save(COOKIE)
    spotify.server.enqueue(token())
    spotify.server.enqueue(token())
    call.request(PARAMS)
    spotify.client
      .newCall(Request.Builder().url("https://open.spotify.com/api/token?reason=init").build())
      .execute()
      .close()
    assertEquals("sp_dc=$COOKIE", spotify.take().headers["Cookie"])
    assertNull(spotify.take().headers["Cookie"])
    assertSame(CookieJar.NO_COOKIES, spotify.client.cookieJar)
  }

  @Test
  fun `keeps none of the cookies Spotify sets`() {
    store.save(COOKIE)
    spotify.server.enqueue(
      MockResponse.Builder()
        .addHeader("Set-Cookie", "sp_dc=from-the-server; Domain=.spotify.com; Path=/; Secure")
        .addHeader("Set-Cookie", "sp_t=device; Domain=.spotify.com; Path=/; Secure")
        .body(TOKEN_JSON)
        .build(),
    )
    spotify.server.enqueue(token())
    call.request(PARAMS)
    call.request(PARAMS)
    spotify.take()
    assertEquals("sp_dc=$COOKIE", spotify.take().headers["Cookie"])
  }

  @Test
  fun `refuses parameters outside the allow-list before anything is sent`() {
    store.save(COOKIE)
    for (params in
      listOf(
        PARAMS + ("totp" to "12345"),
        PARAMS + ("totpVer" to "12345"),
        PARAMS + ("reason" to "transport&sp_dc=x"),
        PARAMS + ("productType" to "-web"),
        PARAMS + ("sp_dc" to "another"),
        mapOf("url" to "https://example.org/"),
      )) {
      assertEquals(params.toString(), LoginErrorCode.BAD_REQUEST, failure(params).code)
    }
    assertEquals(0, spotify.server.requestCount)
  }

  @Test
  fun `says LOGGED_OUT without a kept login, and sends nothing`() {
    assertEquals(LoginErrorCode.LOGGED_OUT, failure().code)
    store.save(COOKIE)
    store.forget()
    assertEquals(LoginErrorCode.LOGGED_OUT, failure().code)
    assertEquals(0, spotify.server.requestCount)
  }

  @Test
  fun `says STORAGE when the keystore fails for a moment, sends nothing and keeps the login`() {
    store.save(COOKIE)
    cipher.openFailures.add(java.security.ProviderException("The keystore is busy"))
    assertEquals(LoginErrorCode.STORAGE, failure().code)
    assertEquals(0, spotify.server.requestCount)
    spotify.server.enqueue(token())
    assertEquals(200, call.request(PARAMS).status)
    assertEquals("sp_dc=$COOKIE", spotify.take().headers["Cookie"])
  }

  @Test
  fun `fails on a redirect, which the cookie never follows`() {
    store.save(COOKIE)
    spotify.server.enqueue(
      MockResponse.Builder()
        .code(302)
        .addHeader("Location", "https://api-partner.spotify.com/elsewhere")
        .build(),
    )
    assertEquals(LoginErrorCode.NETWORK, failure().code)
    assertEquals(1, spotify.server.requestCount)
  }

  @Test
  fun `passes Spotify's answer on with its status, as null when it is no JSON object`() {
    store.save(COOKIE)
    spotify.server.enqueue(MockResponse.Builder().code(400).body("""{"totpVerExpired":1}""").build())
    spotify.server.enqueue(MockResponse.Builder().code(502).body("<html>Bad gateway</html>").build())
    spotify.server.enqueue(token("12345"))
    spotify.server.enqueue(token("""{"a":1} trailing"""))
    val refused = call.request(PARAMS)
    assertEquals(400, refused.status)
    assertEquals(1, (refused.json as JSONObject).getInt("totpVerExpired"))
    for (status in listOf(502, 200, 200)) {
      val answer = call.request(PARAMS)
      assertEquals(status, answer.status)
      assertSame(JSONObject.NULL, answer.json)
    }
  }

  @Test
  fun `refuses an answer over 64 KiB`() {
    store.save(COOKIE)
    val huge = "{\"pad\":\"" + "x".repeat(LoginProtocol.MAX_TOKEN_BYTES.toInt()) + "\"}"
    spotify.server.enqueue(token(huge))
    assertEquals(LoginErrorCode.TOO_LARGE, failure().code)
    spotify.server.enqueue(
      MockResponse.Builder().chunkedBody(Buffer().writeUtf8(huge), 4096).build(),
    )
    assertEquals(LoginErrorCode.TOO_LARGE, failure().code)
  }

  @Test
  fun `rate limits to ten calls a minute, saying how long to wait`() {
    store.save(COOKIE)
    repeat(LoginProtocol.RATE_LIMIT_MAX + 1) { spotify.server.enqueue(token()) }
    repeat(LoginProtocol.RATE_LIMIT_MAX) {
      call.request(PARAMS)
      now += 1000
    }
    val limited = failure()
    assertEquals(LoginErrorCode.RATE_LIMITED, limited.code)
    assertEquals(
      LoginProtocol.RATE_LIMIT_WINDOW_MS - LoginProtocol.RATE_LIMIT_MAX * 1000L,
      limited.retryAfterMs,
    )
    assertEquals(LoginProtocol.RATE_LIMIT_MAX, spotify.server.requestCount)
    now += LoginProtocol.RATE_LIMIT_WINDOW_MS
    assertEquals(200, call.request(PARAMS).status)
  }

  @Test
  fun `times out, and fails when Spotify can't be reached`() {
    store.save(COOKIE)
    val impatient = SpotifyTokenCall(spotify.client, store, { now }, timeoutMs = 300)
    spotify.server.enqueue(token().newBuilder().headersDelay(5, TimeUnit.SECONDS).build())
    assertEquals(LoginErrorCode.TIMEOUT, failure(call = impatient).code)
    val gone = FakeSpotify().also { it.close() }
    val unreachable = SpotifyTokenCall(gone.client, store, { now })
    assertEquals(LoginErrorCode.NETWORK, failure(call = unreachable).code)
  }

  @Test
  fun `the URL is fixed in native code, and its parameters go in a fixed order`() {
    assertEquals(
      "https://open.spotify.com/api/token?reason=transport&totpVer=7",
      SpotifyTokenCall.tokenUrl(linkedMapOf("totpVer" to "7", "reason" to "transport")).toString(),
    )
    assertTrue(SpotifyTokenCall.TOKEN_URL.startsWith("https://open.spotify.com/"))
  }

  companion object {
    private val PARAMS =
      mapOf(
        "reason" to "transport",
        "productType" to "web-player",
        "totp" to "123456",
        "totpServer" to "654321",
        "totpVer" to "61",
      )

    private const val TOKEN_JSON =
      """{"clientId":"fake","accessToken":"fake-token","accessTokenExpirationTimestampMs":2000000,"isAnonymous":false}"""
  }
}
