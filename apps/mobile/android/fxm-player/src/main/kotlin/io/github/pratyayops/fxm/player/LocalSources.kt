package io.github.pratyayops.fxm.player

import java.io.File
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException

/**
 * The files on the device the player may play ([SourceKind.FILE], stage 6.4): the offline copies
 * in the app's downloads folder (fxm-downloads' `DownloadFiles`) as `file:` URIs, and the
 * device's own music through MediaStore as `content://media/<volume>/audio/media/<id>` URIs.
 * Nothing else: a file elsewhere (the app's other data, through `..` or a symbolic link) or
 * another app's content provider is refused before Media3 opens anything, so the web app can
 * never make the player read a file it was not meant to.
 */
class LocalSources(roots: List<File>) {
  private val roots: List<File> = roots.map { root -> runCatching { root.canonicalFile }.getOrDefault(root.absoluteFile) }

  /**
   * The URI Media3 opens for a file source's [url]: for a `file:` URI, the `file:` URI of the
   * file's canonical path, which must be inside one of the roots; a MediaStore audio URI as it
   * is. Throws a [PlayerMessageException] for anything else.
   */
  fun check(url: String): String {
    val uri =
      try {
        URI(url)
      } catch (e: URISyntaxException) {
        throw PlayerMessageException("Invalid file URI")
      }
    if (uri.rawQuery != null || uri.rawFragment != null) {
      throw PlayerMessageException("A file URI has no query or fragment")
    }
    return when (uri.scheme?.lowercase()) {
      "file" -> checkFile(uri)
      "content" -> checkMedia(uri)
      else -> throw PlayerMessageException("A file source needs a file: or content: URI")
    }
  }

  private fun checkFile(uri: URI): String {
    if (!uri.rawAuthority.isNullOrEmpty()) throw PlayerMessageException("A file URI names no host")
    val path = uri.path
    if (path == null || !path.startsWith("/")) throw PlayerMessageException("A file URI needs an absolute path")
    val file =
      try {
        File(path).canonicalFile
      } catch (e: IOException) {
        throw PlayerMessageException("Unreadable file path")
      }
    // Inside a root, never the root itself: canonical paths have resolved `..` and links.
    if (roots.none { root -> file.path.startsWith(root.path + File.separator) }) {
      throw PlayerMessageException("The player plays only FXM's downloads and the device's music")
    }
    return fileUri(file)
  }

  private fun checkMedia(uri: URI): String {
    if (uri.rawAuthority != MEDIA_AUTHORITY || !MEDIA_AUDIO.matches(uri.rawPath ?: "")) {
      throw PlayerMessageException("A content URI must name a MediaStore audio item")
    }
    return "content://$MEDIA_AUTHORITY${uri.rawPath}"
  }

  companion object {
    /** No files at all. */
    val NONE = LocalSources(emptyList())

    /** MediaStore's content provider (`MediaStore.AUTHORITY`). */
    const val MEDIA_AUTHORITY = "media"

    /**
     * A MediaStore audio item: `/<volume>/audio/media/<id>`. Volume names are `external`,
     * `external_primary`, `internal` or a removable volume's id such as `1234-abcd`.
     */
    private val MEDIA_AUDIO = Regex("/[A-Za-z0-9_-]{1,64}/audio/media/[0-9]{1,18}")

    /** The `file:` URI of [file]'s absolute path (`file:///…`), percent-encoded as a URI needs. */
    fun fileUri(file: File): String = URI("file", "", file.absolutePath, null, null).toASCIIString()
  }
}
