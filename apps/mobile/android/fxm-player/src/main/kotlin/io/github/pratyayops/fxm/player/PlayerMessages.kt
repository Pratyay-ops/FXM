package io.github.pratyayops.fxm.player

import io.github.pratyayops.fxm.downloads.DeviceFileRefusedException
import io.github.pratyayops.fxm.downloads.DeviceFiles
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/** A malformed message from the web app; the plugin rejects the call with `BAD_REQUEST`. */
class PlayerMessageException(message: String) : IllegalArgumentException(message)

/**
 * The FxmPlayer plugin's messages, as packages/player/src/native/plugin.ts sends and reads them:
 * entries and their sources from JSON, and [Event]s and [Session]s to JSON. Malformed options
 * throw a [PlayerMessageException]. Messages name entries, never URLs, because URLs carry
 * tokens.
 */
object PlayerMessages {
  /** The most entries one message may queue after the current one. */
  const val MAX_UPCOMING = 50

  /** The longest snapshot the web app may store: 4 Mi characters. */
  const val MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024

  /** The longest data the web app may attach to an entry. */
  const val MAX_ENTRY_DATA_CHARS = 16_384

  /** The longest [Source.fileKey]. */
  const val MAX_FILE_KEY_CHARS = 200

  private val ID = Regex("[A-Za-z0-9._:-]{1,100}")
  private val TOKEN = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")
  private const val MAX_HEADERS = 32
  private const val MAX_TEXT = 1000
  private const val MAX_ARTISTS = 50

  // --- From the web app ------------------------------------------------------------------------

  /** An entry; its file source, if it has one, must be one [local] allows. */
  fun entry(json: JSONObject?, local: DeviceFiles = DeviceFiles.NONE): Entry {
    if (json == null) throw bad("An entry is missing")
    val id = json.opt("id") as? String
    if (id == null || !ID.matches(id)) throw bad("Invalid entry id")
    val uid = wholeNumber(json.opt("uid")) ?: throw bad("Invalid entry uid")
    val data = optionalString(json, "data", MAX_ENTRY_DATA_CHARS)
    val source = source(json.optJSONObject("source"), local)
    return Entry(id, uid, source, metadata(json.optJSONObject("metadata")), data)
  }

  /** At most [MAX_UPCOMING] entries with distinct ids. */
  fun entries(array: JSONArray?, local: DeviceFiles = DeviceFiles.NONE): List<Entry> {
    if (array == null) return emptyList()
    if (array.length() > MAX_UPCOMING) throw bad("At most $MAX_UPCOMING entries can be queued")
    val entries = (0 until array.length()).map { entry(array.optJSONObject(it), local) }
    if (entries.map { it.id }.toSet().size != entries.size) throw bad("Entry ids must be unique")
    return entries
  }

  /**
   * A source: an HTTPS stream (`kind` `http`, the default), or a file on the device (`file`)
   * that [local] allows. A file has nothing but its URI: no headers, expiry, network or key.
   */
  fun source(json: JSONObject?, local: DeviceFiles = DeviceFiles.NONE): Source {
    if (json == null) throw bad("A source is missing")
    when (json.opt("kind")) {
      null, JSONObject.NULL, "http" -> {}
      "file" -> {
        val url = json.opt("url") as? String ?: throw bad("A file source needs a URI")
        val checked =
          try {
            local.check(url)
          } catch (e: DeviceFileRefusedException) {
            throw bad(e.message ?: "The player can't read that file")
          }
        return Source(checked, kind = SourceKind.FILE)
      }
      else -> throw bad("Unknown source kind")
    }
    val url = json.opt("url") as? String
    if (url == null || url.toHttpUrlOrNull()?.scheme != "https") {
      throw bad("A source needs an absolute HTTPS URL")
    }
    val headers = linkedMapOf<String, String>()
    val given = json.optJSONObject("headers")
    if (given != null) {
      if (given.length() > MAX_HEADERS) throw bad("Too many headers")
      for (name in given.keys()) {
        val value = given.opt(name) as? String ?: throw bad("Header values must be strings")
        if (!TOKEN.matches(name)) throw bad("Invalid header name")
        try {
          Headers.Builder().add(name, value)
        } catch (e: IllegalArgumentException) {
          throw bad("Invalid value for the $name header")
        }
        headers[name] = value
      }
    }
    val expiresAt = optionalNumber(json, "expiresAt")
    val network = optionalNumber(json, "network")?.let { if (it > Int.MAX_VALUE) null else it.toInt() }
    val ipBound =
      when (val value = json.opt("ipBound")) {
        null, JSONObject.NULL -> false
        is Boolean -> value
        else -> throw bad("ipBound must be a boolean")
      }
    val fileKey = optionalString(json, "fileKey", MAX_FILE_KEY_CHARS)?.takeIf { it.isNotEmpty() }
    return Source(url, headers, expiresAt, ipBound, network, fileKey)
  }

  fun metadata(json: JSONObject?): Metadata {
    if (json == null) throw bad("Metadata is missing")
    val title = text(json.opt("title")) ?: throw bad("An entry needs a title")
    val artists = json.optJSONArray("artists")
    val names =
      if (artists == null) {
        emptyList()
      } else {
        (0 until minOf(artists.length(), MAX_ARTISTS)).mapNotNull { text(artists.opt(it)) }
      }
    // An artwork URL the player could not fetch is left out rather than refused.
    val artwork = (json.opt("artworkUrl") as? String)?.takeIf { it.toHttpUrlOrNull()?.scheme == "https" }
    return Metadata(title, names, text(json.opt("album")), artwork, optionalNumber(json, "durationMs"))
  }

