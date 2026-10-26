package io.github.pratyayops.fxm.downloads

import android.content.Context
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/** Why a [DownloadFiles] call failed: [code] is one of the plugin's error codes. */
class DownloadFileException(val code: String, message: String, cause: Throwable? = null) :
  IOException(message, cause)

/**
 * The files of the web app's downloads, in the app's own storage (`files/downloads`, which no
 * other app can read and which goes with the app). The web app's download manager
 * (`@fxm/downloads`) writes them through the FxmDownloads plugin, as it writes the Origin Private
 * File System in a browser: one writer per file, bytes written in order at their offset, so a
 * file always holds a prefix of the real one and a download continues from its size.
 *
 * - **Names** are the manager's opaque ones: 1 to 64 ASCII letters, digits, `-` and `_`, never a
 *   name Windows reserves for a device (`isSafeFileName` in `@fxm/downloads`). Any other name is
 *   refused before the file system is touched, so no name reaches outside the folder.
 * - **Room for the rest of the device.** A write that would leave less free space than Android's
 *   own low-storage threshold ([reserveBytes]: 5 % of the storage, at most 500 MiB) fails with
 *   [NO_SPACE], as does the disk itself when it is full, so downloads never push the phone into
 *   "storage space running out".
 *
 * Every method is synchronized; the plugin calls them on one worker thread.
 */
