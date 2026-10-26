package io.github.pratyayops.fxm.downloads

import org.json.JSONObject

/**
 * One row of MediaStore's audio collection, as [DeviceMusicQuery] read it. A field is `null` when
 * the row has no value or this Android version has no such column (their API levels are in
 * CLEAN-ROOM.md).
 */
data class AudioRow(
  /** `_ID`. */
  val id: Long,
  /** The volume the item's content URI names: its `VOLUME_NAME` (Android 10+), else `external`. */
  val uriVolume: String,
  /** `VOLUME_NAME` (Android 10+): `external_primary`, or a removable volume's id. */
  val volume: String? = null,
  /** `RELATIVE_PATH` (Android 10+): the folder inside the volume, e.g. `Music/Artist/`. */
  val relativePath: String? = null,
  /** `DISPLAY_NAME`: the file's name. */
  val displayName: String? = null,
  /** `DATA` (Android 9 and older): the file's absolute path. */
  val data: String? = null,
  val title: String? = null,
  val artist: String? = null,
  val album: String? = null,
  /** `ALBUM_ARTIST` (Android 11+). */
  val albumArtist: String? = null,
  val albumId: Long? = null,
  /** `TRACK`: the disc number times 1000, plus the track number. */
  val track: Int? = null,
  /** `CD_TRACK_NUMBER` (Android 11+), e.g. `3` or `3/12`. */
  val cdTrackNumber: String? = null,
  /** `DISC_NUMBER` (Android 11+), e.g. `1` or `1/2`. */
  val discNumber: String? = null,
  val year: Int? = null,
  val durationMs: Long? = null,
  val mimeType: String? = null,
  val size: Long? = null,
  /** `DATE_MODIFIED`, in seconds. */
  val dateModified: Long? = null,
  /** `BITRATE` (Android 11+), in bits per second. */
  val bitrate: Long? = null,
  /** `COMPILATION` (Android 11+). */
  val compilation: String? = null,
  /** `SAMPLERATE` (Android 16+), in Hz. */
  val sampleRate: Int? = null,
  /** `BITS_PER_SAMPLE` (Android 16+). */
  val bitsPerSample: Int? = null,
)

/**
 * A song on the device as the web app gets it (`FxmDeviceAudio` in `apps/web`, stage 6.4): where
 * it is (its MediaStore URI, its volume, its path inside the volume), its tags as MediaStore read
 * them, and what the web app needs to notice a change (size, modification time).
 */
object DeviceAudio {
  /** The primary shared storage's MediaStore volume. */
  const val PRIMARY_VOLUME = "external_primary"

  /** What MediaStore says for a tag a file lacks, before Android 11. */
  private const val UNKNOWN = "<unknown>"

  /** A removable volume's path on Android 9 and older: `/storage/1234-ABCD/…`. */
  private val REMOVABLE = Regex("/storage/([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})/(.+)")

  /**
   * [row] as the web app's item, or `null` when it can't be placed (no path, no size). On
   * Android 9 and older the volume and path come from the file's absolute path, relative to
   * [primaryRoot] (the shared storage's root, e.g. `/storage/emulated/0`), so a song keeps its
   * place when the phone moves to Android 10.
   */
  fun toJson(row: AudioRow, primaryRoot: String?): JSONObject? {
    val (volume, path) = place(row, primaryRoot) ?: return null
    val size = row.size?.takeIf { it > 0 } ?: return null
    val (track, disc) = numbers(row)
    val json =
      JSONObject()
        .put("id", row.id.toString())
        .put("uri", "content://media/${row.uriVolume}/audio/media/${row.id}")
        .put("volume", volume)
        .put("path", path)
        .put("size", size)
        .put("modifiedMs", (row.dateModified ?: 0L) * 1000)
    text(row.title)?.let { json.put("title", it) }
    text(row.artist)?.let { json.put("artist", it) }
    text(row.album)?.let { json.put("album", it) }
    text(row.albumArtist)?.let { json.put("albumArtist", it) }
    row.albumId?.takeIf { it > 0 }?.let { json.put("albumId", it.toString()) }
    track?.let { json.put("track", it) }
    disc?.let { json.put("disc", it) }
    row.year?.takeIf { it in 1..9999 }?.let { json.put("year", it) }
    row.durationMs?.takeIf { it > 0 }?.let { json.put("durationMs", it) }
    text(row.mimeType)?.let { json.put("mimeType", it.lowercase()) }
    row.bitrate?.takeIf { it > 0 }?.let { json.put("bitrate", it) }
    if (row.compilation?.trim() == "1") json.put("compilation", true)
    row.sampleRate?.takeIf { it > 0 }?.let { json.put("sampleRate", it) }
    row.bitsPerSample?.takeIf { it > 0 }?.let { json.put("bitsPerSample", it) }
    return json
  }

  /** The volume and the path inside it, `/`-separated without a leading slash. */
  fun place(row: AudioRow, primaryRoot: String?): Pair<String, String>? {
    val relative = row.relativePath
    val name = row.displayName
    if (relative != null && !name.isNullOrBlank()) {
      val volume = row.volume?.lowercase() ?: PRIMARY_VOLUME
      return clean("$relative/$name")?.let { volume to it }
    }
    val data = row.data ?: return null
    val root = primaryRoot?.trimEnd('/')
    if (root != null && root.isNotEmpty() && data.startsWith("$root/")) {
      return clean(data.substring(root.length + 1))?.let { PRIMARY_VOLUME to it }
    }
    val removable = REMOVABLE.matchEntire(data) ?: return null
    val (uuid, inside) = removable.destructured
    return clean(inside)?.let { uuid.lowercase() to it }
  }

  /**
   * The track and disc numbers: from `CD_TRACK_NUMBER` and `DISC_NUMBER` where Android has them
   * (`3/12` is track 3), else from `TRACK`, which holds the disc times 1000 plus the track.
   */
  fun numbers(row: AudioRow): Pair<Int?, Int?> {
    val track = leadingNumber(row.cdTrackNumber)
    val disc = leadingNumber(row.discNumber)
    if (track != null || disc != null) return track to disc
    val encoded = row.track?.takeIf { it > 0 } ?: return null to null
    return (encoded % 1000).takeIf { it > 0 } to (encoded / 1000).takeIf { it > 0 }
  }

  /** A tag as text: trimmed, or `null` when empty or MediaStore's `<unknown>`. */
  fun text(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() && it != UNKNOWN }

  private fun leadingNumber(value: String?): Int? =
    value?.trim()?.substringBefore('/')?.trim()?.toIntOrNull()?.takeIf { it > 0 }

  /** A path without empty segments, `.` or `..`, or `null` when nothing is left of it. */
  private fun clean(path: String): String? {
    val parts = path.split('/').filter { it.isNotEmpty() && it != "." }
    if (parts.isEmpty() || parts.any { it == ".." }) return null
    return parts.joinToString("/")
  }
}
