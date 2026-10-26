package io.github.pratyayops.fxm.player

/**
 * Whether two sources serve the same bytes, so a player that has read part of the file through
 * one can read on through the other at the same byte offset: equal URLs, or the same
 * [Source.fileKey]. The web app sets the key from what it knows about the stream (for a
 * googlevideo URL, its format and the file's last-modified time, length and duration), so native
 * code knows nothing about any service's URLs and a change there needs no new APK. Anything else,
 * e.g. a fallback to another format, counts as different bytes.
 */
object StreamIdentity {
  fun sameBytes(a: Source, b: Source): Boolean = a.url == b.url || (a.fileKey != null && a.fileKey == b.fileKey)
}
