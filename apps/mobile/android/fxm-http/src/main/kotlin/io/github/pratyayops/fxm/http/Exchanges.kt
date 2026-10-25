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
import okhttp3.HttpUrl
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

/**
 * A failure the plugin reports to JavaScript, as the bridge error [code]. For
 * [BridgeErrorCode.HOST_NOT_APPROVED], [host] names the refused host (the error's `data.host`).
 */
data class BridgeError(val code: BridgeErrorCode, val message: String, val host: String? = null)

/** Receives the outcome of an asynchronous operation, on whichever thread finished it. */
interface Reply<T> {
  fun success(value: T)

  fun failure(error: BridgeError)
}

/**
 * The requests the web app has in flight through the plugin, by the id JavaScript gave each. A
 * request is pending until its headers arrive, then open while its body streams, then gone: read
 * to the end, failed, aborted, or dropped by [reap].
 *
 * Bodies stream through a bounded [Pipe]: a pump thread copies the network bytes into it as they
 * arrive, at most [bufferBytes] ahead, and each [read] takes what is there (waiting for at least
 * one byte). So a slow reader slows the download down instead of filling memory, and a fast one
 * gets large chunks.
 *
 * Nothing may keep one of the [maxOpen] slots for ever, or every other request of the app would
 * fail with `BUSY`. Besides responses nobody reads, [reap] drops requests whose head takes longer
 * than [headTimeoutMs], and bodies that arrive slower than [stallBytes] in [stallTimeoutMs] of
 * waiting for the network: OkHttp's read timeout alone lets a server that sends a byte now and
 * then keep a request open for ever. One host the user approved holds at most
 * [maxOpenPerUserHost] slots. These limits belong to the plugin, not to the shared client, which
 * Media3 also uses.
 */
