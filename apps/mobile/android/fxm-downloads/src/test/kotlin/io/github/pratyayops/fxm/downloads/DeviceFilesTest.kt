package io.github.pratyayops.fxm.downloads

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DeviceFilesTest {
  @get:Rule val temp = TemporaryFolder()

  /** The app's files, its downloads folder with one download, and a file it must not show. */
  private class App(val files: DeviceFiles, val downloads: File, val song: File, val secret: File)

  private fun app(): App {
    val data = temp.newFolder("files")
    val downloads = File(data, "downloads").apply { mkdirs() }
    val song = File(downloads, "0b9f-song").apply { writeText("audio") }
    val secret = File(data, "secret.txt").apply { writeText("token") }
    return App(DeviceFiles(listOf(downloads)), downloads, song, secret)
  }

  private fun refused(files: DeviceFiles, url: String) {
    try {
      files.check(url)
    } catch (e: DeviceFileRefusedException) {
      assertFalse(files.allows(url))
      return
    }
    fail("expected $url to be refused")
  }

  @Test
  fun `a download in the downloads folder is read from its canonical file URI`() {
    val app = app()
    val uri = app.files.check("file://${app.song.absolutePath}")
    assertEquals("file://${app.song.canonicalPath}", uri)
    // The single-slash form names the same file.
    assertEquals(uri, app.files.check("file:${app.song.absolutePath}"))
    assertEquals(uri, DeviceFiles.fileUri(app.song.canonicalFile))
    assertTrue(app.files.allows(uri))
    assertEquals(app.song.canonicalFile, app.files.inside(app.song.absolutePath))
  }

  @Test
  fun `files outside the downloads folder are refused, however they are named`() {
    val app = app()
    val downloads = app.downloads
    refused(app.files, "file://${app.secret.absolutePath}")
    refused(app.files, "file://${downloads.absolutePath}/../secret.txt")
    refused(app.files, "file://${downloads.absolutePath}/%2E%2E/secret.txt")
    // The folder itself, and a folder whose name only starts like it.
    refused(app.files, "file://${downloads.absolutePath}")
    val lookalike = File(downloads.parentFile, "downloads-old").apply { mkdirs() }
    refused(app.files, "file://${File(lookalike, "a").absolutePath}")
    // A link inside the folder that points out of it.
    val link = File(downloads, "link")
    Files.createSymbolicLink(link.toPath(), app.secret.toPath())
    refused(app.files, "file://${link.absolutePath}")
    assertNull(app.files.inside(link.absolutePath))
    // A relative path is nobody's file.
    assertNull(app.files.inside("downloads/0b9f-song"))
  }

  @Test
  fun `file URIs need an absolute path and nothing else`() {
    val app = app()
    val path = app.song.absolutePath
    refused(app.files, "file://host$path")
    refused(app.files, "file://$path?x=1")
    refused(app.files, "file://$path#x")
    refused(app.files, "file:relative/path")
    refused(app.files, "not a uri")
    refused(app.files, "https://media.test/a.webm")
    refused(app.files, "fxm-entry://slot/1")
  }

  @Test
  fun `the device's music is read from MediaStore audio URIs only`() {
    val app = app()
    for (uri in listOf(
      "content://media/external/audio/media/42",
      "content://media/external_primary/audio/media/42",
      "content://media/1234-abcd/audio/media/7",
    )) {
      assertEquals(uri, app.files.check(uri))
    }
    refused(app.files, "content://media/external/images/media/42")
    refused(app.files, "content://media/external/video/media/42")
    refused(app.files, "content://media/external/audio/albums/42")
    refused(app.files, "content://media/external/audio/media/42/thumbnail")
    refused(app.files, "content://media/external/audio/media/x")
    refused(app.files, "content://media/../audio/media/42")
    refused(app.files, "content://media/external/audio/media/42?mode=w")
    refused(app.files, "content://user@media/external/audio/media/42")
    refused(app.files, "content://io.github.pratyayops.fxm.fileprovider/downloads/a")
    refused(app.files, "content://com.android.contacts/contacts/1")
  }

  @Test
  fun `without a downloads folder nothing on the device but its music is read`() {
    val app = app()
    refused(DeviceFiles.NONE, "file://${app.song.absolutePath}")
    assertEquals("content://media/external/audio/media/1", DeviceFiles.NONE.check("content://media/external/audio/media/1"))
  }

  /** A request of the WebView for `https://localhost` + [path], whose decoded path is [decoded]. */
  private fun page(path: String, decoded: String = path.substringBefore('?')) =
    WebViewRequest("https://localhost$path", "https", "localhost", -1, decoded)

  @Test
  fun `the WebView serves its downloads and the songs MediaStore lists`() {
    val app = app()
    assertTrue(app.files.webViewAllows(page("/_capacitor_file_${app.song.absolutePath}")))
    assertTrue(app.files.webViewAllows(page("/_capacitor_content_/media/external_primary/audio/media/11")))
    assertTrue(app.files.webViewAllows(page("/_capacitor_content_/media/1234-abcd/audio/media/7")))
    // Everything that isn't a device file is Capacitor's business, as before.
    assertTrue(app.files.webViewAllows(page("/")))
    assertTrue(app.files.webViewAllows(page("/assets/index-abc.js")))
    assertTrue(app.files.webViewAllows(WebViewRequest("https://i.ytimg.com/vi/a/hq.jpg", "https", "i.ytimg.com", -1, "/vi/a/hq.jpg")))
    assertTrue(app.files.webViewAllows(WebViewRequest("about:blank", "about", null, -1, null)))
    // The port, when the URL names one, is part of what Capacitor replaces.
    assertTrue(
      app.files.webViewAllows(
        WebViewRequest(
          "https://localhost:8443/_capacitor_content_/media/external/audio/media/1",
          "https",
          "localhost",
          8443,
          "/_capacitor_content_/media/external/audio/media/1",
        ),
      ),
    )
  }

  @Test
  fun `the WebView serves no other content, whatever the URL looks like`() {
    val app = app()
    for (path in listOf(
      // The user's photos and videos, and the rest of MediaStore.
      "/_capacitor_content_/media/external/images/media/42",
      "/_capacitor_content_/media/external/video/media/42",
      "/_capacitor_content_/media/external/file/42",
      "/_capacitor_content_/media/external/audio/albumart/7",
      "/_capacitor_content_/media/external/audio/media/42/albumart",
      // Other apps' providers, and the app's own.
      "/_capacitor_content_/com.android.contacts/contacts/1",
      "/_capacitor_content_/io.github.pratyayops.fxm.fileprovider/downloads/a",
      // A query MediaStore would read as an option, and a name that only starts like the prefix.
      "/_capacitor_content_/media/external/audio/media/42?mode=w",
      "/_capacitor_content_x/media/external/audio/media/42",
    )) {
      assertFalse(path, app.files.webViewAllows(page(path)))
    }
    // With a user name the URL doesn't start with what Capacitor replaces: it opens nothing.
    assertFalse(
      app.files.webViewAllows(
        WebViewRequest(
          "https://x@localhost/_capacitor_content_/media/external/audio/media/1",
          "https",
          "localhost",
          -1,
          "/_capacitor_content_/media/external/audio/media/1",
        ),
      ),
    )
  }

  @Test
  fun `the WebView serves no other file, whatever the path looks like`() {
    val app = app()
    val downloads = app.downloads.absolutePath
    val link = File(app.downloads, "link")
    Files.createSymbolicLink(link.toPath(), app.secret.toPath())
    for (decoded in listOf(
      // The app's other data: its WebView storage, preferences, databases.
      "/_capacitor_file_${app.secret.absolutePath}",
      // `..` that reaches Capacitor's path decoded (`..%2F` in the URL).
      "/_capacitor_file_$downloads/../secret.txt",
      "/_capacitor_file_$downloads/./../secret.txt",
      // A link out of the folder, the folder itself, and the shared storage.
      "/_capacitor_file_${link.absolutePath}",
      "/_capacitor_file_$downloads",
      "/_capacitor_file_/sdcard/DCIM/Camera/photo.jpg",
      "/_capacitor_file_/proc/self/environ",
      // A relative path, which Capacitor would open from the process's working folder.
      "/_capacitor_file_${downloads.removePrefix("/")}/0b9f-song",
    )) {
      assertFalse(decoded, app.files.webViewAllows(page(decoded)))
    }
    // Capacitor takes out every `/_capacitor_file_`: what is left is all that counts.
    assertTrue(app.files.webViewAllows(page("/_capacitor_file_/_capacitor_file_${app.song.absolutePath}")))
    assertFalse(app.files.webViewAllows(page("/_capacitor_file_$downloads/_capacitor_file_x")))
  }
}
