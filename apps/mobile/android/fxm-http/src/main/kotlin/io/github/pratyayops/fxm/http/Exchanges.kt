package io.github.pratyayops.fxm.http

import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.ByteString
import okio.Pipe

/** What a request resolves with once its response headers are in. */
data class ResponseHead(
  val status: Int,
  /** The reason phrase; empty over HTTP/2. */
  val statusText: String,
  /** The final URL, after redirects. */
  val url: String,
  val redirected: Boolean,
  /** Name-value pairs with lower-case names, without `Set-Cookie`. */
  val headers: List<Pair<String, String>>,
  /** Whether there is a body to read; `false` for `HEAD` and for 204, 205 and 304. */
  val hasBody: Boolean,
)

/** The next piece of a response body; [done] when nothing follows. */
class Chunk(val bytes: ByteString, val done: Boolean)

/** A failure the plugin reports to JavaScript, as the bridge error [code]. */
data class BridgeError(val code: BridgeErrorCode, val message: String)

/** Receives the outcome of an asynchronous operation, on whichever thread finished it. */
interface Reply<T> {
  fun success(value: T)

  fun failure(error: BridgeError)
}

/**
 * The requests the web app has in flight through the plugin, by the id JavaScript gave each. A
 * request is pending until its headers arrive, then open while its body streams, then gone: read
 * to the end, failed, aborted, or idle for [idleTimeoutMs].
 *
 * Bodies stream through a bounded [Pipe]: a pump thread copies the network bytes into it as they
 * arrive, at most [bufferBytes] ahead, and each [read] takes what is there (waiting for at least
 * one byte). So a slow reader slows the download down instead of filling memory, and a fast one
 * gets large chunks.
 */
