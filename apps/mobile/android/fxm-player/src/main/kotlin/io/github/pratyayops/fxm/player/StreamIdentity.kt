package io.github.pratyayops.fxm.player

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Whether two stream URLs serve the same bytes, so a player that has read part of the file
 * through one can read on through the other at the same byte offset. True for equal URLs, and
 * for two googlevideo URLs of the same file: the same `itag` (format) and `lmt` (the encoded
 * file's last-modified time), and the same `clen` (content length) and `dur` where both carry
 * one. A fresh URL for the same YouTube format differs in its signature, expiry and IP fields
 * only. Anything else, e.g. a fallback to another format, counts as different bytes.
 */
object StreamIdentity {
  private const val GOOGLEVIDEO = "googlevideo.com"

  fun sameBytes(a: String, b: String): Boolean {
    if (a == b) return true
    val first = a.toHttpUrlOrNull() ?: return false
    val second = b.toHttpUrlOrNull() ?: return false
    if (!isGooglevideo(first) || !isGooglevideo(second)) return false
    val itag = first.queryParameter("itag") ?: return false
    val lmt = first.queryParameter("lmt") ?: return false
    if (second.queryParameter("itag") != itag || second.queryParameter("lmt") != lmt) return false
    return sameWhereBoth(first, second, "clen") && sameWhereBoth(first, second, "dur")
  }

  private fun isGooglevideo(url: HttpUrl): Boolean =
    url.host.endsWith(".$GOOGLEVIDEO") && url.scheme == "https"

  private fun sameWhereBoth(first: HttpUrl, second: HttpUrl, name: String): Boolean {
    val one = first.queryParameter(name) ?: return true
    val two = second.queryParameter(name) ?: return true
    return one == two
  }
}
