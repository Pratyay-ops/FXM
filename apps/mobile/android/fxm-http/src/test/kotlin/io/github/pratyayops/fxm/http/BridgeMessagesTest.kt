package io.github.pratyayops.fxm.http

import okio.Buffer
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class BridgeMessagesTest {
  private fun options(vararg pairs: Pair<String, Any>) =
    JSONObject().put("id", "r1").put("url", "https://lrclib.net/api/get").apply {
      for ((key, value) in pairs) put(key, value)
    }

  private fun badRequest(options: JSONObject): String {
    try {
      BridgeMessages.request(options)
    } catch (e: FxmHttpException) {
      assertEquals(BridgeErrorCode.BAD_REQUEST, e.code)
      return e.message ?: ""
    }
    fail("expected BAD_REQUEST")
    throw AssertionError()
  }

  @Test
  fun `request options become the OkHttp request they describe`() {
    val (id, request) =
      BridgeMessages.request(
        options(
          "method" to "post",
          "url" to "https://music.youtube.com/youtubei/v1/search?prettyPrint=false",
          "headers" to JSONObject().put("content-type", "text/plain;charset=UTF-8").put("origin", ""),
          "body" to """{"query":"x"}""",
          "redirect" to "manual",
        ),
      )
    assertEquals("r1", id)
    assertEquals("POST", request.method)
    assertEquals("https://music.youtube.com/youtubei/v1/search?prettyPrint=false", request.url.toString())
    assertEquals("", request.header("origin"))
    assertEquals("text/plain;charset=UTF-8", request.body?.contentType().toString())
    assertEquals("""{"query":"x"}""", Buffer().also { request.body?.writeTo(it) }.readUtf8())
    assertEquals(RedirectMode.MANUAL, request.tag(RedirectMode::class.java))
  }

  @Test
  fun `defaults follow fetch`() {
    val (_, get) = BridgeMessages.request(options())
    assertEquals("GET", get.method)
    assertNull(get.body)
    assertEquals(RedirectMode.FOLLOW, get.tag(RedirectMode::class.java))
    val (_, post) = BridgeMessages.request(options("method" to "POST"))
    assertEquals(0L, post.body?.contentLength())
    val (_, text) = BridgeMessages.request(options("method" to "PUT", "body" to "hi"))
    assertEquals(BridgeMessages.TEXT_CONTENT_TYPE, text.header("Content-Type"))
    val (_, bytes) =
      BridgeMessages.request(options("method" to "PUT", "body" to "AAEC", "bodyEncoding" to "base64"))
    assertNull(bytes.header("Content-Type"))
    assertEquals(listOf<Byte>(0, 1, 2), Buffer().also { bytes.body?.writeTo(it) }.readByteArray().toList())
  }

  @Test
  fun `a declared content type is kept exactly`() {
    val (_, request) =
      BridgeMessages.request(
        options("method" to "POST", "headers" to JSONObject().put("Content-Type", "application/json"), "body" to "{}"),
      )
    assertEquals("application/json", request.body?.contentType().toString())
  }

  @Test
  fun `malformed options are refused as bad requests`() {
    badRequest(JSONObject().put("url", "https://lrclib.net/"))
    badRequest(options("id" to "has spaces"))
    badRequest(options("id" to "x".repeat(101)))
    badRequest(options("url" to "/relative"))
    badRequest(options("url" to "ftp://lrclib.net/"))
    badRequest(options("method" to "GE T"))
    badRequest(options("headers" to JSONObject().put("x-number", 1)))
    badRequest(options("headers" to JSONObject().put("bad name", "x")))
    badRequest(options("headers" to JSONObject().put("x-split", "a\r\nInjected: yes")))
    badRequest(options("method" to "POST", "body" to "%%%", "bodyEncoding" to "base64"))
    badRequest(options("method" to "POST", "body" to "x", "bodyEncoding" to "utf16"))
    badRequest(options("body" to "a GET with a body"))
    badRequest(options("method" to "HEAD", "body" to "x"))
    badRequest(options("redirect" to "sometimes"))
  }

  @Test
  fun `read sizes stay within the plugin's limit`() {
    assertEquals(BridgeProtocol.READ_BYTES, BridgeMessages.maxBytes(JSONObject()))
    assertEquals(1, BridgeMessages.maxBytes(JSONObject().put("maxBytes", 0)))
    assertEquals(4096, BridgeMessages.maxBytes(JSONObject().put("maxBytes", 4096)))
    assertEquals(BridgeProtocol.MAX_READ_BYTES, BridgeMessages.maxBytes(JSONObject().put("maxBytes", 1e12)))
  }

  @Test
  fun `hosts are normalized and malformed ones refused`() {
    val hosts = BridgeMessages.hosts(JSONObject().put("hosts", JSONArray(listOf("Invidious.Example.org", "invidious.example.org", "b.example:8443"))))
    assertEquals(listOf("invidious.example.org", "b.example:8443"), hosts)
    for (bad in listOf(JSONObject(), JSONObject().put("hosts", JSONArray(listOf(1))), JSONObject().put("hosts", JSONArray(listOf("https://x.example/"))))) {
      try {
        BridgeMessages.hosts(bad)
        fail("expected a refusal for $bad")
      } catch (e: FxmHttpException) {
        assertEquals(BridgeErrorCode.BAD_REQUEST, e.code)
      }
    }
  }

  @Test
  fun `heads and chunks are the JSON the TypeScript side reads`() {
    val head =
      BridgeMessages.head(
        "r1",
        ResponseHead(206, "Partial Content", "https://a.googlevideo.com/v", true, listOf("content-range" to "bytes 0-1/2"), true),
      )
    // Compared field by field: Android's org.json keeps the key order, the JVM's does not.
    assertEquals(7, head.length())
    assertEquals("r1", head.getString("id"))
    assertEquals(206, head.getInt("status"))
    assertEquals("Partial Content", head.getString("statusText"))
    assertEquals("https://a.googlevideo.com/v", head.getString("url"))
    assertEquals(true, head.getBoolean("redirected"))
    val pair = head.getJSONArray("headers").getJSONArray(0)
    assertEquals(listOf("content-range", "bytes 0-1/2"), listOf(pair.getString(0), pair.getString(1)))
    assertEquals(true, head.getBoolean("body"))
    val bytes = ByteArray(256) { it.toByte() }.toByteString()
    val chunk = BridgeMessages.chunk(Chunk(bytes, done = false))
    assertEquals(bytes, chunk.getString("data").decodeBase64())
    assertEquals(false, chunk.getBoolean("done"))
    assertEquals("""{"hosts":["a.example","b.example"]}""", BridgeMessages.hostList("hosts", setOf("b.example", "a.example")).toString())
  }
}
