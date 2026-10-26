package io.github.pratyayops.fxm.downloads

import android.content.ContentResolver
import android.content.ContentUris
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Size
import java.io.ByteArrayOutputStream
import java.io.IOException
import org.json.JSONObject

/**
 * An album whose cover the web app asks for: the MediaStore volume and album id of one of its
 * songs, and that song's own id, whose embedded picture serves when the album has no thumbnail.
 */
data class AlbumRef(val volume: String, val id: Long, val track: Long?)

/** A cover thumbnail: JPEG bytes and the image's size. */
class Thumbnail(val jpeg: ByteArray, val width: Int, val height: Int)

/**
 * The device's music, read from MediaStore's audio collection (stage 6.4): songs only
 * (`IS_MUSIC`, so no ringtones, notifications, alarms or recordings), on every external volume,
 * in pages by `_ID`, and the covers of their albums. Needs `READ_MEDIA_AUDIO` (Android 13+) or
 * `READ_EXTERNAL_STORAGE`, which the FxmDeviceMusic plugin asks for when the user opens device
 * music. It reads MediaStore's columns, never the files themselves.
 */
class DeviceMusicQuery(private val resolver: ContentResolver) {
  /** One page of songs: their items, and the `_ID` to continue after, `null` at the end. */
  class Page(val items: List<JSONObject>, val next: Long?)

  private val collection: Uri =
    if (Build.VERSION.SDK_INT >= 29) {
      MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
    } else {
      MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
    }

  private val selection: String =
    buildString {
      append("${MediaStore.Audio.AudioColumns.IS_MUSIC} != 0")
      // Android 11 and later leave pending and trashed items out by themselves.
      if (Build.VERSION.SDK_INT == 29) append(" AND ${MediaStore.MediaColumns.IS_PENDING} = 0")
    }

