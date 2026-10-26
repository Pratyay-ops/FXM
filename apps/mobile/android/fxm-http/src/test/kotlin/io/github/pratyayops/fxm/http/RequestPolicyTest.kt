package io.github.pratyayops.fxm.http

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RequestPolicyTest {
  private val approved =
    InMemoryApprovedHosts(
      listOf(
        "invidious.example.org",
        "media.example.org:8443",
        "other.example.org",
        // Hosts of FXM's own services, approved by an older build or a bug: never user hosts.
        "www.last.fm",
        "music.youtube.com:8443",
      ),
    )
  private val policy = RequestPolicy(approved, { BROWSER_AGENT })

  private fun request(url: String, vararg headers: Pair<String, String>, method: String = "GET") =
    Request.Builder()
      .url(url)
      .apply { for ((name, value) in headers) addHeader(name, value) }
      .method(method, if (method == "POST") "{}".toRequestBody(TEXT) else null)
      .build()

  private fun refusal(block: () -> Unit): BridgeErrorCode = refused(block).code

  private fun refused(block: () -> Unit): FxmHttpException {
    try {
      block()
    } catch (e: FxmHttpException) {
      return e
    }
    fail("expected a refusal")
    throw AssertionError()
  }

  @Test
  fun `classifies hosts on the table and hosts the user approved`() {
    assertEquals(HostClass.INNERTUBE, policy.classify("https://www.youtube.com/sw.js_data".toHttpUrl()).hostClass)
    assertEquals(HostClass.OPEN, policy.classify("https://lrclib.net/api/get".toHttpUrl()).hostClass)
    val user = policy.classify("https://invidious.example.org/api/v1/stats".toHttpUrl())
    assertNull(user.rule)
    assertNull(policy.classify("https://media.example.org:8443/a.webm".toHttpUrl()).rule)
  }

  @Test
  fun `refuses what FXM may not contact`() {
    assertEquals(BridgeErrorCode.HOST_NOT_ALLOWED, refusal { policy.classify("http://music.youtube.com/".toHttpUrl()) })
    assertEquals(BridgeErrorCode.HOST_NOT_ALLOWED, refusal { policy.classify("https://a:b@lrclib.net/".toHttpUrl()) })
    assertEquals(BridgeErrorCode.HOST_NOT_ALLOWED, refusal { policy.classify("https://music.youtube.com:8443/".toHttpUrl()) })
    assertEquals(BridgeErrorCode.HOST_NOT_ALLOWED, refusal { policy.classify("https://www.last.fm/user/x".toHttpUrl()) })
    assertEquals(BridgeErrorCode.HOST_NOT_APPROVED, refusal { policy.classify("https://evil.example/".toHttpUrl()) })
    assertEquals(BridgeErrorCode.HOST_NOT_APPROVED, refusal { policy.classify("https://media.example.org/a".toHttpUrl()) })
  }

  @Test
  fun `names the host the user has not approved, for the question JavaScript asks`() {
    val refusal = refused { policy.classify("https://Evil.Example:8443/collect?token=x".toHttpUrl()) }
    assertEquals(BridgeErrorCode.HOST_NOT_APPROVED, refusal.code)
    assertEquals("evil.example:8443", refusal.host)
    assertNull(refused { policy.classify("http://music.youtube.com/".toHttpUrl()) }.host)
  }

  @Test
  fun `never treats a host of FXM's own services as a user host, even approved`() {
    for (url in listOf("https://www.last.fm/user/x", "https://music.youtube.com:8443/youtubei/v1/search")) {
      assertEquals(url, BridgeErrorCode.HOST_NOT_ALLOWED, refusal { policy.classify(url.toHttpUrl()) })
    }
    assertEquals(HostClass.LASTFM_WEB, policy.classify("https://www.last.fm/player/station/x".toHttpUrl()).hostClass)
  }

  @Test
  fun `an empty Origin means none, and the WebView's origin never reaches a service`() {
    val none = policy.apply(request("https://music.youtube.com/youtubei/v1/search", "Origin" to ""))
    assertNull(none.header("Origin"))
    for (origin in listOf("https://localhost", "http://localhost", "capacitor://localhost", "null")) {
      assertEquals(
        origin,
        BridgeErrorCode.HEADER_NOT_ALLOWED,
        refusal { policy.apply(request("https://music.youtube.com/youtubei/v1/search", "Origin" to origin)) },
      )
    }
  }

  @Test
  fun `each host class gets only its own origins`() {
    val youtube = policy.apply(request("https://music.youtube.com/youtubei/v1/next", "origin" to "https://www.youtube.com"))
    assertEquals("https://www.youtube.com", youtube.header("Origin"))
    val media = policy.apply(request("https://rr1---sn-x.googlevideo.com/videoplayback", "Origin" to "https://music.youtube.com"))
    assertEquals("https://music.youtube.com", media.header("Origin"))
    val spotify = policy.apply(request("https://api-partner.spotify.com/pathfinder/v2/query", "Origin" to "https://open.spotify.com"))
    assertEquals("https://open.spotify.com", spotify.header("Origin"))
    assertEquals(
      BridgeErrorCode.HEADER_NOT_ALLOWED,
      refusal { policy.apply(request("https://open.spotify.com/api/token", "Origin" to "https://www.youtube.com")) },
    )
    assertEquals(
      BridgeErrorCode.HEADER_NOT_ALLOWED,
      refusal { policy.apply(request("https://lrclib.net/api/get", "Origin" to "https://open.spotify.com")) },
    )
  }

  @Test
  fun `a Referer must belong to an origin the host may receive`() {
    val ok = policy.apply(request("https://www.youtube.com/s/player/x/base.js", "Referer" to "https://www.youtube.com/watch?v=x"))
    assertEquals("https://www.youtube.com/watch?v=x", ok.header("Referer"))
    assertNull(policy.apply(request("https://www.youtube.com/", "Referer" to "")).header("Referer"))
    assertEquals(
      BridgeErrorCode.HEADER_NOT_ALLOWED,
      refusal { policy.apply(request("https://www.youtube.com/", "Referer" to "https://localhost/app/")) },
    )
  }

  @Test
  fun `drops cookies and the headers OkHttp manages, keeps the rest exactly`() {
    val applied =
      policy.apply(
        request(
          "https://music.youtube.com/youtubei/v1/player",
          "Cookie" to "SID=x",
          "Host" to "evil.example",
          "Connection" to "close",
          "Accept-Encoding" to "br",
          "Content-Length" to "99",
          "Transfer-Encoding" to "chunked",
          "Content-Type" to "text/plain;charset=UTF-8",
          "X-Custom" to "kept",
          "Range" to "bytes=0-1",
          method = "POST",
        ),
      )
    for (name in listOf("Cookie", "Host", "Connection", "Accept-Encoding", "Content-Length", "Transfer-Encoding")) {
      assertNull(name, applied.header(name))
    }
    assertEquals("text/plain;charset=UTF-8", applied.header("Content-Type"))
    assertEquals("kept", applied.header("X-Custom"))
    assertEquals("bytes=0-1", applied.header("Range"))
    assertEquals("POST", applied.method)
  }

  @Test
  fun `requests without a User-Agent get the browser's, and Spotify always gets a browser's`() {
    assertEquals(BROWSER_AGENT, policy.apply(request("https://music.youtube.com/youtubei/v1/search")).header("User-Agent"))
    val musicBrainz = policy.apply(request("https://musicbrainz.org/ws/2/url", "User-Agent" to "FXM/0.1 ( https://github.com/Pratyay-ops/FXM )"))
    assertEquals("FXM/0.1 ( https://github.com/Pratyay-ops/FXM )", musicBrainz.header("User-Agent"))
    for (agent in listOf("okhttp/5.4.0", "Dalvik/2.1.0 (Linux; U; Android 15)", "FXM/0.1")) {
      val spotify = policy.apply(request("https://api-partner.spotify.com/pathfinder/v2/query", "User-Agent" to agent))
      assertEquals(agent, BROWSER_AGENT, spotify.header("User-Agent"))
    }
    val desktop = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
    assertEquals(desktop, policy.apply(request("https://open.spotify.com/api/token", "User-Agent" to desktop)).header("User-Agent"))
    assertTrue(RequestPolicy.isBrowserAgent(BROWSER_AGENT))
    assertFalse(RequestPolicy.isBrowserAgent(null))
  }

  @Test
  fun `user hosts get GET and HEAD only, with a few harmless headers`() {
    val applied =
      policy.apply(
        request(
          "https://invidious.example.org/latest_version?id=x",
          "Range" to "bytes=0-",
          "Authorization" to "Bearer spotify-token",
          "Origin" to "https://open.spotify.com",
          "X-Goog-Visitor-Id" to "v",
        ),
      )
    assertEquals("bytes=0-", applied.header("Range"))
    assertNull(applied.header("Authorization"))
    assertNull(applied.header("Origin"))
    assertNull(applied.header("X-Goog-Visitor-Id"))
    assertEquals(BROWSER_AGENT, applied.header("User-Agent"))
    assertEquals(
      BridgeErrorCode.METHOD_NOT_ALLOWED,
      refusal { policy.apply(request("https://invidious.example.org/api", method = "POST")) },
    )
    assertEquals(
      BridgeErrorCode.METHOD_NOT_ALLOWED,
      refusal { policy.apply(request("https://lrclib.net/", method = "TRACE")) },
    )
  }

  @Test
  fun `redirects turn POST into GET as fetch does and keep it for 307 and 308`() {
    val post =
      policy.apply(request("https://music.youtube.com/youtubei/v1/player", "Content-Type" to "text/plain;charset=UTF-8", method = "POST"))
    for (status in listOf(301, 302, 303)) {
      val next = policy.redirect(post, "https://www.youtube.com/next".toHttpUrl(), status)
      assertEquals("GET", next.method)
      assertNull(next.body)
      assertNull(next.header("Content-Type"))
    }
    for (status in listOf(307, 308)) {
      val next = policy.redirect(post, "https://www.youtube.com/next".toHttpUrl(), status)
      assertEquals("POST", next.method)
      assertEquals("text/plain;charset=UTF-8", next.header("Content-Type"))
    }
  }

  @Test
  fun `redirects drop credentials across origins and origins the new host may not receive`() {
    val spotify =
      policy.apply(
        request(
          "https://api-partner.spotify.com/pathfinder/v2/query",
          "Authorization" to "Bearer t",
          "Origin" to "https://open.spotify.com",
        ),
      )
    val same = policy.redirect(spotify, "https://api-partner.spotify.com/other".toHttpUrl(), 302)
    assertEquals("Bearer t", same.header("Authorization"))
    val other = policy.redirect(spotify, "https://spclient.wg.spotify.com/x".toHttpUrl(), 302)
    assertNull(other.header("Authorization"))
    assertEquals("https://open.spotify.com", other.header("Origin"))
    assertEquals(
      BridgeErrorCode.HOST_NOT_APPROVED,
      refusal { policy.redirect(spotify, "https://evil.example/".toHttpUrl(), 302) },
    )
    assertEquals(
      BridgeErrorCode.HOST_NOT_ALLOWED,
      refusal { policy.redirect(spotify, "http://api-partner.spotify.com/".toHttpUrl(), 302) },
    )
  }

  @Test
  fun `redirects stay in their host's class, and a user host's on that host`() {
    val media = policy.apply(request("https://rr1---sn-x.googlevideo.com/videoplayback?itag=251"))
    assertEquals(
      "rr5---sn-y.googlevideo.com",
      policy.redirect(media, "https://rr5---sn-y.googlevideo.com/videoplayback".toHttpUrl(), 302).url.host,
    )
    val archive = policy.apply(request("https://archive.org/download/x/y.flac"))
    policy.redirect(archive, "https://ia800300.us.archive.org/y.flac".toHttpUrl(), 302)
    val user = policy.apply(request("https://invidious.example.org/a"))
    assertEquals("/b", policy.redirect(user, "https://invidious.example.org/b".toHttpUrl(), 302).url.encodedPath)
    for ((from, to) in
      listOf(
        archive to "https://www.youtube.com/watch",
        policy.apply(request("https://api-partner.spotify.com/pathfinder/v2/query")) to
          "https://rr2---sn-y.googlevideo.com/videoplayback",
        archive to "https://invidious.example.org/a",
        user to "https://other.example.org/a",
        user to "https://lrclib.net/api/get",
      )) {
      assertEquals(to, BridgeErrorCode.REDIRECT, refusal { policy.redirect(from, to.toHttpUrl(), 302) })
    }
  }

  companion object {
    private val TEXT = "text/plain;charset=UTF-8".toMediaType()
  }
}
