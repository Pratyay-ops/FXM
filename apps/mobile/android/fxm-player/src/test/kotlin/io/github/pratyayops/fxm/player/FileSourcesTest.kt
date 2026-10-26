package io.github.pratyayops.fxm.player

import androidx.media3.common.PlaybackException
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.FileDataSource
import io.github.pratyayops.fxm.downloads.DeviceFiles
import java.io.File
import java.io.IOException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Files on the device as the player's entries carry them (stage 6.4). Which files those may be is
 * fxm-downloads' `DeviceFiles`, tested there (`DeviceFilesTest`).
 */
class FileSourcesTest {
  @get:Rule val temp = TemporaryFolder()

  /** The app's files, its downloads folder with one download, and a file it must not play. */
  private fun app(): Triple<DeviceFiles, File, File> {
    val files = temp.newFolder("files")
    val downloads = File(files, "downloads").apply { mkdirs() }
    val song = File(downloads, "0b9f-song").apply { writeText("audio") }
    val secret = File(files, "secret.txt").apply { writeText("token") }
    return Triple(DeviceFiles(listOf(downloads)), song, secret)
  }

  private fun refused(json: JSONObject, local: DeviceFiles) {
    try {
      PlayerMessages.source(json, local)
      fail("expected a PlayerMessageException")
    } catch (expected: PlayerMessageException) {
      // The plugin rejects the call with BAD_REQUEST.
    }
  }

  @Test
  fun `file sources come from the web app as their own kind`() {
    val (local, song, secret) = app()
    val json = JSONObject().put("kind", "file").put("url", "file://${song.absolutePath}")
    val source = PlayerMessages.source(json, local)
    assertEquals(Source("file://${song.canonicalPath}", kind = SourceKind.FILE), source)
    // Without the folder the message is refused, as are a file elsewhere and a missing URI.
    refused(json, DeviceFiles.NONE)
    refused(JSONObject().put("kind", "file").put("url", "file://${secret.absolutePath}"), local)
    refused(JSONObject().put("kind", "file").put("url", "content://media/external/images/media/1"), local)
    refused(JSONObject().put("kind", "file"), local)
    // The device's music plays from its MediaStore URI.
    assertEquals(
      Source("content://media/external/audio/media/7", kind = SourceKind.FILE),
      PlayerMessages.source(JSONObject().put("kind", "file").put("url", "content://media/external/audio/media/7"), local),
    )
  }

  @Test
  fun `a file source keeps its URI and loudness only and comes back as a file`() {
    val (local, song) = app()
    val source =
      PlayerMessages.source(
        JSONObject()
          .put("kind", "file")
          .put("url", "file://${song.absolutePath}")
          .put("headers", JSONObject().put("Referer", "https://www.youtube.com/"))
          .put("expiresAt", 5)
          .put("ipBound", true)
          .put("fileKey", "k")
          .put("loudness", JSONObject().put("trackLufs", -9.5).put("albumLufs", -10)),
        local,
      )
    // An offline copy plays at the level its stream had, as loudness normalization wants (stage 8.1).
    val loud = Loudness(-9.5, -10.0)
    assertEquals(Source("file://${song.canonicalPath}", loudness = loud, kind = SourceKind.FILE), source)
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
