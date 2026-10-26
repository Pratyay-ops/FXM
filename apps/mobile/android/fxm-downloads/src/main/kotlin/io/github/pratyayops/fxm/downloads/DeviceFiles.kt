package io.github.pratyayops.fxm.downloads

import android.content.Context
import java.io.File
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException

/** A URI [DeviceFiles] refused: no file FXM's page or player may read. */
class DeviceFileRefusedException(message: String) : IllegalArgumentException(message)

/**
 * A request of the app's WebView, in the parts Capacitor's local server reads from its
 * `android.net.Uri`: [url] is its `toString()`, [path] its `getPath()` (percent-decoded), and
 * [scheme], [host] and [port] (`-1` when the URL names none) its other parts.
 */
data class WebViewRequest(
  val url: String,
  val scheme: String?,
  val host: String?,
  val port: Int,
  val path: String?,
)

/**
 * The files on the device that FXM's page and its native player may read (stage 6.4): the
 * offline copies in the app's downloads folder ([DownloadFiles]) and the device's own music
 * through MediaStore, as `content://media/<volume>/audio/media/<id>`. Nothing else: a file
 * elsewhere (the app's other data, reached through `..` or a symbolic link), another kind of
 * MediaStore item (a photo, a video) or another app's content provider is refused before anything
 * opens it.
 *
 * One list for both readers:
 *
 * - **The native player** (fxm-player) checks every file source with [check] before Media3 opens
 *   it, so the web app can never make it read a file it was not meant to.
 * - **The app's WebView** ([webViewAllows], which [DeviceFileFilter] applies). Capacitor's local
 *   server serves any file the app can read at `/_capacitor_file_<path>` and any content URI at
 *   `/_capacitor_content_/<authority>/<path>` to the page's own scripts. Once FXM may read the
 *   device's music, that would be every photo and video MediaStore lists on Android 12 and older,
 *   any file on the shared storage on Android 9 and older, and every audio item, voice notes and
 *   call recordings included, on every version. The page needs its downloads and the songs it
 *   lists, and gets nothing else.
 */
class DeviceFiles(roots: List<File>) {
  private val roots: List<File> = roots.map { root -> runCatching { root.canonicalFile }.getOrDefault(root.absoluteFile) }

  /**
   * The URI to open for a file source's [url]: for a `file:` URI, the `file:` URI of the file's
   * canonical path, which must be inside one of the roots; a MediaStore audio URI as it is.
   * Throws a [DeviceFileRefusedException] for anything else.
   */
  fun check(url: String): String {
    val uri =
      try {
        URI(url)
      } catch (e: URISyntaxException) {
        throw DeviceFileRefusedException("Invalid file URI")
      }
    if (uri.rawQuery != null || uri.rawFragment != null) {
      throw DeviceFileRefusedException("A file URI has no query or fragment")
    }
    return when (uri.scheme?.lowercase()) {
      "file" -> checkFile(uri)
      "content" -> checkMedia(uri)
      else -> throw DeviceFileRefusedException("A file source needs a file: or content: URI")
    }
  }

  /** Whether FXM may read the file [url] names ([check] accepts it). */
  fun allows(url: String): Boolean =
    try {
      check(url)
      true
    } catch (e: DeviceFileRefusedException) {
      false
    }

  /**
   * The canonical file of [path], an absolute path, when it is inside one of the roots (never a
   * root itself); `null` for anything else. A canonical path has `.`, `..` and symbolic links
   * resolved, so neither can make a file look inside a root when it isn't.
   */
  fun inside(path: String): File? {
    if (!path.startsWith("/")) return null
    val file =
      try {
        File(path).canonicalFile
      } catch (e: IOException) {
        return null
      }
    return file.takeIf { roots.any { root -> file.path.startsWith(root.path + File.separator) } }
  }

  /**
   * Whether the app's WebView may answer [request]: always for anything but a device file, and for
   * one only when the file Capacitor's local server would open is one FXM may read. The server
   * (`WebViewLocalServer` and `AndroidProtocolHandler`, Capacitor 8.5.3) tests the decoded path for
   * [WEBVIEW_CONTENT_PATH] first, then for [WEBVIEW_FILE_PATH]. For a content URL it opens the URL
   * with every `<scheme>://<host>[:<port>]/_capacitor_content_` in it replaced by `content:/`; for
   * a file URL, the decoded path with every `/_capacitor_file_` in it taken out. This repeats
   * exactly that, so no spelling of a URL reaches another file.
   */
  fun webViewAllows(request: WebViewRequest): Boolean {
    val path = request.path ?: return true
    return when {
      path.startsWith(WEBVIEW_CONTENT_PATH) -> {
        val port = if (request.port != -1) ":${request.port}" else ""
        val base = "${request.scheme}://${request.host}$port$WEBVIEW_CONTENT_PATH"
        val opened = request.url.replace(base, "content:/")
        // ContentResolver compares the scheme as it is: only the replacement's own `content:`.
        opened.startsWith("content://") && allows(opened)
      }
      path.startsWith(WEBVIEW_FILE_PATH) -> inside(path.replace(WEBVIEW_FILE_PATH, "")) != null
      else -> true
    }
  }

  private fun checkFile(uri: URI): String {
    if (!uri.rawAuthority.isNullOrEmpty()) throw DeviceFileRefusedException("A file URI names no host")
    val path = uri.path
    if (path == null || !path.startsWith("/")) throw DeviceFileRefusedException("A file URI needs an absolute path")
    val file = inside(path) ?: throw DeviceFileRefusedException("Only FXM's downloads and the device's music can be read")
    return fileUri(file)
  }

  private fun checkMedia(uri: URI): String {
    if (uri.rawAuthority != MEDIA_AUTHORITY || !MEDIA_AUDIO.matches(uri.rawPath ?: "")) {
      throw DeviceFileRefusedException("A content URI must name a MediaStore audio item")
    }
    return "content://$MEDIA_AUTHORITY${uri.rawPath}"
  }

  companion object {
    /** No files at all: the device's music only. */
    val NONE = DeviceFiles(emptyList())

    /** MediaStore's content provider (`MediaStore.AUTHORITY`). */
    const val MEDIA_AUTHORITY = "media"

    /** Where Capacitor's local server serves a file of the device (`Bridge.CAPACITOR_FILE_START`). */
    const val WEBVIEW_FILE_PATH = "/_capacitor_file_"

    /** Where it serves a content URI (`Bridge.CAPACITOR_CONTENT_START`). */
    const val WEBVIEW_CONTENT_PATH = "/_capacitor_content_"

    /**
     * A MediaStore audio item: `/<volume>/audio/media/<id>`. Volume names are `external`,
     * `external_primary`, `internal` or a removable volume's id such as `1234-abcd`.
     */
    private val MEDIA_AUDIO = Regex("/[A-Za-z0-9_-]{1,64}/audio/media/[0-9]{1,18}")

    /** The app's list: its downloads folder, and the device's music. */
    fun of(context: Context): DeviceFiles = DeviceFiles(listOf(DownloadFiles.directory(context)))

    /** The `file:` URI of [file]'s absolute path (`file:///…`), percent-encoded as a URI needs. */
    fun fileUri(file: File): String = URI("file", "", file.absolutePath, null, null).toASCIIString()
  }
}
