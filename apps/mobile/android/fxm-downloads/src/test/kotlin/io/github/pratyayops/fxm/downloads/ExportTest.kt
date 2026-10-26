package io.github.pratyayops.fxm.downloads

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ExportTest {
  @get:Rule val temp = TemporaryFolder()

  @Test
  fun `downloads are saved under names the media scanner files as audio`() {
    // WebM is Matroska: as .webm the scanner would make the song a video.
    assertEquals(ExportFormat("mka", "audio/x-matroska"), ExportFormats.of("opus", "webm", "audio"))
    assertEquals(ExportFormat("mka", "audio/x-matroska"), ExportFormats.of("vorbis", "webm", "audio"))
    assertEquals(ExportFormat("m4a", "audio/mp4"), ExportFormats.of("aac", "mp4", "audio"))
    assertEquals(ExportFormat("m4a", "audio/mp4"), ExportFormats.of("alac", "m4a", "audio"))
    assertEquals(ExportFormat("flac", "audio/flac"), ExportFormats.of("flac", "flac", "audio"))
    assertEquals(ExportFormat("mp3", "audio/mpeg"), ExportFormats.of("mp3", "mp3", "audio"))
    assertEquals(ExportFormat("opus", "audio/ogg"), ExportFormats.of("opus", "ogg", "audio"))
    assertEquals(ExportFormat("ogg", "audio/ogg"), ExportFormats.of("vorbis", "ogg", "audio"))
    assertEquals(ExportFormat("oga", "audio/ogg"), ExportFormats.of("flac", "ogg", "audio"))
    assertEquals(ExportFormat("wav", "audio/x-wav"), ExportFormats.of("pcm", "wav", "audio"))
  }

  @Test
  fun `video files and formats that don't fit their container are not saved`() {
    // YouTube's itag 18 is an MP4 video: its audio must be taken out first (stage 4.2).
    assertNull(ExportFormats.of("aac", "mp4", "muxed-video"))
    assertNull(ExportFormats.of("mp3", "webm", "audio"))
    assertNull(ExportFormats.of("opus", "mp4", "audio"))
    assertNull(ExportFormats.of("aac", "mkv", "audio"))
    assertNull(ExportFormats.of("", "", ""))
  }

  @Test
  fun `a saved song is named after its artists and title, safely`() {
    assertEquals("Radiohead - Creep.mka", ExportFormats.displayName("Creep", listOf("Radiohead"), "mka"))
    assertEquals(
      "Daft Punk, Pharrell Williams - Get Lucky.m4a",
      ExportFormats.displayName("Get Lucky", listOf("Daft Punk", " Pharrell  Williams ", ""), "m4a"),
    )
    assertEquals("Intro.mp3", ExportFormats.displayName("Intro", emptyList(), "mp3"))
    assertEquals("AC DC - Back In Black.mp3", ExportFormats.displayName("Back In Black", listOf("AC/DC"), "mp3"))
    assertEquals("What - Why Not.flac", ExportFormats.displayName("Why: Not?", listOf("What*"), "flac"))
    assertEquals("hidden.ogg", ExportFormats.displayName("...hidden", emptyList(), "ogg"))
    assertEquals("Tab Line.wav", ExportFormats.displayName("Tab\tLine\u0000", emptyList(), "wav"))
    assertEquals("${ExportFormats.FALLBACK_NAME}.mp3", ExportFormats.displayName(" / ", listOf(""), "mp3"))
  }

  @Test
  fun `long names are cut to fit, never inside a character`() {
    val name = ExportFormats.displayName("é".repeat(300), emptyList(), "flac")
    assertTrue(name.toByteArray(Charsets.UTF_8).size <= ExportFormats.MAX_NAME_BYTES)
    assertTrue(name.endsWith("é.flac"))
    val emoji = ExportFormats.displayName("🎵".repeat(100), emptyList(), "mp3")
    assertTrue(emoji.toByteArray(Charsets.UTF_8).size <= ExportFormats.MAX_NAME_BYTES)
    assertTrue(emoji.removeSuffix(".mp3").codePoints().allMatch { it == "🎵".codePointAt(0) })
  }

  @Test
  fun `a taken name gets a number`() {
    val taken = setOf("A - B.mp3", "A - B (1).mp3")
    assertEquals("A - B (2).mp3", ExportFormats.unique("A - B.mp3") { it in taken })
    assertEquals("C.mp3", ExportFormats.unique("C.mp3") { it in taken })
    assertEquals("noext (1)", ExportFormats.unique("noext") { it == "noext" })
    try {
      ExportFormats.unique("x.mp3") { true }
      fail("expected a DownloadFileException")
    } catch (e: DownloadFileException) {
      assertEquals(DownloadFiles.IO, e.code)
    }
  }

  /** Music/FXM in memory. */
  private class FakeFolder(var failWrite: Boolean = false) : MusicFolder {
    class Item(val name: String) : MusicFolder.Pending

    val files = linkedMapOf<String, ByteArray>()
    val pending = mutableSetOf<String>()
    val discarded = mutableListOf<String>()

    override fun find(displayName: String, size: Long): Exported? =
      files[displayName]?.takeIf { it.size.toLong() == size && displayName !in pending }?.let { Exported("content://media/x/$displayName", "Music/FXM/$displayName") }

    override fun create(displayName: String, format: ExportFormat, song: SongInfo): MusicFolder.Pending {
      val name = ExportFormats.unique(displayName) { it in files }
      files[name] = ByteArray(0)
      pending += name
      return Item(name)
    }

    override fun write(item: MusicFolder.Pending, copy: (OutputStream) -> Unit) {
      val name = (item as Item).name
      val out = ByteArrayOutputStream()
      copy(out)
      if (failWrite) throw IOException("write failed: ENOSPC (No space left on device)")
      files[name] = out.toByteArray()
    }

    override fun publish(item: MusicFolder.Pending): Exported {
      val name = (item as Item).name
      pending -= name
      return Exported("content://media/x/$name", "Music/FXM/$name")
    }

    override fun discard(item: MusicFolder.Pending) {
      val name = (item as Item).name
      discarded += name
      files.remove(name)
      pending -= name
    }
  }

  private val song = SongInfo("Creep", listOf("Radiohead"), "Pablo Honey")
  private val webm = ExportFormat("mka", "audio/x-matroska")

  @Test
  fun `a finished download is copied to Music, once`() {
    val folder = FakeFolder()
    val source = temp.newFile("0b9f").apply { writeBytes(byteArrayOf(1, 2, 3)) }
    val first = MusicExporter(folder).export(source, webm, song)
    assertEquals(Exported("content://media/x/Radiohead - Creep.mka", "Music/FXM/Radiohead - Creep.mka"), first)
    assertArrayEquals(byteArrayOf(1, 2, 3), folder.files["Radiohead - Creep.mka"])
    // Saved again: the same file, no copy.
    assertEquals(first, MusicExporter(folder).export(source, webm, song))
    assertEquals(1, folder.files.size)
    // Another song of the same name gets its own.
    val other = temp.newFile("1c2d").apply { writeBytes(byteArrayOf(9)) }
    assertEquals("Music/FXM/Radiohead - Creep (1).mka", MusicExporter(folder).export(other, webm, song).path)
  }

  @Test
  fun `a copy that fails leaves nothing behind`() {
    val folder = FakeFolder(failWrite = true)
    val source = temp.newFile("0b9f").apply { writeBytes(byteArrayOf(1, 2, 3)) }
    try {
      MusicExporter(folder).export(source, webm, song)
      fail("expected a DownloadFileException")
    } catch (e: DownloadFileException) {
      assertEquals(DownloadFiles.NO_SPACE, e.code)
    }
    assertEquals(listOf("Radiohead - Creep.mka"), folder.discarded)
    assertTrue(folder.files.isEmpty())
  }
}
