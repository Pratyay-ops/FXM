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
import java.util.concurrent.atomic.AtomicReference

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
    // The items of that size in Music/FXM, then the name: the song's own or a numbered copy.
    val selection = "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.SIZE} = ?"
    val args = arrayOf("${MusicExporter.RELATIVE_PATH}/", size.toString())
    val projection = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME)
    val ids = linkedMapOf<String, Long>()
    resolver.query(collection, projection, selection, args, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val name = cursor.getString(1) ?: continue
        ids.putIfAbsent(name, cursor.getLong(0))
      }
    }
    val name = ExportFormats.savedBefore(displayName, ids.keys) ?: return null
    val id = ids[name] ?: return null
    return Exported(ContentUris.withAppendedId(collection, id).toString(), "${MusicExporter.RELATIVE_PATH}/$name")
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
class LegacyMusicFolder(
  /** Music/FXM on the shared storage. */
  private val directory: File,
  /**
   * Hands a file, and its MIME type when known, to the media scanner, and returns its MediaStore
   * URI once scanned; `null` when the scanner takes too long.
   */
  private val scan: (File, String?) -> String?,
) : MusicFolder {
  /** The device's Music/FXM, scanned by Android's media scanner. */
  constructor(context: Context) : this(sharedMusicFolder(), mediaScanner(context.applicationContext))

  private class Item(val file: File, val mimeType: String) : MusicFolder.Pending

  override fun find(displayName: String, size: Long): Exported? {
    val sameSize = directory.listFiles()?.filter { it.isFile && it.length() == size }?.map { it.name } ?: return null
    val name = ExportFormats.savedBefore(displayName, sameSize) ?: return null
    val file = File(directory, name)
    return Exported(scan(file, null) ?: DeviceFiles.fileUri(file), "${MusicExporter.RELATIVE_PATH}/$name")
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
    return Exported(scan(file, mimeType) ?: DeviceFiles.fileUri(file), "${MusicExporter.RELATIVE_PATH}/${file.name}")
  }

  override fun discard(item: MusicFolder.Pending) {
    runCatching { (item as Item).file.delete() }
  }

  private companion object {
    const val SCAN_WAIT_SECONDS = 10L

    @Suppress("DEPRECATION")
    fun sharedMusicFolder(): File = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "FXM")

    /** Android's media scanner, waited for a little. */
    fun mediaScanner(context: Context): (File, String?) -> String? =
      { file, mimeType ->
        val done = CountDownLatch(1)
        val found = AtomicReference<Uri?>()
        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), mimeType?.let { arrayOf(it) }) { _, uri ->
          found.set(uri)
          done.countDown()
        }
        try {
          done.await(SCAN_WAIT_SECONDS, TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
          // Not waited for: the file is saved all the same, and its URI isn't known yet.
          Thread.currentThread().interrupt()
        }
        found.get()?.toString()
      }
  }
}
