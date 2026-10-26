package io.github.pratyayops.fxm.player

/** How the queue repeats, as far as the native player needs to know. */
enum class Repeat {
  /** Play the entries in order and stop after the last one (also repeat "all": JS lists the
   * wrapped-around entries itself). */
  OFF,

  /** Loop the current entry: the web app's repeat "one". */
  ONE,
}

/** Where a [Source]'s bytes are. */
enum class SourceKind(val wire: String) {
  /** At an HTTPS URL, fetched through fxm-http's shared client. */
  HTTP("http"),

  /**
   * On the device (fxm-downloads' `DeviceFiles`): an offline copy in the app's downloads folder
   * (a `file:` URI) or the device's own music (a MediaStore `content:` URI).
   */
  FILE("file"),
}

/**
 * Where an entry's audio comes from: a resolved stream URL and how to request it. The web app
 * resolves it (`StreamOption` in `@fxm/core`); native code never resolves anything itself.
 */
data class Source(
  /**
   * The HTTPS URL of the whole file, fetched with plain `GET`s; for a [SourceKind.FILE] source,
   * the `file:` or `content:` URI `DeviceFiles` checked.
   */
  val url: String,
  /** Request headers the URL needs, e.g. a `Referer`. FXM's network rules still apply. */
  val headers: Map<String, String> = emptyMap(),
  /** When the URL stops working, in epoch milliseconds; `null` when it does not expire. */
  val expiresAt: Long? = null,
  /** Whether the URL only works from the IP address that resolved it (YouTube's do). */
  val ipBound: Boolean = false,
  /**
   * The native network ([NetworkWatcher]'s generation) the web app resolved it on, or `null`
   * when it did not say; then it counts as resolved on the network current when it arrived.
   */
  val network: Int? = null,
  /**
   * Names the bytes the URL serves, or `null`: two sources with the same key serve the same file
   * ([StreamIdentity]). Opaque here; the web app sets it from what it knows about the stream.
   */
  val fileKey: String? = null,
  /** Where the bytes are. A file never expires and is bound to no network. */
  val kind: SourceKind = SourceKind.HTTP,
)

/** What the media notification, the lock screen and other system controls show for an entry. */
data class Metadata(
  val title: String,
  val artists: List<String> = emptyList(),
  val album: String? = null,
  /** An HTTPS image URL; fetched through FXM's network rules like the audio. */
  val artworkUrl: String? = null,
  val durationMs: Long? = null,
)

/**
 * One item of the native queue: a queue item of the web app's player (`uid`) with a resolved
 * [Source]. [id] is chosen by the web app and unique among the entries it has sent. [data] is the
 * web app's own data for the entry, opaque here and returned with it in the [Session].
 */
data class Entry(
  val id: String,
  val uid: Long,
  val source: Source,
  val metadata: Metadata,
  val data: String? = null,
)

/**
 * An [Entry] in the player's playlist. [key] names the bytes it plays: the playlist item's URI is
 * built from it ([EntryUris]), and [SourceTable] maps it to the current URL. A fresh URL for the
 * same file keeps the key; a different file (another format) gets a new one, so Media3 prepares
 * the item again instead of reading the new file at the old byte offsets.
 */
data class Slot(
  val entry: Entry,
  val key: Long,
  /** The native network generation its source belongs to. */
  val network: Int,
)
