package io.github.pratyayops.fxm.player

/**
 * The URIs of the player's playlist items: `fxm-entry://slot/<key>`, one per [Slot.key]. Media3
 * opens them through [EntryResolver], which looks up the current URL and headers in
 * [SourceTable], so a fresh URL needs no change to the playlist. Media3 never opens anything else:
 * a URI of another form (a controller asking to play some URL) is refused.
 */
object EntryUris {
  const val SCHEME = "fxm-entry"
  private const val PREFIX = "$SCHEME://slot/"
  private val KEY = Regex("[0-9]{1,18}")

  fun uri(key: Long): String = "$PREFIX$key"

  /** The slot key of [uri], or `null` when it is not one of these URIs. */
  fun keyOf(uri: String): Long? {
    if (!uri.startsWith(PREFIX)) return null
    val key = uri.substring(PREFIX.length)
    return if (KEY.matches(key)) key.toLongOrNull() else null
  }
}
