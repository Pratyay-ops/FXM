package io.github.pratyayops.fxm.player

import androidx.media3.common.PlaybackException
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.FileDataSource
import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LocalSourcesTest {
  @get:Rule val temp = TemporaryFolder()

  /** The app's files, its downloads folder with one download, and a file it must not play. */
  private fun app(): Triple<LocalSources, File, File> {
    val files = temp.newFolder("files")
    val downloads = File(files, "downloads").apply { mkdirs() }
    val song = File(downloads, "0b9f-song").apply { writeText("audio") }
    val secret = File(files, "secret.txt").apply { writeText("token") }
    return Triple(LocalSources(listOf(downloads)), song, secret)
  }

  private fun refused(local: LocalSources, url: String): String {
    try {
      local.check(url)
    } catch (e: PlayerMessageException) {
      return e.message ?: ""
    }
    fail("expected $url to be refused")
    throw AssertionError()
  }

  @Test
  fun `a download in the downloads folder plays from its canonical file URI`() {
    val (local, song) = app()
    val uri = local.check("file://${song.absolutePath}")
    assertEquals("file://${song.canonicalPath}", uri)
    // The single-slash form names the same file.
    assertEquals(uri, local.check("file:${song.absolutePath}"))
    assertEquals(uri, LocalSources.fileUri(song.canonicalFile))
  }

  @Test
  fun `files outside the downloads folder are refused, however they are named`() {
    val (local, song, secret) = app()
    val downloads = song.parentFile!!
    refused(local, "file://${secret.absolutePath}")
    refused(local, "file://${downloads.absolutePath}/../secret.txt")
    refused(local, "file://${downloads.absolutePath}/%2E%2E/secret.txt")
    // The folder itself, and a folder whose name only starts like it.
    refused(local, "file://${downloads.absolutePath}")
    val lookalike = File(downloads.parentFile, "downloads-old").apply { mkdirs() }
    refused(local, "file://${File(lookalike, "a").absolutePath}")
    // A link inside the folder that points out of it.
    val link = File(downloads, "link")
    Files.createSymbolicLink(link.toPath(), secret.toPath())
    refused(local, "file://${link.absolutePath}")
  }

  @Test
  fun `file URIs need an absolute path and nothing else`() {
    val (local, song) = app()
    refused(local, "file://host${song.absolutePath}")
    refused(local, "file://${song.absolutePath}?x=1")
    refused(local, "file://${song.absolutePath}#x")
    refused(local, "file:relative/path")
    refused(local, "not a uri")
    refused(local, "https://media.test/a.webm")
    refused(local, "fxm-entry://slot/1")
  }

  @Test
  fun `the device's music plays from MediaStore audio URIs only`() {
    val (local) = app()
    for (uri in listOf(
      "content://media/external/audio/media/42",
      "content://media/external_primary/audio/media/42",
      "content://media/1234-abcd/audio/media/7",
    )) {
      assertEquals(uri, local.check(uri))
    }
    refused(local, "content://media/external/images/media/42")
    refused(local, "content://media/external/audio/albums/42")
    refused(local, "content://media/external/audio/media/42/thumbnail")
    refused(local, "content://media/external/audio/media/x")
    refused(local, "content://media/../audio/media/42")
    refused(local, "content://media/external/audio/media/42?mode=w")
    refused(local, "content://io.github.pratyayops.fxm.fileprovider/downloads/a")
    refused(local, "content://com.android.contacts/contacts/1")
  }

  @Test
  fun `without a downloads folder nothing on the device but its music plays`() {
    val (_, song) = app()
    refused(LocalSources.NONE, "file://${song.absolutePath}")
    assertEquals("content://media/external/audio/media/1", LocalSources.NONE.check("content://media/external/audio/media/1"))
  }

  @Test
  fun `file sources come from the web app as their own kind`() {
    val (local, song) = app()
    val json = JSONObject().put("kind", "file").put("url", "file://${song.absolutePath}")
    val source = PlayerMessages.source(json, local)
    assertEquals(Source("file://${song.canonicalPath}", kind = SourceKind.FILE), source)
    // Without the folder the message is refused, as is a file elsewhere.
    try {
      PlayerMessages.source(json)
      fail("expected a PlayerMessageException")
    } catch (expected: PlayerMessageException) {
      // The downloads folder is unknown here.
    }
    try {
      PlayerMessages.source(JSONObject().put("kind", "file"), local)
      fail("expected a PlayerMessageException")
    } catch (expected: PlayerMessageException) {
      // No URI.
    }
  }

  @Test
  fun `a file source keeps nothing but its URI and comes back as a file`() {
    val (local, song) = app()
    val source =
      PlayerMessages.source(
        JSONObject()
          .put("kind", "file")
          .put("url", "file://${song.absolutePath}")
          .put("headers", JSONObject().put("Referer", "https://www.youtube.com/"))
          .put("expiresAt", 5)
          .put("ipBound", true)
          .put("fileKey", "k"),
        local,
      )
    assertEquals(Source("file://${song.canonicalPath}", kind = SourceKind.FILE), source)
    val entry = Entry("e1", 3, source, Metadata("Song"))
    val json = PlayerMessages.entryJson(entry)
    assertEquals("file", json.getJSONObject("source").getString("kind"))
    assertEquals(entry, PlayerMessages.entry(json, local))
    // HTTPS sources stay as they were on the wire.
    val http = PlayerMessages.entryJson(entry.copy(source = Source("https://media.test/a")))
    assertFalse(http.getJSONObject("source").has("kind"))
  }

  @Test
  fun `a file that is gone or may not be read is not retried`() {
    val gone = FileDataSource.FileDataSourceException(null, IOException("ENOENT"), PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND)
    assertTrue(Failures.fileUnavailable(gone))
    assertTrue(Failures.fileUnavailable(IOException("wrapped", DataSourceException(PlaybackException.ERROR_CODE_IO_NO_PERMISSION))))
    assertFalse(Failures.fileUnavailable(DataSourceException(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)))
    assertFalse(Failures.fileUnavailable(IOException("other")))
    // The web app hears a network failure without a status, and plays the song another way.
    assertEquals(
      Failure(FailureType.NETWORK, null, "m"),
      Failures.classify(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, null, false, "m"),
    )
  }
}
