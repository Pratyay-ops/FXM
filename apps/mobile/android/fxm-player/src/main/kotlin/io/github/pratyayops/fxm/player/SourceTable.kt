package io.github.pratyayops.fxm.player

import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/** The URL and headers to request for a playlist item. */
data class StreamRequest(val url: String, val headers: Map<String, String>)

/** Why Media3 may not open a playlist item: it is not one of the entries the web app sent. */
class UnknownEntryException(message: String) : IOException(message)

/**
 * The current [Source] of every playlist item, by [Slot.key]. The coordinator writes it on the
 * main thread; Media3's loader threads read it through [EntryResolver] each time they open an
 * item, so a fresh URL takes effect at the next request without touching the playlist.
 */
class SourceTable {
  private val sources = ConcurrentHashMap<Long, Source>()

  fun put(key: Long, source: Source) {
    sources[key] = source
  }

  fun remove(key: Long) {
    sources.remove(key)
  }

  /** Keeps only the [keys] still in the playlist. */
  fun retain(keys: Set<Long>) {
    sources.keys.retainAll(keys)
  }

  fun clear() {
    sources.clear()
  }

  operator fun get(key: Long): Source? = sources[key]

  /**
   * What to request for the item with [key]: its URL and its headers, without the ones the data
   * source manages itself (byte ranges, encodings, framing, cookies). Throws an
   * [UnknownEntryException] for a key the web app did not send, e.g. a playlist item a media
   * controller added, so Media3 fetches nothing but FXM's own entries.
   */
  fun requestFor(key: Long): StreamRequest {
    val source = sources[key] ?: throw UnknownEntryException("FXM's player only plays its own entries")
    return StreamRequest(source.url, requestHeaders(source.headers))
  }

  companion object {
    /**
     * Headers an entry may not set: the data source sets the byte range and asks for unencoded
     * bytes itself, OkHttp manages the framing, and fxm-http's shared client sends no cookies.
     * fxm-http's request policy drops most of them again; `Range` and `If-Range` would clash with
     * the data source's own.
     */
    val MANAGED: Set<String> =
      setOf(
        "range",
        "if-range",
        "accept-encoding",
        "cookie",
        "cookie2",
        "host",
        "connection",
        "keep-alive",
        "content-length",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "expect",
        "proxy-authorization",
        "proxy-connection",
      )

    fun requestHeaders(headers: Map<String, String>): Map<String, String> =
      headers.filterKeys { it.lowercase() !in MANAGED }
  }
}