class Exchanges(
  private val client: OkHttpClient,
  /** Runs the pumps and the waiting reads; it must not limit its threads. */
  private val executor: ExecutorService,
  /** Milliseconds on a monotonic clock. */
  private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
  private val maxOpen: Int = 64,
  private val idleTimeoutMs: Long = 60_000,
  private val bufferBytes: Long = 1L shl 20,
) {
  private val exchanges = ConcurrentHashMap<String, Exchange>()

  /** How many requests are pending or open. */
  val size: Int
    get() = exchanges.size

  /** Starts [request] as [id]; [reply] gets the head once the headers are in. */
  fun start(id: String, request: Request, reply: Reply<ResponseHead>) {
    if (exchanges.size >= maxOpen) reapIdle()
    if (exchanges.size >= maxOpen) {
      return reply.failure(BridgeError(BridgeErrorCode.BUSY, "Too many open responses"))
    }
    val exchange = Exchange(client.newCall(request))
    if (exchanges.putIfAbsent(id, exchange) != null) {
      return reply.failure(BridgeError(BridgeErrorCode.BAD_REQUEST, "The id $id is in use"))
    }
    exchange.call.enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          exchanges.remove(id, exchange)
          reply.failure(bridgeError(e, request.url.host, exchange.aborted))
        }

        override fun onResponse(call: Call, response: Response) {
          val head = headOf(response)
          if (!head.hasBody) {
            response.close()
            exchanges.remove(id, exchange)
            if (exchange.aborted) return reply.failure(ABORTED)
            return reply.success(head)
          }
          if (!exchange.open(response)) {
            response.close()
            return reply.failure(ABORTED)
          }
          reply.success(head)
        }
      },
    )
  }

  /** Reads the next chunk of [id]'s body, at most [maxBytes], waiting for at least one byte. */
  fun read(id: String, maxBytes: Int, reply: Reply<Chunk>) {
    val exchange = exchanges[id] ?: return reply.failure(unknown(id))
    val pipe = exchange.pipe
      ?: return reply.failure(BridgeError(BridgeErrorCode.BAD_REQUEST, "$id has no body yet"))
    val limit = maxBytes.coerceIn(1, BridgeProtocol.MAX_READ_BYTES).toLong()
    exchange.reading.incrementAndGet()
    exchange.touch()
    val task = Runnable {
      try {
        val sink = Buffer()
        val count =
          try {
            pipe.source.read(sink, limit)
          } catch (e: IOException) {
            exchanges.remove(id, exchange)
            return@Runnable reply.failure(
              if (exchange.aborted) ABORTED else bridgeError(e, exchange.host, false),
            )
          }
        exchange.touch()
        if (count == -1L) {
          exchanges.remove(id, exchange)
          val failure = exchange.failure
          if (failure != null) reply.failure(bridgeError(failure, exchange.host, false))
          else reply.success(Chunk(ByteString.EMPTY, done = true))
          return@Runnable
        }
        val done = exchange.delivered(count)
        if (done) exchanges.remove(id, exchange)
        reply.success(Chunk(sink.readByteString(), done))
      } finally {
        exchange.reading.decrementAndGet()
      }
    }
    try {
      executor.execute(task)
    } catch (e: RejectedExecutionException) {
      exchange.reading.decrementAndGet()
      reply.failure(BridgeError(BridgeErrorCode.BUSY, "The plugin is shutting down"))
    }
  }

  /** Cancels [id]'s request or drops its response. Returns whether it was in flight. */
  fun abort(id: String): Boolean {
    val exchange = exchanges.remove(id) ?: return false
    exchange.abort()
    return true
  }

  /** Aborts everything, e.g. when the WebView goes away. */
  fun abortAll() {
    for (id in exchanges.keys.toList()) abort(id)
  }

  /**
   * Aborts open responses nobody has read for [idleTimeoutMs], such as bodies a page dropped
   * without cancelling. Pending requests are bounded by OkHttp's own timeouts instead. Returns how
   * many it aborted.
   */
  fun reapIdle(): Int {
    val now = clock()
    var reaped = 0
    for ((id, exchange) in exchanges) {
      if (exchange.pipe != null && exchange.reading.get() == 0 &&
        now - exchange.lastActive > idleTimeoutMs && abort(id)
      ) {
        reaped += 1
      }
    }
    return reaped
  }

  private inner class Exchange(val call: Call) {
    val host: String = call.request().url.host

    @Volatile var lastActive = clock()

    @Volatile var aborted = false

    @Volatile var pipe: Pipe? = null

    /** Why the body broke off, if it did. Set before the pump closes the pipe. */
    @Volatile var failure: IOException? = null

    @Volatile private var pumped = false

    private val written = AtomicLong()

    private val read = AtomicLong()

    val reading = AtomicInteger()

    fun touch() {
      lastActive = clock()
    }

    /** Starts pumping [response]'s body; `false` when the exchange was aborted meanwhile. */
    fun open(response: Response): Boolean {
      val pipe = Pipe(bufferBytes)
      synchronized(this) {
        if (aborted) return false
        this.pipe = pipe
      }
      touch()
      try {
        executor.execute { pump(response.body, pipe) }
      } catch (e: RejectedExecutionException) {
        failure = IOException("The plugin is shutting down", e)
        closeQuietly(pipe)
        response.close()
      }
      return true
    }

    private fun pump(body: ResponseBody, pipe: Pipe) {
      try {
        val source = body.source()
        val buffer = Buffer()
        while (true) {
          val count = source.read(buffer, SEGMENT_BYTES)
          if (count == -1L) break
          written.addAndGet(count)
          pipe.sink.write(buffer, count)
          pipe.sink.flush()
        }
      } catch (e: IOException) {
        if (!aborted) failure = e
      } finally {
        closeQuietly(pipe)
        pumped = true
        body.close()
      }
    }

    /** Counts [count] bytes as delivered; returns whether the body is now complete. */
    fun delivered(count: Long): Boolean {
      val total = read.addAndGet(count)
      return pumped && failure == null && total == written.get()
    }

    fun abort() {
      val pipe: Pipe?
      synchronized(this) {
        aborted = true
        pipe = this.pipe
      }
      call.cancel()
      pipe?.cancel()
    }
  }

  private fun closeQuietly(pipe: Pipe) {
    try {
      pipe.sink.close()
    } catch (_: IOException) {
      // Cancelled: the reader fails anyway.
    }
  }

  private fun unknown(id: String) =
    BridgeError(BridgeErrorCode.UNKNOWN_ID, "No open response has the id $id")

  companion object {
    private const val SEGMENT_BYTES = 8192L

    private val ABORTED = BridgeError(BridgeErrorCode.ABORTED, "The request was aborted")

    /** Statuses whose responses never have a body. */
    private val NO_BODY = setOf(204, 205, 304)

    /** The head JavaScript gets: no `Set-Cookie`, which no browser exposes either. */
    fun headOf(response: Response): ResponseHead {
      val headers = mutableListOf<Pair<String, String>>()
      for ((name, value) in response.headers) {
        val lower = name.lowercase()
        if (lower != "set-cookie" && lower != "set-cookie2") headers.add(lower to value)
      }
      val request = response.request
      return ResponseHead(
        status = response.code,
        statusText = response.message,
        url = request.url.toString(),
        redirected = (request.tag(Redirects::class.java)?.count ?: 0) > 0,
        headers = headers,
        hasBody = request.method != "HEAD" && response.code !in NO_BODY,
      )
    }

    /** The bridge error for a failed request or body. Messages name the host, never the URL. */
    fun bridgeError(error: Throwable, host: String, aborted: Boolean): BridgeError =
      when {
        aborted -> ABORTED
        error is FxmHttpException -> BridgeError(error.code, error.message ?: error.code.name)
        error is SocketTimeoutException ||
          (error is InterruptedIOException && error.message == "timeout") ->
          BridgeError(BridgeErrorCode.TIMEOUT, "$host did not answer in time")
        error is UnknownHostException ->
          BridgeError(BridgeErrorCode.NETWORK, "Could not find $host")
        error is SSLException ->
          BridgeError(BridgeErrorCode.NETWORK, "No secure connection to $host")
        else ->
          BridgeError(BridgeErrorCode.NETWORK, "Could not reach $host (${error.javaClass.simpleName})")
      }
  }
}