class Exchanges(
  private val client: OkHttpClient,
  /** Runs the pumps and the waiting reads; it must not limit its threads. */
  private val executor: ExecutorService,
  /** Milliseconds on a monotonic clock. */
  private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
  private val maxOpen: Int = 64,
  /** The most requests to one host off FXM's table ([isUserHost]) pending or open at a time. */
  private val maxOpenPerUserHost: Int = 8,
  /** How long a request may wait for its response head before it fails with `TIMEOUT`. */
  private val headTimeoutMs: Long = 60_000,
  /** How long an open response may go unread before [reap] drops it. */
  private val idleTimeoutMs: Long = 60_000,
  /** How long a response must have gone unread to make way for a new one when no slot is free. */
  private val evictIdleMs: Long = 5_000,
  /** How long the pump may wait for the network while fewer than [stallBytes] arrive. */
  private val stallTimeoutMs: Long = 60_000,
  private val stallBytes: Long = 8L * 1024,
  private val bufferBytes: Long = 1L shl 20,
  /** Whether a URL's host is one the user approved rather than one of FXM's own services. */
  private val isUserHost: (HttpUrl) -> Boolean = { Hosts.ruleFor(it) == null },
) {
  private val exchanges = ConcurrentHashMap<String, Exchange>()

  /** How many requests are pending or open. */
  val size: Int
    get() = exchanges.size

  /**
   * Starts [request] as [id]; [reply] gets the head once the headers are in. When no slot is
   * free, responses unread for [evictIdleMs] make way; if that frees none, it fails with `BUSY`.
   */
  fun start(id: String, request: Request, reply: Reply<ResponseHead>) {
    val hostPort = Hosts.hostPort(request.url)
    val userHost = isUserHost(request.url)
    if (!hasRoom(hostPort, userHost)) reap(evictIdleMs)
    if (exchanges.size >= maxOpen) {
      return reply.failure(BridgeError(BridgeErrorCode.BUSY, "Too many open responses"))
    }
    if (userHost && openFor(hostPort) >= maxOpenPerUserHost) {
      return reply.failure(
        BridgeError(BridgeErrorCode.BUSY, "Too many open responses from $hostPort"),
      )
    }
    val exchange = Exchange(client.newCall(request), hostPort)
    if (exchanges.putIfAbsent(id, exchange) != null) {
      return reply.failure(BridgeError(BridgeErrorCode.BAD_REQUEST, "The id $id is in use"))
    }
    exchange.call.enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          exchanges.remove(id, exchange)
          reply.failure(
            if (exchange.aborted) exchange.abortError() else bridgeError(e, exchange.host, false),
          )
        }

        override fun onResponse(call: Call, response: Response) {
          val head = headOf(response)
          if (!head.hasBody) {
            response.close()
            exchanges.remove(id, exchange)
            if (exchange.aborted) return reply.failure(exchange.abortError())
            return reply.success(head)
          }
          if (!exchange.open(response)) {
            response.close()
            return reply.failure(exchange.abortError())
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
              if (exchange.aborted) exchange.abortError() else bridgeError(e, exchange.host, false),
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
  fun abort(id: String): Boolean = abort(id, timedOut = false)

  /** Aborts everything, e.g. when the WebView goes away. */
  fun abortAll() {
    for (id in exchanges.keys.toList()) abort(id)
  }

  /**
   * Drops what holds a slot for no good reason, and returns how many it dropped:
   *
   * - a request whose response head has not arrived within [headTimeoutMs]: it fails with
   *   `TIMEOUT`;
   * - an open response nobody has read for [idleMs] while no read waits, such as a body the page
   *   dropped without cancelling it;
   * - an open response whose pump has waited [stallTimeoutMs] for the network while fewer than
   *   [stallBytes] arrived: a waiting read fails with `TIMEOUT`. Time the pump spends waiting for
   *   a slow reader does not count.
   *
   * The plugin runs it every few seconds, and [start] with [evictIdleMs] when no slot is free.
   */
  fun reap(idleMs: Long = idleTimeoutMs): Int {
    val now = clock()
    var reaped = 0
    for ((id, exchange) in exchanges) {
      val timedOut =
        if (exchange.pipe == null) {
          now - exchange.startedAt > headTimeoutMs
        } else {
          exchange.stalledMs(now) > stallTimeoutMs
        }
      val idle =
        exchange.pipe != null && exchange.reading.get() == 0 && now - exchange.lastActive > idleMs
      if ((timedOut || idle) && abort(id, timedOut)) reaped += 1
    }
    return reaped
  }

  private fun abort(id: String, timedOut: Boolean): Boolean {
    val exchange = exchanges.remove(id) ?: return false
    exchange.abort(timedOut)
    return true
  }

  private fun hasRoom(hostPort: String, userHost: Boolean): Boolean =
    exchanges.size < maxOpen && (!userHost || openFor(hostPort) < maxOpenPerUserHost)

  private fun openFor(hostPort: String): Int = exchanges.values.count { it.hostPort == hostPort }

  private inner class Exchange(val call: Call, val hostPort: String) {
    val host: String = call.request().url.host

    val startedAt = clock()

    @Volatile var lastActive = startedAt

    @Volatile var aborted = false

    /** Whether [reap] ended it for taking too long, so its caller hears `TIMEOUT`. */
    @Volatile var timedOut = false

    @Volatile var pipe: Pipe? = null

    /** Why the body broke off, if it did. Set before the pump closes the pipe. */
    @Volatile var failure: IOException? = null

    @Volatile private var pumped = false

    /** When the pump's current network read began, or -1 while it is not waiting for the network. */
    @Volatile private var networkSince = -1L

    /** How long the pump has waited for the network since it last received [stallBytes]. */
    @Volatile private var waitedMs = 0L

    private val written = AtomicLong()

    private val read = AtomicLong()

    val reading = AtomicInteger()

    fun touch() {
      lastActive = clock()
    }

    /** How long the body has been stalled at [now]: see [reap]. Zero once it has all arrived. */
    fun stalledMs(now: Long): Long {
      if (pumped) return 0
      val since = networkSince
      return waitedMs + if (since >= 0) now - since else 0
    }

    /** The error for a call or body that [abort] ended. */
    fun abortError(): BridgeError =
      if (timedOut) BridgeError(BridgeErrorCode.TIMEOUT, "$host did not answer in time") else ABORTED

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
        var received = 0L
        while (true) {
          val started = clock()
          networkSince = started
          val count = source.read(buffer, SEGMENT_BYTES)
          val waited = clock() - started
          networkSince = -1
          if (count == -1L) break
          received += count
          if (received >= stallBytes) {
            received = 0
            waitedMs = 0
          } else {
            waitedMs += waited
          }
          written.addAndGet(count)
          pipe.sink.write(buffer, count)
          pipe.sink.flush()
        }
      } catch (e: IOException) {
        if (!aborted) failure = e
      } finally {
        networkSince = -1
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

    fun abort(timedOut: Boolean) {
      val pipe: Pipe?
      synchronized(this) {
        if (timedOut) this.timedOut = true
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
        error is FxmHttpException ->
          BridgeError(error.code, error.message ?: error.code.name, error.host)
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