  /** How many songs there are. */
  fun count(): Int =
    resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID), selection, null, null)?.use(Cursor::getCount) ?: 0

  /** Up to [limit] songs whose `_ID` is greater than [after], by `_ID`. */
  fun page(after: Long, limit: Int): Page {
    val items = mutableListOf<JSONObject>()
    var last = after
    var more = false
    @Suppress("DEPRECATION")
    val primaryRoot = if (Build.VERSION.SDK_INT < 29) Environment.getExternalStorageDirectory().absolutePath else null
    resolver
      .query(collection, COLUMNS, "$selection AND ${MediaStore.MediaColumns._ID} > ?", arrayOf(after.toString()), "${MediaStore.MediaColumns._ID} ASC")
      ?.use { cursor ->
        val columns = Columns(cursor)
        var read = 0
        while (cursor.moveToNext()) {
          if (read == limit) {
            more = true
            break
          }
          val row = columns.row(cursor)
          last = row.id
          read += 1
          DeviceAudio.toJson(row, primaryRoot)?.let(items::add)
        }
      }
    return Page(items, if (more) last else null)
  }

  /**
   * The cover of [album], at most [sizePx] on its longer side, or `null` when it has none:
   * MediaStore's own thumbnail of the album or else of its song (Android 10+), the album art
   * before.
   */
  fun thumbnail(album: AlbumRef, sizePx: Int): Thumbnail? {
    val bitmap =
      if (Build.VERSION.SDK_INT >= 29) {
        val size = Size(sizePx, sizePx)
        val albumUri = ContentUris.withAppendedId(MediaStore.Audio.Albums.getContentUri(album.volume), album.id)
        quietly { resolver.loadThumbnail(albumUri, size, null) }
          ?: album.track?.let { track ->
            val trackUri = ContentUris.withAppendedId(MediaStore.Audio.Media.getContentUri(album.volume), track)
            quietly { resolver.loadThumbnail(trackUri, size, null) }
          }
      } else {
        quietly { legacyAlbumArt(album.id, sizePx) }
      } ?: return null
    val scaled = scale(bitmap, sizePx)
    val bytes = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, bytes)
    return Thumbnail(bytes.toByteArray(), scaled.width, scaled.height)
  }

  /** [read]'s picture, or `null` when there is none: no cover, a volume gone, a damaged image. */
  private fun quietly(read: () -> Bitmap?): Bitmap? =
    try {
      read()
    } catch (e: IOException) {
      null
    } catch (e: RuntimeException) {
      null
    }

  private fun legacyAlbumArt(albumId: Long, sizePx: Int): Bitmap? {
    val uri = ContentUris.withAppendedId(LEGACY_ALBUM_ART, albumId)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= sizePx && bounds.outHeight / (sample * 2) >= sizePx) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
  }

  private fun scale(bitmap: Bitmap, sizePx: Int): Bitmap {
    val longer = maxOf(bitmap.width, bitmap.height)
    if (longer <= sizePx) return bitmap
    val ratio = sizePx.toDouble() / longer
    return Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * ratio).toInt()), maxOf(1, (bitmap.height * ratio).toInt()), true)
  }

  /** Reads the [COLUMNS] of a cursor's rows into [AudioRow]s. */
  private class Columns(cursor: Cursor) {
    private val indexes = COLUMNS.associateWith { cursor.getColumnIndex(it) }

    fun row(cursor: Cursor): AudioRow {
      fun text(name: String) = indexes[name]?.takeIf { it >= 0 && !cursor.isNull(it) }?.let(cursor::getString)

      fun number(name: String) = indexes[name]?.takeIf { it >= 0 && !cursor.isNull(it) }?.let(cursor::getLong)
      val volume = text(MediaStore.MediaColumns.VOLUME_NAME)
      return AudioRow(
        id = number(MediaStore.MediaColumns._ID) ?: 0,
        uriVolume = volume ?: "external",
        volume = volume,
        relativePath = text(MediaStore.MediaColumns.RELATIVE_PATH),
        displayName = text(MediaStore.MediaColumns.DISPLAY_NAME),
        data = if (Build.VERSION.SDK_INT < 29) text(DATA) else null,
        title = text(MediaStore.MediaColumns.TITLE),
        artist = text(MediaStore.Audio.AudioColumns.ARTIST),
        album = text(MediaStore.Audio.AudioColumns.ALBUM),
        albumArtist = text(ALBUM_ARTIST),
        albumId = number(MediaStore.Audio.AudioColumns.ALBUM_ID),
        track = number(MediaStore.Audio.AudioColumns.TRACK)?.toInt(),
        cdTrackNumber = text(CD_TRACK_NUMBER),
        discNumber = text(DISC_NUMBER),
        year = number(MediaStore.Audio.AudioColumns.YEAR)?.toInt(),
        durationMs = number(MediaStore.Audio.AudioColumns.DURATION),
        mimeType = text(MediaStore.MediaColumns.MIME_TYPE),
        size = number(MediaStore.MediaColumns.SIZE),
        dateModified = number(MediaStore.MediaColumns.DATE_MODIFIED),
        bitrate = number(BITRATE),
        compilation = text(COMPILATION),
        sampleRate = number(SAMPLERATE)?.toInt(),
        bitsPerSample = number(BITS_PER_SAMPLE)?.toInt(),
      )
    }
  }

  private companion object {
    const val JPEG_QUALITY = 85

    // Columns by their names, so the code compiles against every API level; each is asked for
    // only where Android has it (a column MediaStore doesn't know fails the whole query).
    const val DATA = "_data"
    const val ALBUM_ARTIST = "album_artist"
    const val CD_TRACK_NUMBER = "cd_track_number"
    const val DISC_NUMBER = "disc_number"
    const val BITRATE = "bitrate"
    const val COMPILATION = "compilation"
    const val SAMPLERATE = "samplerate"
    const val BITS_PER_SAMPLE = "bits_per_sample"

    /** Android 9 and older keep album art here, by album id. */
    val LEGACY_ALBUM_ART: Uri = Uri.parse("content://media/external/audio/albumart")

    val COLUMNS: Array<String> =
      buildList {
        add(MediaStore.MediaColumns._ID)
        add(MediaStore.MediaColumns.DISPLAY_NAME)
        add(MediaStore.MediaColumns.TITLE)
        add(MediaStore.Audio.AudioColumns.ARTIST)
        add(MediaStore.Audio.AudioColumns.ALBUM)
        add(MediaStore.Audio.AudioColumns.ALBUM_ID)
        add(MediaStore.Audio.AudioColumns.TRACK)
        add(MediaStore.Audio.AudioColumns.YEAR)
        add(MediaStore.Audio.AudioColumns.DURATION)
        add(MediaStore.MediaColumns.MIME_TYPE)
        add(MediaStore.MediaColumns.SIZE)
        add(MediaStore.MediaColumns.DATE_MODIFIED)
        if (Build.VERSION.SDK_INT >= 29) {
          add(MediaStore.MediaColumns.VOLUME_NAME)
          add(MediaStore.MediaColumns.RELATIVE_PATH)
        } else {
          add(DATA)
        }
        if (Build.VERSION.SDK_INT >= 30) {
          add(ALBUM_ARTIST)
          add(CD_TRACK_NUMBER)
          add(DISC_NUMBER)
          add(BITRATE)
          add(COMPILATION)
        }
        if (Build.VERSION.SDK_INT >= 36) {
          add(SAMPLERATE)
          add(BITS_PER_SAMPLE)
        }
      }.toTypedArray()
  }
}
