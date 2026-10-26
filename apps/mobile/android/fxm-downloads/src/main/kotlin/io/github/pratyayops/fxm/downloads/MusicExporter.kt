package io.github.pratyayops.fxm.downloads

import java.io.File
import java.io.IOException
import java.io.OutputStream

/** What a song is called, for the exported file's name and MediaStore's columns. */
data class SongInfo(val title: String, val artists: List<String>, val album: String?)

/** A file in Music/FXM: its MediaStore URI and its path there, e.g. `Music/FXM/A - B.mka`. */
data class Exported(val uri: String, val path: String)

/**
 * The device's Music/FXM folder, as [MusicExporter] uses it: MediaStore on Android 10 and later
 * ([MediaStoreMusicFolder]), the shared Music folder plus the media scanner before
 * ([LegacyMusicFolder]). Every method may block; the plugin calls them on its worker thread.
 */
interface MusicFolder {
  /** A file of this app's named [displayName] and [size] bytes long, exported before. */
  fun find(displayName: String, size: Long): Exported?

  /** Creates a new item, hidden until [publish]. Its name may change to stay unique. */
  fun create(displayName: String, format: ExportFormat, song: SongInfo): Pending

  /** Writes the item's bytes. */
  fun write(item: Pending, copy: (OutputStream) -> Unit)

  /** Makes the item visible to every app, and returns where it is. */
  fun publish(item: Pending): Exported

  /** Deletes an item that failed. Never throws. */
  fun discard(item: Pending)

  /** An item [create] made, before [publish]. */
  interface Pending
}

/**
 * Saves a copy of a finished download to Music/FXM, where every music app finds it
 * (stage 6.4). The download stays in the app's storage and keeps playing offline. A song saved
 * before, with the same name and size, is not saved twice; a copy that fails halfway is deleted,
 * so no broken file is left behind.
 */
class MusicExporter(private val folder: MusicFolder) {
  /** Copies [source], a download in [format], named after [song]. */
  fun export(source: File, format: ExportFormat, song: SongInfo): Exported {
    val name = ExportFormats.displayName(song.title, song.artists, format.extension)
    val size = source.length()
    folder.find(name, size)?.let { return it }
    val item = folder.create(name, format, song)
    try {
      folder.write(item) { output -> source.inputStream().use { input -> input.copyTo(output, BUFFER_BYTES) } }
      return folder.publish(item)
    } catch (e: IOException) {
      folder.discard(item)
      throw DownloadFiles.failure("Couldn't save the song to Music", e)
    } catch (e: RuntimeException) {
      folder.discard(item)
      throw DownloadFileException(DownloadFiles.IO, "Couldn't save the song to Music", e)
    }
  }

  companion object {
    /** Where exports go, relative to the shared storage: `Environment.DIRECTORY_MUSIC`/FXM. */
    const val RELATIVE_PATH = "Music/FXM"

    private const val BUFFER_BYTES = 256 * 1024
  }
}