  fun repeat(value: Any?): Repeat =
    when (value) {
      null, JSONObject.NULL, "off", "all" -> Repeat.OFF
      "one" -> Repeat.ONE
      else -> throw bad("Unknown repeat mode")
    }

  /** A position in milliseconds: a finite, non-negative number. */
  fun position(json: JSONObject, name: String): Long = optionalNumber(json, name) ?: 0L

  fun volume(json: JSONObject): Float {
    val volume = (json.opt("volume") as? Number)?.toDouble() ?: throw bad("A volume is missing")
    if (volume.isNaN() || volume < 0 || volume > 1) throw bad("The volume must be from 0 to 1")
    return volume.toFloat()
  }

  fun hasMore(json: JSONObject): Boolean = json.optBoolean("hasMore", false)

  fun snapshot(json: JSONObject): String? {
    val data = json.opt("data")
    if (data == null || data == JSONObject.NULL) return null
    if (data !is String) throw bad("A snapshot must be a string")
    if (data.length > MAX_SNAPSHOT_CHARS) throw bad("The snapshot is too large")
    return data
  }

  // --- To the web app ----------------------------------------------------------------------------

  fun state(state: NativeState): JSONObject =
    JSONObject()
      .put("id", state.id ?: JSONObject.NULL)
      .put("positionMs", state.positionMs)
      .put("durationMs", state.durationMs)
      .put("playing", state.playing)
      .put("playWhenReady", state.playWhenReady)
      .put("state", state.state.wire)

  fun failure(failure: Failure): JSONObject =
    JSONObject()
      .put("type", failure.type.wire)
      .put("status", failure.status ?: JSONObject.NULL)
      .put("message", failure.message)

  /** The plugin event's name and payload. */
  fun event(event: Event): Pair<String, JSONObject> =
    when (event) {
      is Event.State -> "state" to state(event.state)
      is Event.Transition ->
        "transition" to
          JSONObject()
            .put("from", event.from ?: JSONObject.NULL)
            .put("to", event.to ?: JSONObject.NULL)
            .put("reason", event.reason.wire)
      is Event.Error -> "error" to failure(event.failure).put("id", event.id ?: JSONObject.NULL)
      is Event.Request -> "request" to JSONObject().put("id", event.id).put("reason", event.reason.wire)
      is Event.Command -> "command" to JSONObject().put("command", event.command.wire)
      is Event.Network -> "network" to network(event.id, event.cellular)
    }

  fun session(session: Session): JSONObject {
    val entries = JSONArray()
    for (entry in session.entries) entries.put(entryJson(entry))
    return state(session.state)
      .put("entries", entries)
      .put("error", session.error?.let(::failure) ?: JSONObject.NULL)
      .put("snapshot", session.snapshot ?: JSONObject.NULL)
      .put("network", network(session.network, session.cellular))
  }

  /** An entry as the web app sent it, so it can tell which queue item each one plays. */
  fun entryJson(entry: Entry): JSONObject {
    val headers = JSONObject()
    for ((name, value) in entry.source.headers) headers.put(name, value)
    val source =
      JSONObject()
        .put("url", entry.source.url)
        .put("headers", headers)
        .put("ipBound", entry.source.ipBound)
    if (entry.source.kind != SourceKind.HTTP) source.put("kind", entry.source.kind.wire)
    entry.source.expiresAt?.let { source.put("expiresAt", it) }
    entry.source.network?.let { source.put("network", it) }
    entry.source.fileKey?.let { source.put("fileKey", it) }
    val artists = JSONArray()
    for (artist in entry.metadata.artists) artists.put(artist)
    val metadata = JSONObject().put("title", entry.metadata.title).put("artists", artists)
    entry.metadata.album?.let { metadata.put("album", it) }
    entry.metadata.artworkUrl?.let { metadata.put("artworkUrl", it) }
    entry.metadata.durationMs?.let { metadata.put("durationMs", it) }
    val json =
      JSONObject()
        .put("id", entry.id)
        .put("uid", entry.uid)
        .put("source", source)
        .put("metadata", metadata)
    entry.data?.let { json.put("data", it) }
    return json
  }

  private fun network(id: Int, cellular: Boolean): JSONObject =
    JSONObject().put("id", id).put("cellular", cellular)

  // --- Helpers -----------------------------------------------------------------------------------

  private fun bad(message: String) = PlayerMessageException(message)

  private fun text(value: Any?): String? =
    (value as? String)?.trim()?.takeIf { it.isNotEmpty() }?.take(MAX_TEXT)

  /** An optional string of at most [max] characters; throws when it is something else. */
  private fun optionalString(json: JSONObject, name: String, max: Int): String? {
    val value = json.opt(name)
    if (value == null || value == JSONObject.NULL) return null
    if (value !is String) throw bad("$name must be a string")
    if (value.length > max) throw bad("$name is too long")
    return value
  }

  /** A whole, non-negative number, or `null` when [value] is none. */
  private fun wholeNumber(value: Any?): Long? {
    val number = value as? Number ?: return null
    val double = number.toDouble()
    if (double.isNaN() || double < 0 || double > MAX_SAFE_INTEGER || double != Math.floor(double)) {
      return null
    }
    return number.toLong()
  }

  /** An optional finite, non-negative number, rounded down; throws when it is something else. */
  private fun optionalNumber(json: JSONObject, name: String): Long? {
    val value = json.opt(name)
    if (value == null || value == JSONObject.NULL) return null
    val number = value as? Number ?: throw bad("$name must be a number")
    val double = number.toDouble()
    if (double.isNaN() || double < 0 || double > MAX_SAFE_INTEGER) throw bad("$name is out of range")
    return Math.floor(double).toLong()
  }

  /** JavaScript's `Number.MAX_SAFE_INTEGER`. */
  private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0
}
