package io.github.pratyayops.fxm.http

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random
import mockwebserver3.MockResponse
import mockwebserver3.MockResponseBody
import mockwebserver3.SocketEffect
import okhttp3.OkHttpClient
import okio.Buffer
import okio.BufferedSink
import okio.ByteString
import okio.ByteString.Companion.toByteString
import okio.GzipSink
import okio.buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ExchangesTest {
  private lateinit var internet: FakeInternet
  private lateinit var executor: ExecutorService
  private val now = AtomicLong(0)
  private var nextId = 0

  @Before
  fun setUp() {
    internet = FakeInternet()
    executor = Executors.newCachedThreadPool()
  }

  @After
  fun tearDown() {
    executor.shutdownNow()
    internet.close()
  }

  private fun exchanges(
    client: OkHttpClient = internet.client(),
    maxOpen: Int = 64,
    maxOpenPerUserHost: Int = 8,
    idleTimeoutMs: Long = 60_000,
    stallTimeoutMs: Long = 60_000,
    bufferBytes: Long = 1L shl 20,
  ) =
    Exchanges(
      client,
      executor,
      { now.get() },
      maxOpen = maxOpen,
      maxOpenPerUserHost = maxOpenPerUserHost,
      headTimeoutMs = 60_000,
      idleTimeoutMs = idleTimeoutMs,
      evictIdleMs = 5_000,
      stallTimeoutMs = stallTimeoutMs,
      stallBytes = 8 * 1024,
      bufferBytes = bufferBytes,
    )

  /** Sends `request` options as the plugin receives them; returns the id and the head's reply. */
  private fun Exchanges.send(
    url: String,
    method: String = "GET",
    headers: Map<String, String> = emptyMap(),
    body: String? = null,
    bodyEncoding: String? = null,
    redirect: String? = null,
  ): Pair<String, Recorded<ResponseHead>> {
    nextId += 1
    val options = JSONObject().put("id", "t-$nextId").put("url", url).put("method", method)
    options.put("headers", JSONObject().apply { for ((name, value) in headers) put(name, value) })
    if (body != null) options.put("body", body)
    if (bodyEncoding != null) options.put("bodyEncoding", bodyEncoding)
    if (redirect != null) options.put("redirect", redirect)
    val (id, request) = BridgeMessages.request(options)
    val head = Recorded<ResponseHead>()
    start(id, request, head)
    return id to head
  }

  private fun Exchanges.readChunk(id: String, maxBytes: Int = BridgeProtocol.READ_BYTES): Recorded<Chunk> =
    Recorded<Chunk>().also { read(id, maxBytes, it) }

  /** Reads the body to the end, checking each chunk's size. */
  private fun Exchanges.readAll(id: String, maxBytes: Int = BridgeProtocol.READ_BYTES): ByteString {
    val all = Buffer()
    while (true) {
      val chunk = readChunk(id, maxBytes).value()
      assertTrue(chunk.bytes.size <= maxBytes)
      all.write(chunk.bytes)
      if (chunk.done) return all.readByteString()
      assertTrue("an empty chunk that is not the end", chunk.bytes.size > 0)
    }
  }

  @Test
  fun `the head arrives before the body, which streams as it comes`() {
    val gate = CountDownLatch(1)
    val first = "first part ".repeat(100).encodeToByteArray()
    val rest = "the rest".repeat(1000).encodeToByteArray()
    internet.server.enqueue(
      MockResponse.Builder()
        .body(
          object : MockResponseBody {
            override val contentLength = -1L

            override fun writeTo(sink: BufferedSink) {
              sink.write(first)
              sink.flush()
              gate.await(10, TimeUnit.SECONDS)
              sink.write(rest)
              sink.flush() // The server closes the connection next, dropping what is unflushed.
            }
          },
        )
        .onResponseEnd(SocketEffect.ShutdownConnection)
        .build(),
    )
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://music.youtube.com/youtubei/v1/search")
    assertEquals(200, head.value().status)
    assertTrue(head.value().hasBody)

    val start = Buffer()
    while (start.size < first.size) {
      val chunk = exchanges.readChunk(id).value()
      assertFalse(chunk.done)
      start.write(chunk.bytes)
    }
    assertArrayEquals("bytes arrived while the server still held the rest", first, start.readByteArray())
    val waiting = exchanges.readChunk(id)
    assertFalse("a read returned before any byte arrived", waiting.isDone(200))
    gate.countDown()
    val next = waiting.value()
    val tail = Buffer().write(next.bytes)
    if (!next.done) tail.write(exchanges.readAll(id))
    assertArrayEquals(rest, tail.readByteArray())
    assertEquals(0, exchanges.size)
  }

  @Test
  fun `bodies are binary-safe and come in chunks of at most the size asked for`() {
    val bytes = ByteArray(256) { it.toByte() } + Random(6_2).nextBytes(3 * 1024 * 1024)
    internet.server.enqueue(MockResponse.Builder().body(Buffer().write(bytes)).build())
    val exchanges = exchanges(bufferBytes = 64 * 1024)
    val (id, head) = exchanges.send("https://rr1---sn-x.googlevideo.com/videoplayback?itag=251")
    assertEquals(200, head.value().status)
    assertArrayEquals(bytes, exchanges.readAll(id, maxBytes = 100_000).toByteArray())
  }

  @Test
  fun `request bodies arrive byte for byte, text or base64`() {
    val payload = """{"context":{"client":{"clientName":"VISIONOS","hl":"hi"}},"query":"दिल से"}"""
    val bytes = ByteArray(256) { it.toByte() }
    repeat(3) { internet.server.enqueue(MockResponse.Builder().body("{}").build()) }
    val exchanges = exchanges()
    exchanges.send(
      "https://music.youtube.com/youtubei/v1/search?prettyPrint=false",
      method = "POST",
      headers = mapOf("content-type" to "text/plain;charset=UTF-8", "origin" to "", "user-agent" to BROWSER_AGENT),
      body = payload,
    ).second.value()
    exchanges.send(
      "https://lrclib.net/api/x",
      method = "POST",
      headers = mapOf("content-type" to "application/x-protobuf"),
      body = bytes.toByteString().base64(),
      bodyEncoding = "base64",
    ).second.value()
    exchanges.send("https://lrclib.net/api/y", method = "POST", body = "plain").second.value()

    val search = internet.take()
    assertEquals("POST", search.method)
    assertEquals("/youtubei/v1/search?prettyPrint=false", search.target)
    assertEquals(payload, search.body?.utf8())
    assertEquals("text/plain;charset=UTF-8", search.headers["Content-Type"])
    assertNull(search.headers["Origin"])
    assertNull(search.headers["Cookie"])
    assertEquals(BROWSER_AGENT, search.headers["User-Agent"])
    val proto = internet.take()
    assertArrayEquals(bytes, proto.body?.toByteArray())
    assertEquals("application/x-protobuf", proto.headers["Content-Type"])
    assertEquals(BridgeMessages.TEXT_CONTENT_TYPE, internet.take().headers["Content-Type"])
  }

  @Test
  fun `response heads carry the status, headers without Set-Cookie and decoded bodies`() {
    val gzipped = Buffer()
    GzipSink(gzipped).buffer().use { it.writeUtf8("""{"ok":true}""") }
    internet.server.enqueue(
      MockResponse.Builder()
        .code(203)
        .addHeader("Content-Type", "application/json; charset=UTF-8")
        .addHeader("Content-Encoding", "gzip")
        .addHeader("Set-Cookie", "YSC=x; Secure")
        .addHeader("X-Many", "a")
        .addHeader("X-Many", "b")
        .body(gzipped)
        .build(),
    )
    val exchanges = exchanges()
    val (id, reply) =
      exchanges.send("https://music.youtube.com/youtubei/v1/browse", headers = mapOf("accept-encoding" to "br"))
    val head = reply.value()
    assertEquals(203, head.status)
    assertEquals("https://music.youtube.com/youtubei/v1/browse", head.url)
    assertFalse(head.redirected)
    assertTrue(head.headers.none { it.first == "set-cookie" })
    assertEquals(listOf("a", "b"), head.headers.filter { it.first == "x-many" }.map { it.second })
    assertEquals("""{"ok":true}""", exchanges.readAll(id).utf8())
    assertEquals("gzip", internet.take().headers["Accept-Encoding"])
  }

  @Test
  fun `HEAD requests and statuses without a body release the response at once`() {
    internet.server.enqueue(MockResponse.Builder().addHeader("Content-Length", "1234").build())
    internet.server.enqueue(MockResponse.Builder().code(204).build())
    val exchanges = exchanges()
    val head = exchanges.send("https://rr1---sn-x.googlevideo.com/videoplayback", method = "HEAD").second.value()
    assertFalse(head.hasBody)
    assertFalse(exchanges.send("https://lrclib.net/api/z").second.value().hasBody)
    assertEquals(0, exchanges.size)
  }

  @Test
  fun `requests FXM's rules refuse never leave the device`() {
    internet.approved.add(listOf("invidious.example.org"))
    val exchanges = exchanges()
    val refusals =
      listOf(
        exchanges.send("http://music.youtube.com/youtubei/v1/search"),
        exchanges.send("https://evil.example.org/collect"),
        exchanges.send("https://music.youtube.com/youtubei/v1/search", headers = mapOf("origin" to "https://localhost")),
        exchanges.send("https://invidious.example.org/api/v1/search", method = "POST", body = "{}"),
      ).map { it.second.error() }
    assertEquals(
      listOf(
        BridgeErrorCode.HOST_NOT_ALLOWED,
        BridgeErrorCode.HOST_NOT_APPROVED,
        BridgeErrorCode.HEADER_NOT_ALLOWED,
        BridgeErrorCode.METHOD_NOT_ALLOWED,
      ),
      refusals.map { it.code },
    )
    assertEquals(listOf(null, "evil.example.org", null, null), refusals.map { it.host })
    assertEquals(0, internet.server.requestCount)
    assertEquals(0, exchanges.size)
  }

  @Test
  fun `approved user hosts work on any port`() {
    internet.approved.add(listOf("invidious.example.org"))
    internet.server.enqueue(MockResponse.Builder().body("ok").build())
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://invidious.example.org/api/v1/stats", headers = mapOf("authorization" to "Bearer x"))
    assertEquals(200, head.value().status)
    assertEquals("ok", exchanges.readAll(id).utf8())
    assertNull(internet.take().headers["Authorization"])
  }

  @Test
  fun `redirects within FXM's hosts are followed and checked hop by hop`() {
    internet.server.enqueue(
      MockResponse.Builder().code(302).addHeader("Location", "https://rr5---sn-y.googlevideo.com/videoplayback?x=1").build(),
    )
    internet.server.enqueue(MockResponse.Builder().body("media").build())
    val exchanges = exchanges()
    val (id, reply) = exchanges.send("https://rr1---sn-x.googlevideo.com/videoplayback?x=1", headers = mapOf("range" to "bytes=-65536"))
    val head = reply.value()
    assertEquals(200, head.status)
    assertTrue(head.redirected)
    assertEquals("https://rr5---sn-y.googlevideo.com/videoplayback?x=1", head.url)
    assertEquals("media", exchanges.readAll(id).utf8())
    internet.take()
    val second = internet.take()
    assertEquals("rr5---sn-y.googlevideo.com", second.url.host)
    assertEquals("bytes=-65536", second.headers["Range"])
  }

  @Test
  fun `a redirect FXM may not follow fails as a redirect, never as a refusal of the request's host`() {
    // A refused hop must not read as HOST_NOT_APPROVED: the app would ask the user to approve the
    // request's own host (lrclib.net, www.youtube.com), which they never added.
    internet.approved.add(listOf("invidious.example.org"))
    for (location in
      listOf(
        "https://tracker.example.org/x",
        "http://lrclib.net/",
        "https://invidious.example.org/api/v1/stats",
        "https://www.youtube.com/",
      )) {
      internet.server.enqueue(MockResponse.Builder().code(302).addHeader("Location", location).build())
    }
    val exchanges = exchanges()
    val errors = (1..4).map { exchanges.send("https://lrclib.net/$it").second.error() }
    assertEquals(List(4) { BridgeErrorCode.REDIRECT }, errors.map { it.code })
    assertEquals(List(4) { null }, errors.map { it.host })
    assertTrue(errors[0].message.contains("tracker.example.org"))
    assertEquals(4, internet.server.requestCount)
  }

  @Test
  fun `a user host's redirects stay on that host`() {
    internet.approved.add(listOf("invidious.example.org", "other.example.org"))
    internet.server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/api/v1/stats?x=1").build())
    internet.server.enqueue(MockResponse.Builder().body("ok").build())
    internet.server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://other.example.org/").build())
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://invidious.example.org/api/v1/stats")
    assertTrue(head.value().redirected)
    assertEquals("ok", exchanges.readAll(id).utf8())
    assertEquals(BridgeErrorCode.REDIRECT, exchanges.send("https://invidious.example.org/a").second.error().code)
    assertEquals(3, internet.server.requestCount)
  }

  @Test
  fun `redirect modes manual and error behave as in fetch`() {
    repeat(2) {
      internet.server.enqueue(MockResponse.Builder().code(307).addHeader("Location", "/elsewhere").build())
    }
    val exchanges = exchanges()
    val manual = exchanges.send("https://lrclib.net/a", redirect = "manual").second.value()
    assertEquals(307, manual.status)
    assertEquals("/elsewhere", manual.headers.first { it.first == "location" }.second)
    assertEquals(BridgeErrorCode.REDIRECT, exchanges.send("https://lrclib.net/b", redirect = "error").second.error().code)
  }

  @Test
  fun `endless redirects end with an error`() {
    repeat(PolicyInterceptor.MAX_REDIRECTS + 1) {
      internet.server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/again").build())
    }
    assertEquals(BridgeErrorCode.REDIRECT, exchanges().send("https://lrclib.net/loop").second.error().code)
  }

  @Test
  fun `aborting a pending request rejects it`() {
    internet.server.enqueue(MockResponse.Builder().headersDelay(5, TimeUnit.SECONDS).body("late").build())
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://lrclib.net/slow")
    assertTrue(exchanges.abort(id))
    assertEquals(BridgeErrorCode.ABORTED, head.error().code)
    assertEquals(0, exchanges.size)
    assertFalse(exchanges.abort(id))
  }

  @Test
  fun `aborting a streaming response fails the waiting read and frees the id`() {
    val gate = CountDownLatch(1)
    internet.server.enqueue(gated("start", gate))
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://lrclib.net/stream")
    head.value()
    assertEquals("start", exchanges.readChunk(id).value().bytes.utf8())
    val waiting = exchanges.readChunk(id)
    assertFalse(waiting.isDone(100))
    assertTrue(exchanges.abort(id))
    assertEquals(BridgeErrorCode.ABORTED, waiting.error().code)
    assertEquals(BridgeErrorCode.UNKNOWN_ID, exchanges.readChunk(id).error().code)
    gate.countDown()
  }

  @Test
  fun `a body that breaks off delivers what arrived, then a network error`() {
    val gate = CountDownLatch(1)
    internet.server.enqueue(gated("x".repeat(1000), gate, declaredLength = 100_000))
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://lrclib.net/broken")
    head.value()
    val received = Buffer()
    while (received.size < 1000) {
      val chunk = exchanges.readChunk(id).value()
      assertFalse(chunk.done)
      received.write(chunk.bytes)
    }
    gate.countDown() // The server closes the connection 99,000 bytes early.
    assertEquals(BridgeErrorCode.NETWORK, exchanges.readChunk(id).error().code)
    assertEquals(0, exchanges.size)
  }

  @Test
  fun `a server that stops sending times out`() {
    val gate = CountDownLatch(1)
    internet.server.enqueue(gated("0123456789", gate))
    val exchanges = exchanges(internet.client { readTimeout(300, TimeUnit.MILLISECONDS) })
    val (id, head) = exchanges.send("https://lrclib.net/stall")
    head.value()
    assertEquals("0123456789", exchanges.readChunk(id).value().bytes.utf8())
    assertEquals(BridgeErrorCode.TIMEOUT, exchanges.readChunk(id).error().code)
    gate.countDown()
  }

  @Test
  fun `responses nobody reads are dropped after a minute, reads in progress are not`() {
    val gate = CountDownLatch(1)
    repeat(2) { internet.server.enqueue(gated("a", gate)) }
    val exchanges = exchanges(stallTimeoutMs = 3_600_000)
    val (idle, idleHead) = exchanges.send("https://lrclib.net/idle")
    val (busy, busyHead) = exchanges.send("https://lrclib.net/busy")
    idleHead.value()
    busyHead.value()
    assertEquals("a", exchanges.readChunk(busy).value().bytes.utf8())
    val waiting = exchanges.readChunk(busy)
    now.addAndGet(59_000)
    assertEquals(0, exchanges.reap())
    now.addAndGet(2_000)
    assertEquals(1, exchanges.reap())
    assertEquals(BridgeErrorCode.UNKNOWN_ID, exchanges.readChunk(idle).error().code)
    assertFalse(waiting.isDone(100))
    gate.countDown()
    assertTrue(waiting.value().done)
  }

  @Test
  fun `a request whose head does not arrive within a minute fails with TIMEOUT`() {
    internet.server.enqueue(MockResponse.Builder().headersDelay(5, TimeUnit.SECONDS).body("late").build())
    val exchanges = exchanges()
    val (_, head) = exchanges.send("https://lrclib.net/slow")
    now.addAndGet(59_000)
    assertEquals(0, exchanges.reap())
    now.addAndGet(2_000)
    assertEquals(1, exchanges.reap())
    assertEquals(BridgeErrorCode.TIMEOUT, head.error().code)
    assertEquals(0, exchanges.size)
  }

  @Test
  fun `a body that stops arriving fails with TIMEOUT, even while a read waits for it`() {
    val gate = CountDownLatch(1)
    internet.server.enqueue(gated("start", gate))
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://lrclib.net/stalled")
    head.value()
    assertEquals("start", exchanges.readChunk(id).value().bytes.utf8())
    val waiting = exchanges.readChunk(id)
    assertFalse(waiting.isDone(100))
    now.addAndGet(61_000)
    assertEquals(1, exchanges.reap())
    assertEquals(BridgeErrorCode.TIMEOUT, waiting.error().code)
    gate.countDown()
  }

  @Test
  fun `a body that trickles in fails with TIMEOUT, though every read gets a byte`() {
    // A byte every 20 ms never trips OkHttp's read timeout, and kept a slot for ever before.
    internet.server.enqueue(
      MockResponse.Builder().body("x".repeat(100_000)).throttleBody(1, 20, TimeUnit.MILLISECONDS).build(),
    )
    val exchanges = exchanges()
    val (id, head) = exchanges.send("https://lrclib.net/trickle")
    head.value()
    assertTrue(exchanges.readChunk(id).value().bytes.size > 0)
    // Each step lands while the pump waits for its next byte: time spent waiting for the network.
    repeat(40) {
      now.addAndGet(5_000)
      Thread.sleep(25)
      assertTrue(exchanges.readChunk(id).value().bytes.size > 0)
    }
    assertEquals(1, exchanges.reap())
    assertEquals(BridgeErrorCode.UNKNOWN_ID, exchanges.readChunk(id).error().code)
  }

  @Test
  fun `waiting for a slow reader is not a stalled body`() {
    val bytes = Random(7).nextBytes(256 * 1024)
    internet.server.enqueue(MockResponse.Builder().body(Buffer().write(bytes)).build())
    val exchanges = exchanges(idleTimeoutMs = 3_600_000, bufferBytes = 16 * 1024)
    val (id, head) = exchanges.send("https://lrclib.net/large")
    head.value()
    Thread.sleep(500) // The pump fills the pipe, then waits for the reader.
    now.addAndGet(120_000)
    assertEquals(0, exchanges.reap())
    assertArrayEquals(bytes, exchanges.readAll(id).toByteArray())
  }

  @Test
  fun `one user-approved host holds only a few slots`() {
    internet.approved.add(listOf("invidious.example.org"))
    repeat(3) { internet.server.enqueue(MockResponse.Builder().headersDelay(5, TimeUnit.SECONDS).build()) }
    val exchanges = exchanges(maxOpenPerUserHost = 2)
    exchanges.send("https://invidious.example.org/1")
    exchanges.send("https://invidious.example.org/2")
    val third = exchanges.send("https://invidious.example.org/3").second.error()
    assertEquals(BridgeErrorCode.BUSY, third.code)
    assertTrue(third.message.contains("invidious.example.org"))
    exchanges.send("https://lrclib.net/other")
    assertEquals(3, exchanges.size)
    exchanges.abortAll()
  }

  @Test
  fun `when every slot is taken, responses unread for a few seconds make way`() {
    val gate = CountDownLatch(1)
    repeat(3) { internet.server.enqueue(gated("a", gate)) }
    val exchanges = exchanges(maxOpen = 2)
    val (first, firstHead) = exchanges.send("https://lrclib.net/1")
    val (second, secondHead) = exchanges.send("https://lrclib.net/2")
    firstHead.value()
    secondHead.value()
    now.addAndGet(1_000)
    assertEquals(BridgeErrorCode.BUSY, exchanges.send("https://lrclib.net/3").second.error().code)
    now.addAndGet(5_000)
    assertEquals("a", exchanges.readChunk(second).value().bytes.utf8()) // read just now: it stays
    val (_, thirdHead) = exchanges.send("https://lrclib.net/4")
    assertEquals(200, thirdHead.value().status)
    assertEquals(BridgeErrorCode.UNKNOWN_ID, exchanges.readChunk(first).error().code)
    assertEquals(2, exchanges.size)
    gate.countDown()
  }

  @Test
  fun `ids are unique while open and the number of open responses is bounded`() {
    repeat(3) { internet.server.enqueue(MockResponse.Builder().headersDelay(5, TimeUnit.SECONDS).build()) }
    val exchanges = exchanges(maxOpen = 2)
    val (id, _) = exchanges.send("https://lrclib.net/1")
    val duplicate = Recorded<ResponseHead>()
    val (_, request) =
      BridgeMessages.request(JSONObject().put("id", id).put("url", "https://lrclib.net/again"))
    exchanges.start(id, request, duplicate)
    assertEquals(BridgeErrorCode.BAD_REQUEST, duplicate.error().code)
    exchanges.send("https://lrclib.net/2")
    assertEquals(BridgeErrorCode.BUSY, exchanges.send("https://lrclib.net/3").second.error().code)
    exchanges.abortAll()
    assertEquals(0, exchanges.size)
  }

  @Test
  fun `reads of unknown ids and of bodies not there yet fail`() {
    internet.server.enqueue(MockResponse.Builder().headersDelay(5, TimeUnit.SECONDS).build())
    val exchanges = exchanges()
    assertEquals(BridgeErrorCode.UNKNOWN_ID, exchanges.readChunk("nope").error().code)
    val (id, _) = exchanges.send("https://lrclib.net/pending")
    assertEquals(BridgeErrorCode.BAD_REQUEST, exchanges.readChunk(id).error().code)
    exchanges.abort(id)
  }

  @Test
  fun `failures name the host and never the URL`() {
    val timeout = Exchanges.bridgeError(java.net.SocketTimeoutException("x"), "a.example", false)
    assertEquals(BridgeErrorCode.TIMEOUT, timeout.code)
    val dns = Exchanges.bridgeError(java.net.UnknownHostException("secret"), "a.example", false)
    assertEquals(BridgeError(BridgeErrorCode.NETWORK, "Could not find a.example"), dns)
    assertEquals(BridgeErrorCode.NETWORK, Exchanges.bridgeError(javax.net.ssl.SSLHandshakeException("x"), "a", false).code)
    assertEquals(BridgeErrorCode.ABORTED, Exchanges.bridgeError(IOException("Canceled"), "a", true).code)
    val other = Exchanges.bridgeError(IOException("https://a.example/?token=secret"), "a.example", false)
    assertFalse(other.message.contains("secret"))
  }

  /**
   * A response that sends [start], then nothing until [gate] opens, then ends by closing the
   * connection: the only end a body without a length has, and an early one for a longer
   * [declaredLength].
   */
  private fun gated(start: String, gate: CountDownLatch, declaredLength: Long = -1L) =
    MockResponse.Builder()
      .body(
        object : MockResponseBody {
          override val contentLength = declaredLength

          override fun writeTo(sink: BufferedSink) {
            sink.writeUtf8(start)
            sink.flush()
            gate.await(10, TimeUnit.SECONDS)
          }
        },
      )
      .onResponseEnd(SocketEffect.ShutdownConnection)
      .build()
}
