package io.github.pratyayops.fxm.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PlayerMessagesTest {
  private fun source(vararg pairs: Pair<String, Any>) =
    JSONObject().put("url", streamUrl()).put("ipBound", true).apply {
      for ((key, value) in pairs) put(key, value)
    }

  private fun entryJson(id: String = "e1", vararg pairs: Pair<String, Any>) =
    JSONObject()
      .put("id", id)
      .put("uid", 7)
      .put("source", source())
      .put("metadata", JSONObject().put("title", "Creep").put("artists", JSONArray().put("Radiohead")))
      .apply { for ((key, value) in pairs) put(key, value) }

  private fun bad(block: () -> Unit): String {
    try {
      block()
    } catch (e: PlayerMessageException) {
      return e.message ?: ""
    }
    fail("expected a PlayerMessageException")
    throw AssertionError()
  }

  @Test
  fun `an entry becomes the entry it describes`() {
    val json =
      entryJson(
        "s1-7",
        "source" to
          source(
            "headers" to JSONObject().put("Referer", "https://www.youtube.com/"),
            "expiresAt" to 1_800_000_021_600_000L,
            "network" to 3,
          ),
        "metadata" to
          JSONObject()
            .put("title", "  Creep ")
            .put("artists", JSONArray().put("Radiohead").put("").put(5))
            .put("album", "Pablo Honey")
            .put("artworkUrl", "https://i.ytimg.com/vi/x/hq.jpg")
            .put("durationMs", 238_640.6),
      )
    val entry = PlayerMessages.entry(json)
    assertEquals("s1-7", entry.id)
    assertEquals(7L, entry.uid)
    assertEquals(streamUrl(), entry.source.url)
    assertEquals(mapOf("Referer" to "https://www.youtube.com/"), entry.source.headers)
    assertEquals(1_800_000_021_600_000L, entry.source.expiresAt)
    assertTrue(entry.source.ipBound)
    assertEquals(3, entry.source.network)
    assertEquals(Metadata("Creep", listOf("Radiohead"), "Pablo Honey", "https://i.ytimg.com/vi/x/hq.jpg", 238_640L), entry.metadata)
  }

  @Test
  fun `an entry keeps the web app's data and file key, opaque`() {
    val json =
      entryJson(
        "e1",
        "source" to source("fileKey" to "googlevideo:251:1:4000000:", "kind" to "http"),
        "data" to "{\"codec\":\"opus\"}",
      )
    val entry = PlayerMessages.entry(json)
    assertEquals("googlevideo:251:1:4000000:", entry.source.fileKey)
    assertEquals("{\"codec\":\"opus\"}", entry.data)
    val back = PlayerMessages.entryJson(entry)
    assertEquals("{\"codec\":\"opus\"}", back.getString("data"))
    assertEquals(entry, PlayerMessages.entry(back))
    // An empty key names nothing.
    assertNull(PlayerMessages.source(source("fileKey" to "")).fileKey)
  }

  @Test
  fun `data, file keys and source kinds are checked`() {
    bad { PlayerMessages.entry(entryJson("e", "data" to 5)) }
    bad { PlayerMessages.entry(entryJson("e", "data" to "x".repeat(PlayerMessages.MAX_ENTRY_DATA_CHARS + 1))) }
    bad { PlayerMessages.source(source("fileKey" to 7)) }
    bad { PlayerMessages.source(source("fileKey" to "k".repeat(PlayerMessages.MAX_FILE_KEY_CHARS + 1))) }
    // Offline copies are another kind, which this version does not play yet.
    assertTrue(bad { PlayerMessages.source(source("kind" to "file")) }.contains("kind"))
    bad { PlayerMessages.source(source("ipBound" to "yes")) }
  }

  @Test
  fun `optional fields have defaults`() {
    val entry =
      PlayerMessages.entry(
        entryJson("e", "source" to JSONObject().put("url", "https://archive.org/download/x/a.flac")),
      )
    assertEquals(Source("https://archive.org/download/x/a.flac"), entry.source)
  }

  @Test
  fun `an artwork URL that is not HTTPS is left out`() {
    val metadata = JSONObject().put("title", "x").put("artworkUrl", "http://i.ytimg.com/a.jpg")
    assertNull(PlayerMessages.entry(entryJson("e", "metadata" to metadata)).metadata.artworkUrl)
  }

  @Test
  fun `malformed entries are refused`() {
    bad { PlayerMessages.entry(null) }
    bad { PlayerMessages.entry(entryJson("has space")) }
    bad { PlayerMessages.entry(entryJson("x".repeat(101))) }
    bad { PlayerMessages.entry(entryJson("e", "uid" to -1)) }
    bad { PlayerMessages.entry(entryJson("e", "uid" to 1.5)) }
    bad { PlayerMessages.entry(entryJson("e", "uid" to "7")) }
    bad { PlayerMessages.entry(entryJson("e", "metadata" to JSONObject().put("title", " "))) }
    bad { PlayerMessages.entry(entryJson("e", "source" to JSONObject())) }
  }

  @Test
  fun `sources must be HTTPS URLs with valid headers`() {
    bad { PlayerMessages.source(JSONObject().put("url", "http://media.test/a")) }
    bad { PlayerMessages.source(JSONObject().put("url", "file:///sdcard/a.mp3")) }
    bad { PlayerMessages.source(JSONObject().put("url", "fxm-entry://slot/1")) }
    bad { PlayerMessages.source(source("headers" to JSONObject().put("bad name", "x"))) }
    bad { PlayerMessages.source(source("headers" to JSONObject().put("Referer", "a\r\nb"))) }
    bad { PlayerMessages.source(source("headers" to JSONObject().put("Referer", 1))) }
    bad { PlayerMessages.source(source("expiresAt" to -1)) }
    bad { PlayerMessages.source(source("expiresAt" to "soon")) }
    val many = JSONObject()
    repeat(33) { many.put("x-$it", "v") }
    bad { PlayerMessages.source(source("headers" to many)) }
  }

  @Test
  fun `queues are bounded and their ids distinct`() {
    assertEquals(emptyList<Entry>(), PlayerMessages.entries(null))
    val two = JSONArray().put(entryJson("a")).put(entryJson("b"))
    assertEquals(listOf("a", "b"), PlayerMessages.entries(two).map { it.id })
    assertTrue(bad { PlayerMessages.entries(JSONArray().put(entryJson("a")).put(entryJson("a"))) }.contains("unique"))
    val tooMany = JSONArray()
    repeat(PlayerMessages.MAX_UPCOMING + 1) { tooMany.put(entryJson("e$it")) }
    bad { PlayerMessages.entries(tooMany) }
    bad { PlayerMessages.entries(JSONArray().put("not an entry")) }
  }

  @Test
  fun `repeat, positions, volume and snapshots`() {
    assertEquals(Repeat.OFF, PlayerMessages.repeat(null))
    assertEquals(Repeat.OFF, PlayerMessages.repeat("all"))
    assertEquals(Repeat.ONE, PlayerMessages.repeat("one"))
    bad { PlayerMessages.repeat("sometimes") }
    assertEquals(1234L, PlayerMessages.position(JSONObject().put("at", 1234.9), "at"))
    assertEquals(0L, PlayerMessages.position(JSONObject(), "at"))
    bad { PlayerMessages.position(JSONObject().put("at", -5), "at") }
    assertEquals(0.5f, PlayerMessages.volume(JSONObject().put("volume", 0.5)))
    bad { PlayerMessages.volume(JSONObject().put("volume", 1.5)) }
    bad { PlayerMessages.volume(JSONObject()) }
    assertEquals("x", PlayerMessages.snapshot(JSONObject().put("data", "x")))
    assertNull(PlayerMessages.snapshot(JSONObject()))
    bad { PlayerMessages.snapshot(JSONObject().put("data", 5)) }
    bad { PlayerMessages.snapshot(JSONObject().put("data", "x".repeat(PlayerMessages.MAX_SNAPSHOT_CHARS + 1))) }
    assertTrue(PlayerMessages.hasMore(JSONObject().put("hasMore", true)))
    assertFalse(PlayerMessages.hasMore(JSONObject()))
  }

  /** Compares flat JSON objects by value: org.json does not keep the order of keys. */
  private fun assertJson(expected: String, actual: JSONObject) {
    fun canonical(json: JSONObject) = json.keys().asSequence().sorted().map { "$it=${json.get(it)}" }.toList()
    assertEquals(canonical(JSONObject(expected)), canonical(actual))
  }

  @Test
  fun `events become the plugin events the web app listens to`() {
    val state = NativeState("a", 1_000, -1, true, true, PlaybackState.READY)
    val (name, json) = PlayerMessages.event(Event.State(state))
    assertEquals("state", name)
    assertJson(
      """{"id":"a","positionMs":1000,"durationMs":-1,"playing":true,"playWhenReady":true,"state":"ready"}""",
      json,
    )
    val (transition, moved) = PlayerMessages.event(Event.Transition("a", "b", TransitionReason.AUTO))
    assertEquals("transition", transition)
    assertJson("""{"from":"a","to":"b","reason":"auto"}""", moved)
    val error = PlayerMessages.event(Event.Error("a", Failure(FailureType.NETWORK, 403, "HTTP 403"))).second
    assertEquals("network", error.getString("type"))
    assertEquals(403, error.getInt("status"))
    assertEquals("a", error.getString("id"))
    assertTrue(PlayerMessages.event(Event.Error(null, Failure(FailureType.DECODE, null, "x"))).second.isNull("status"))
    assertJson("""{"id":"b","reason":"expiring"}""", PlayerMessages.event(Event.Request("b", RequestReason.EXPIRING)).second)
    assertJson("""{"command":"previous"}""", PlayerMessages.event(Event.Command(SystemCommand.PREVIOUS)).second)
    assertJson("""{"id":2,"cellular":true}""", PlayerMessages.event(Event.Network(2, true)).second)
  }

  @Test
  fun `a session carries its entries as the web app sent them`() {
    val entry = PlayerMessages.entry(entryJson("a", "source" to source("headers" to JSONObject().put("Referer", "r"), "expiresAt" to 5)))
    val session =
      Session(
        listOf(entry),
        NativeState("a", 10, 200, false, false, PlaybackState.IDLE),
        Failure(FailureType.EXPIRED, 403, "x"),
        "snap",
        4,
        false,
      )
    val json = PlayerMessages.session(session)
    assertEquals("a", json.getString("id"))
    assertEquals("idle", json.getString("state"))
    assertEquals("snap", json.getString("snapshot"))
    assertEquals("expired", json.getJSONObject("error").getString("type"))
    assertEquals(4, json.getJSONObject("network").getInt("id"))
    assertEquals(entry, PlayerMessages.entry(json.getJSONArray("entries").getJSONObject(0)))
    val empty = PlayerMessages.session(Session(emptyList(), NativeState(null, 0, -1, false, false, PlaybackState.IDLE), null, null, 0, false))
    assertTrue(empty.isNull("id"))
    assertTrue(empty.isNull("snapshot"))
    assertTrue(empty.isNull("error"))
  }
}