class DownloadFiles(
  /** The folder the files live in; created when the first one is opened. */
  val directory: File,
  private val space: Space = Space.of(directory),
) {
  /** How much room the storage has, in bytes. */
  interface Space {
    /** The bytes the app may still use. */
    fun usable(): Long

    /** The storage's size. */
    fun total(): Long

    companion object {
      /** The storage [directory] is on (the folder need not exist yet). */
      fun of(directory: File): Space =
        object : Space {
          override fun usable(): Long = existing(directory).usableSpace

          override fun total(): Long = existing(directory).totalSpace
        }

      /** [file] or its closest existing parent: free space is a property of the storage. */
      private fun existing(file: File): File {
        var current: File? = file
        while (current != null && !current.exists()) current = current.parentFile
        return current ?: file
      }
    }
  }

  /** A file opened for writing: its handle and size. */
  data class Opened(val handle: String, val size: Long)

  /** A stored file's size and where it is. */
  data class Stat(val size: Long, val file: File)

  /** Bytes read from a file, and the file's size. */
  data class Chunk(val bytes: ByteArray, val size: Long)

  private class Writer(val name: String, val file: File, val access: RandomAccessFile, val owner: Any?)

  private val writers = HashMap<String, Writer>()
  private var lastHandle = 0L

  /** Every byte written since this object was made, for the progress notification. */
  @get:Synchronized
  var bytesWritten: Long = 0
    private set

  /** The names of the files open for writing. */
  @get:Synchronized
  val openNames: Set<String>
    get() = writers.values.map { it.name }.toSet()

  /**
   * Opens [name] for writing, creating it empty when it does not exist. One writer per file: a
   * second one of the same [owner] (the page that writes) is refused, while one another owner
   * left open is closed first, since only one page writes at a time and that one is gone.
   */
  @Synchronized
  fun open(name: String, owner: Any? = null): Opened {
    val file = fileOf(name)
    for ((handle, writer) in writers.entries.toList()) {
      if (writer.name != name) continue
      if (writer.owner === owner) throw DownloadFileException(BUSY, "$name is already open")
      close(handle)
    }
    if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) {
      throw DownloadFileException(UNAVAILABLE, "The downloads folder can't be created")
    }
    val access =
      try {
        RandomAccessFile(file, "rw")
      } catch (e: IOException) {
        throw failure("Couldn't open $name", e)
      }
    lastHandle += 1
    val handle = "w$lastHandle"
    writers[handle] = Writer(name, file, access, owner)
    return Opened(handle, access.length())
  }

  /** Writes [bytes] at [offset], growing the file as needed. Returns the file's size now. */
  @Synchronized
  fun write(handle: String, offset: Long, bytes: ByteArray): Long {
    val writer = writer(handle)
    if (offset < 0) throw DownloadFileException(BAD_REQUEST, "A negative offset")
    try {
      val growth = maxOf(0L, offset + bytes.size - writer.access.length())
      ensureRoom(growth)
      writer.access.seek(offset)
      writer.access.write(bytes)
      bytesWritten += bytes.size
      return writer.access.length()
    } catch (e: IOException) {
      throw failure("Couldn't write ${writer.name}", e)
    }
  }

  /** Cuts or extends the file to [size] bytes. Returns the file's size now. */
  @Synchronized
  fun truncate(handle: String, size: Long): Long {
    val writer = writer(handle)
    if (size < 0) throw DownloadFileException(BAD_REQUEST, "A negative size")
    try {
      ensureRoom(maxOf(0L, size - writer.access.length()))
      writer.access.setLength(size)
      return writer.access.length()
    } catch (e: IOException) {
      throw failure("Couldn't truncate ${writer.name}", e)
    }
  }

  /** Makes what was written so far survive a crash. */
  @Synchronized
  fun flush(handle: String) {
    val writer = writer(handle)
    try {
      writer.access.fd.sync()
    } catch (e: IOException) {
      throw failure("Couldn't flush ${writer.name}", e)
    }
  }

  /** The size of the file open as [handle]. */
  @Synchronized
  fun size(handle: String): Long {
    val writer = writer(handle)
    return try {
      writer.access.length()
    } catch (e: IOException) {
      throw failure("Couldn't read the size of ${writer.name}", e)
    }
  }

  /** Flushes and releases the file. A handle closed already, or unknown, is ignored. */
  @Synchronized
  fun close(handle: String) {
    val writer = writers.remove(handle) ?: return
    try {
      writer.access.fd.sync()
    } catch (e: IOException) {
      // Closing releases the file all the same; what reached the disk stays.
    } finally {
      runCatching { writer.access.close() }
    }
  }

  /** Releases the files [owner] opened: that page is gone (it reloaded, or its renderer died). */
  @Synchronized
  fun closeOwnedBy(owner: Any?) {
    for ((handle, writer) in writers.entries.toList()) if (writer.owner === owner) close(handle)
  }

  /** [name]'s size and file, or `null` when it does not exist. */
  @Synchronized
  fun stat(name: String): Stat? {
    val file = fileOf(name)
    return if (file.isFile) Stat(file.length(), file) else null
  }

  /** Up to [length] bytes of [name] from [offset] (fewer at its end), or `null` when it is gone. */
  @Synchronized
  fun read(name: String, offset: Long, length: Int): Chunk? {
    val file = fileOf(name)
    if (offset < 0 || length < 0) throw DownloadFileException(BAD_REQUEST, "A negative range")
    if (!file.isFile) return null
    try {
      RandomAccessFile(file, "r").use { input ->
        val size = input.length()
        val count = maxOf(0L, minOf(length.toLong(), size - offset)).toInt()
        val bytes = ByteArray(count)
        input.seek(minOf(offset, size))
        input.readFully(bytes)
        return Chunk(bytes, size)
      }
    } catch (e: IOException) {
      throw failure("Couldn't read $name", e)
    }
  }

  /** Deletes [name]. Nothing happens when it does not exist; an open file can't be deleted. */
  @Synchronized
  fun remove(name: String) {
    val file = fileOf(name)
    if (writers.values.any { it.name == name }) throw DownloadFileException(BUSY, "$name is open")
    if (file.exists() && !file.delete() && file.exists()) {
      throw DownloadFileException(IO, "Couldn't delete $name")
    }
  }

  /** The names of every stored file. */
  @Synchronized
  fun list(): List<String> =
    directory.listFiles()?.filter { it.isFile && isSafeName(it.name) }?.map { it.name }?.sorted() ?: emptyList()

  /** The file of a complete download, to read it whole (an export): not one open for writing. */
  @Synchronized
  fun completeFile(name: String): File {
    val file = fileOf(name)
    if (writers.values.any { it.name == name }) throw DownloadFileException(BUSY, "$name is still being written")
    if (!file.isFile) throw DownloadFileException(NOT_FOUND, "$name is gone")
    return file
  }

  /** Whether the folder is there or can be made: the storage works. */
  @Synchronized
  fun ready(): Boolean = directory.isDirectory || directory.mkdirs() || directory.isDirectory

  /** How much free space the downloads may not take. */
  fun reserve(): Long = reserveBytes(space.total())

  /** The bytes downloads may still take. */
  fun available(): Long = maxOf(0L, space.usable() - reserve())

  private fun ensureRoom(growth: Long) {
    if (growth > 0 && space.usable() - growth < reserve()) {
      throw DownloadFileException(NO_SPACE, "There is no room left for downloads")
    }
  }

  private fun writer(handle: String): Writer =
    writers[handle] ?: throw DownloadFileException(NOT_FOUND, "No file is open as $handle")

  private fun fileOf(name: String): File {
    if (!isSafeName(name)) throw DownloadFileException(BAD_REQUEST, "Not a download file name")
    return File(directory, name)
  }

  companion object {
    /** The folder inside the app's files (`Context.getFilesDir()`). */
    const val FOLDER = "downloads"

    // The FxmDownloads plugin's error codes (FXM_DOWNLOADS_ERROR_CODES in @fxm/downloads).
    const val BAD_REQUEST = "BAD_REQUEST"
    const val NOT_FOUND = "NOT_FOUND"
    const val BUSY = "BUSY"
    const val NO_SPACE = "NO_SPACE"
    const val DENIED = "DENIED"
    const val UNAVAILABLE = "UNAVAILABLE"
    const val IO = "IO"

    /** Android's low-storage threshold: 5 % of the storage ... */
    private const val RESERVE_PERCENT = 5L

    /** ... at most 500 MiB (`StorageManager`'s defaults). */
    private const val RESERVE_MAX_BYTES = 500L * 1024 * 1024

    private val NAME = Regex("[A-Za-z0-9_-]{1,64}")
    private val DEVICE_NAME = Regex("(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])")

    /** The app's downloads folder. */
    fun directory(context: Context): File = File(context.filesDir, FOLDER)

    /** Whether [name] may name a download's file (`isSafeFileName` in `@fxm/downloads`). */
    fun isSafeName(name: String): Boolean = NAME.matches(name) && !DEVICE_NAME.matches(name)

    /** The free space downloads leave on a storage of [total] bytes. */
    fun reserveBytes(total: Long): Long = minOf(total * RESERVE_PERCENT / 100, RESERVE_MAX_BYTES)

    /** [error] as a [DownloadFileException]: a full disk is [NO_SPACE], anything else [IO]. */
    fun failure(message: String, error: IOException): DownloadFileException {
      if (error is DownloadFileException) return error
      val text = generateSequence<Throwable>(error) { it.cause }.mapNotNull { it.message }.joinToString(" ")
      val full = text.contains("ENOSPC") || text.contains("No space left", ignoreCase = true)
      return DownloadFileException(if (full) NO_SPACE else IO, message, error)
    }
  }
}
