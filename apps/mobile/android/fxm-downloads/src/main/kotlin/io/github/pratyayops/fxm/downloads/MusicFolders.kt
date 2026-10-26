package io.github.pratyayops.fxm.downloads

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Music/FXM through MediaStore (Android 10 and later): the app adds its own files to the shared
 * Music folder without any permission. A new item stays pending (hidden from other apps) while
 * its bytes are written, and MediaStore adds ` (1)` to a name that is taken.
 */
@RequiresApi(29)
class MediaStoreMusicFolder(private val resolver: ContentResolver) : MusicFolder {
  private val collection: Uri = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

  private class Item(val uri: Uri) : MusicFolder.Pending

  override fun find(displayName: String, size: Long): Exported? {
    val selection =
      "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.DISPLAY_NAME} = ? " +
        "AND ${MediaStore.MediaColumns.SIZE} = ?"
    val args = arrayOf("${MusicExporter.RELATIVE_PATH}/", displayName, size.toString())
    resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID), selection, args, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val uri = ContentUris.withAppendedId(collection, cursor.getLong(0))
        return Exported(uri.toString(), "${MusicExporter.RELATIVE_PATH}/$displayName")
      }
    }
    return null
  }

  override fun create(displayName: String, format: ExportFormat, song: SongInfo): MusicFolder.Pending {
    // Only the columns an app may set: MediaStore reads title, artist and album from the file.
    val values =
      ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, format.mimeType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, MusicExporter.RELATIVE_PATH)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
    val uri = resolver.insert(collection, values) ?: throw IOException("MediaStore made no item")
    return Item(uri)
  }

  override fun write(item: MusicFolder.Pending, copy: (OutputStream) -> Unit) {
    val uri = (item as Item).uri
    val output = resolver.openOutputStream(uri, "w") ?: throw IOException("MediaStore gave no file to write")
    output.use(copy)
  }

  override fun publish(item: MusicFolder.Pending): Exported {
    val uri = (item as Item).uri
    resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    val name =
      resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      } ?: throw IOException("The saved song is gone")
    return Exported(uri.toString(), "${MusicExporter.RELATIVE_PATH}/$name")
  }

  override fun discard(item: MusicFolder.Pending) {
    runCatching { resolver.delete((item as Item).uri, null, null) }
  }
}

/**
 * Music/FXM on Android 9 and older: the shared storage's Music folder, written as files (with
 * `WRITE_EXTERNAL_STORAGE`, which the plugin asks for), then handed to the media scanner, which
 * adds them to MediaStore. FXM numbers a name that is taken itself.
 */
class LegacyMusicFolder(private val context: Context) : MusicFolder {
  @Suppress("DEPRECATION")
  private val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "FXM")

  private class Item(val file: File, val mimeType: String) : MusicFolder.Pending

  override fun find(displayName: String, size: Long): Exported? {
    val file = File(directory, displayName)
    if (!file.isFile || file.length() != size) return null
    return Exported(scan(file, null) ?: Uri.fromFile(file).toString(), "${MusicExporter.RELATIVE_PATH}/$displayName")
  }

  override fun create(displayName: String, format: ExportFormat, song: SongInfo): MusicFolder.Pending {
    if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) {
      throw IOException("Music/FXM can't be created")
    }
    val name = ExportFormats.unique(displayName) { File(directory, it).exists() }
    return Item(File(directory, name), format.mimeType)
  }

  override fun write(item: MusicFolder.Pending, copy: (OutputStream) -> Unit) {
    val file = (item as Item).file
    FileOutputStream(file).use { output ->
      copy(output)
      output.fd.sync()
    }
  }

  override fun publish(item: MusicFolder.Pending): Exported {
    val (file, mimeType) = (item as Item).let { it.file to it.mimeType }
    return Exported(scan(file, mimeType) ?: Uri.fromFile(file).toString(), "${MusicExporter.RELATIVE_PATH}/${file.name}")
  }

  override fun discard(item: MusicFolder.Pending) {
    runCatching { (item as Item).file.delete() }
  }

  /** Hands [file] to the media scanner and waits a little for its MediaStore URI. */
  private fun scan(file: File, mimeType: String?): String? {
    val done = CountDownLatch(1)
    var found: Uri? = null
    MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), mimeType?.let { arrayOf(it) }) { _, uri ->
      found = uri
      done.countDown()
    }
    done.await(SCAN_WAIT_SECONDS, TimeUnit.SECONDS)
    return found?.toString()
  }

  private companion object {
    const val SCAN_WAIT_SECONDS = 10L
  }
}
