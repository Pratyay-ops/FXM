package io.github.pratyayops.fxm.downloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAudioTest {
  /** A row as Android 11 and later give it. */
  private fun modern(vararg changes: Pair<String, Any?>): AudioRow {
    var row =
      AudioRow(
        id = 42,
        uriVolume = "external_primary",
        volume = "external_primary",
        relativePath = "Music/Radiohead/Pablo Honey/",
        displayName = "02 Creep.flac",
        title = "Creep",
        artist = "Radiohead",
        album = "Pablo Honey",
        albumArtist = "Radiohead",
        albumId = 7,
        track = 1002,
        cdTrackNumber = "2/12",
        discNumber = "1/1",
        year = 1993,
        durationMs = 238_640,
        mimeType = "audio/FLAC",
        size = 25_000_000,
        dateModified = 1_700_000_000,
        bitrate = 838_000,
        compilation = "0",
      )
    for ((name, value) in changes) {
      row =
        when (name) {
          "volume" -> (value as String?).let { row.copy(volume = it, uriVolume = it ?: "external") }
          "relativePath" -> row.copy(relativePath = value as String?)
          "displayName" -> row.copy(displayName = value as String?)
          "size" -> row.copy(size = value as Long?)
          else -> error(name)
        }
    }
    return row
  }

  @Test
  fun `a song becomes the item the web app lists`() {
    val json = DeviceAudio.toJson(modern(), null)!!
    assertEquals("42", json.getString("id"))
    assertEquals("content://media/external_primary/audio/media/42", json.getString("uri"))
    assertEquals("external_primary", json.getString("volume"))
    assertEquals("Music/Radiohead/Pablo Honey/02 Creep.flac", json.getString("path"))
    assertEquals("Creep", json.getString("title"))
    assertEquals("Radiohead", json.getString("artist"))
    assertEquals("Pablo Honey", json.getString("album"))
    assertEquals("Radiohead", json.getString("albumArtist"))
    assertEquals("7", json.getString("albumId"))
    assertEquals(2, json.getInt("track"))
    assertEquals(1, json.getInt("disc"))
    assertEquals(1993, json.getInt("year"))
    assertEquals(238_640L, json.getLong("durationMs"))
    assertEquals("audio/flac", json.getString("mimeType"))
    assertEquals(25_000_000L, json.getLong("size"))
    assertEquals(1_700_000_000_000L, json.getLong("modifiedMs"))
    assertEquals(838_000L, json.getLong("bitrate"))
    assertFalse(json.has("compilation"))
    assertFalse(json.has("sampleRate"))
  }

  @Test
  fun `songs on a memory card keep their volume`() {
    val json = DeviceAudio.toJson(modern("volume" to "1234-ABCD"), null)!!
    assertEquals("1234-abcd", json.getString("volume"))
    assertEquals("content://media/1234-ABCD/audio/media/42", json.getString("uri"))
  }

  @Test
  fun `before Android 10 the place comes from the file's path`() {
    val row = AudioRow(id = 5, uriVolume = "external", data = "/storage/emulated/0/Music/a.mp3", size = 10, mimeType = "audio/mpeg")
    val json = DeviceAudio.toJson(row, "/storage/emulated/0/")!!
    assertEquals("external_primary", json.getString("volume"))
    assertEquals("Music/a.mp3", json.getString("path"))
    assertEquals("content://media/external/audio/media/5", json.getString("uri"))
    assertEquals(
      "abcd-1234" to "Music/b.mp3",
      DeviceAudio.place(row.copy(data = "/storage/ABCD-1234/Music/b.mp3"), "/storage/emulated/0"),
    )
    // A path FXM can't place is left out.
    assertNull(DeviceAudio.place(row.copy(data = "/mnt/odd/c.mp3"), "/storage/emulated/0"))
    assertNull(DeviceAudio.place(row.copy(data = null), "/storage/emulated/0"))
    assertNull(DeviceAudio.place(row.copy(data = "/storage/emulated/0/../x.mp3"), "/storage/emulated/0"))
  }

  @Test
  fun `rows without a place or a size are left out`() {
    assertNull(DeviceAudio.toJson(modern("displayName" to " "), null))
    assertNull(DeviceAudio.toJson(modern("relativePath" to null), null))
    assertNull(DeviceAudio.toJson(modern("size" to 0L), null))
    assertNull(DeviceAudio.toJson(modern("size" to null), null))
    // A song in the volume's top folder.
    assertEquals("Song.mp3", DeviceAudio.toJson(modern("relativePath" to "/", "displayName" to "Song.mp3"), null)!!.getString("path"))
  }

  @Test
  fun `track and disc numbers come from the newer columns, else from TRACK`() {
    val row = AudioRow(id = 1, uriVolume = "external")
    assertEquals(3 to 2, DeviceAudio.numbers(row.copy(track = 2003)))
    assertEquals(7 to null, DeviceAudio.numbers(row.copy(track = 7)))
    assertEquals(null to null, DeviceAudio.numbers(row.copy(track = 0)))
    assertEquals(null to 1, DeviceAudio.numbers(row.copy(track = 1000)))
    assertEquals(4 to 2, DeviceAudio.numbers(row.copy(track = 1009, cdTrackNumber = " 4/10", discNumber = "2/2")))
    assertEquals(null to 3, DeviceAudio.numbers(row.copy(discNumber = "3")))
    assertEquals(9 to null, DeviceAudio.numbers(row.copy(track = 2005, cdTrackNumber = "9")))
  }

  @Test
  fun `MediaStore's unknown tags are no tags`() {
    assertNull(DeviceAudio.text("<unknown>"))
    assertNull(DeviceAudio.text("  "))
    assertNull(DeviceAudio.text(null))
    assertEquals("Björk", DeviceAudio.text(" Björk "))
    val json = DeviceAudio.toJson(modern().copy(artist = "<unknown>", album = "<unknown>", year = 0, compilation = "1"), null)!!
    assertFalse(json.has("artist"))
    assertFalse(json.has("album"))
    assertFalse(json.has("year"))
    assertTrue(json.getBoolean("compilation"))
  }
}
