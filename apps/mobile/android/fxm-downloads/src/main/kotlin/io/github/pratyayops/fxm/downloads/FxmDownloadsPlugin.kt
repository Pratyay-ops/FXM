package io.github.pratyayops.fxm.downloads

import android.Manifest
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONArray

/**
 * `FxmDownloads`: the Android app's side of the web app's downloads (stage 6.4), the native side
 * of `packages/downloads/src/native/plugin.ts`.
 *
 * - **Files** ([DownloadFiles]): the download manager's `DownloadStorage` in the app's own
 *   storage. Bytes cross the bridge in base64; every file operation runs on one worker thread,
 *   so none blocks the bridge, which Capacitor runs every plugin on.
 * - **Save to Music** ([MusicExporter]): a copy of a finished download in Music/FXM, through
 *   MediaStore (on Android 9 and older after asking for `WRITE_EXTERNAL_STORAGE`).
 * - **Background** ([BackgroundDownloads]): the web app reports its queue, and a `dataSync`
 *   foreground service keeps the app running while it has work, with a progress notification
 *   (`POST_NOTIFICATIONS`, asked for from the first download on Android 13+).
 *
 * When the page goes away (a reload, a renderer that died), its open files are closed: a new
 * page starts its own writers, and the download manager continues each file from its size.
 */
@CapacitorPlugin(
  name = FxmDownloadsPlugin.NAME,
  permissions = [
    Permission(alias = FxmDownloadsPlugin.NOTIFICATIONS, strings = [Manifest.permission.POST_NOTIFICATIONS]),
    Permission(alias = FxmDownloadsPlugin.MUSIC_FOLDER, strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE]),
  ],
)
class FxmDownloadsPlugin : Plugin() {
  private val main = Handler(Looper.getMainLooper())
  private lateinit var worker: ExecutorService
  private lateinit var files: DownloadFiles
  private lateinit var background: BackgroundDownloads

  /** The page that writes now: its writers are closed when it goes away. */
  @Volatile private var page = Any()

  private val pages =
    object : WebViewListener() {
      override fun onPageStarted(webView: WebView?) = pageGone()

      override fun onRenderProcessGone(webView: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        pageGone()
        // Not handled here: the native player (fxm-player) keeps the app alive.
        return false
      }
    }

  override fun load() {
    val shared = shared(context.applicationContext)
    worker = shared.worker
    files = shared.files
    background = shared.background
    bridge.addWebViewListener(pages)
  }

  override fun handleOnStart() {
    main.post { background.appVisible() }
  }

  override fun handleOnDestroy() {
    pageGone()
  }

  // --- Files -----------------------------------------------------------------------------------

  /** Whether downloads can be stored here, and the room they have. */
  @PluginMethod
  fun info(call: PluginCall) {
    io(call) {
      JSObject().put("available", files.ready()).put("freeBytes", files.available()).put("reserveBytes", files.reserve())
    }
  }

  /** Opens a file for writing: resolves with its handle and size. */
  @PluginMethod
  fun open(call: PluginCall) {
    val file = name(call) ?: return
    val owner = page
    io(call) {
      val opened = files.open(file, owner)
      JSObject().put("handle", opened.handle).put("size", opened.size)
    }
  }

  /** Writes base64 bytes at an offset: resolves with the file's size. */
  @PluginMethod
  fun write(call: PluginCall) {
    val handle = handle(call) ?: return
    val offset = whole(call, "offset") ?: return
    val data = call.getString("data")
    if (data == null) return bad(call, "data is missing")
    io(call) {
      val bytes =
        try {
          Base64.decode(data, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
          throw DownloadFileException(DownloadFiles.BAD_REQUEST, "data is not base64")
        }
      JSObject().put("size", files.write(handle, offset, bytes))
    }
  }

  @PluginMethod
  fun truncate(call: PluginCall) {
    val handle = handle(call) ?: return
    val size = whole(call, "size") ?: return
    io(call) { JSObject().put("size", files.truncate(handle, size)) }
  }

  @PluginMethod
  fun flush(call: PluginCall) {
    val handle = handle(call) ?: return
    io(call) {
      files.flush(handle)
      JSObject()
    }
  }

  @PluginMethod
  fun size(call: PluginCall) {
    val handle = handle(call) ?: return
    io(call) { JSObject().put("size", files.size(handle)) }
  }

  @PluginMethod
  fun close(call: PluginCall) {
    val handle = handle(call) ?: return
    io(call) {
      files.close(handle)
      JSObject()
    }
  }

  /** A stored file's size and `file:` URI, both `null` when it does not exist. */
  @PluginMethod
  fun stat(call: PluginCall) {
    val file = name(call) ?: return
    io(call) {
      val stat = files.stat(file)
      JSObject()
        .put("size", stat?.size ?: JSObject.NULL)
        .put("uri", stat?.file?.let { "file://${it.absolutePath}" } ?: JSObject.NULL)
    }
  }

  /** Up to `length` bytes (at most 1 MiB) from `offset`, base64; `data` is `null` when gone. */
  @PluginMethod
  fun read(call: PluginCall) {
    val file = name(call) ?: return
    val offset = whole(call, "offset") ?: return
    val length = whole(call, "length") ?: return
    io(call) {
      val chunk = files.read(file, offset, minOf(length, MAX_READ_BYTES).toInt())
      JSObject()
        .put("data", chunk?.let { Base64.encodeToString(it.bytes, Base64.NO_WRAP) } ?: JSObject.NULL)
        .put("size", chunk?.size ?: JSObject.NULL)
    }
  }

  @PluginMethod
  fun remove(call: PluginCall) {
    val file = name(call) ?: return
    io(call) {
      files.remove(file)
      JSObject()
    }
  }

  @PluginMethod
  fun list(call: PluginCall) {
    io(call) { JSObject().put("files", JSArray(files.list())) }
  }

  // --- Save to Music ---------------------------------------------------------------------------

  /**
   * Saves a copy of a complete download to Music/FXM: `file`, its `codec`, `container` and
   * `media`, and the song's `title`, `artists` and `album`. Resolves with its `uri` and `path`.
   */
  @PluginMethod
  fun exportToMusic(call: PluginCall) {
    val file = name(call) ?: return
    val format =
      ExportFormats.of(call.getString("codec") ?: "", call.getString("container") ?: "", call.getString("media") ?: "")
    if (format == null) {
      call.reject("This download's format can't be saved to Music yet", DownloadFiles.BAD_REQUEST)
      return
    }
    val song = SongInfo(call.getString("title") ?: "", strings(call.getArray("artists")), call.getString("album"))
    if (Build.VERSION.SDK_INT < 29 && getPermissionState(MUSIC_FOLDER) != PermissionState.GRANTED) {
      requestPermissionForAlias(MUSIC_FOLDER, call, "musicFolderAnswered")
      return
    }
    export(call, file, format, song)
  }

  @PermissionCallback
  private fun musicFolderAnswered(call: PluginCall) {
    if (getPermissionState(MUSIC_FOLDER) != PermissionState.GRANTED) {
      call.reject("FXM may not save to the Music folder", DownloadFiles.DENIED)
      return
    }
    exportToMusic(call)
  }

  private fun export(call: PluginCall, file: String, format: ExportFormat, song: SongInfo) {
    val folder = if (Build.VERSION.SDK_INT >= 29) MediaStoreMusicFolder(context.contentResolver) else LegacyMusicFolder(context)
    io(call) {
      val exported = MusicExporter(folder).export(files.completeFile(file), format, song)
      JSObject().put("uri", exported.uri).put("path", exported.path)
    }
  }

  // --- Background ------------------------------------------------------------------------------

  /**
   * The web app's queue: `downloading`, `queued`, `online` and the `title` of a song being
   * downloaded. Resolves with whether the foreground service `running`, and the state of the
   * `notifications` permission.
   */
  @PluginMethod
  fun setBackground(call: PluginCall) {
    val downloading = whole(call, "downloading") ?: return
    val queued = whole(call, "queued") ?: return
    val report =
      QueueReport(
        downloading = downloading.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
        queued = queued.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
        online = call.getBoolean("online", true) ?: true,
        title = call.getString("title")?.take(MAX_TITLE_CHARS),
      )
    main.post {
      val running = background.report(report)
      call.resolve(JSObject().put("running", running).put("notifications", notificationState()))
    }
  }

  /** Asks for `POST_NOTIFICATIONS` (Android 13+), so the download notification shows. */
  @PluginMethod
  fun requestNotifications(call: PluginCall) {
    if (Build.VERSION.SDK_INT < 33 || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
      call.resolve(JSObject().put("notifications", notificationState()))
      return
    }
    requestPermissionForAlias(NOTIFICATIONS, call, "notificationsAnswered")
  }

  @PermissionCallback
  private fun notificationsAnswered(call: PluginCall) {
    call.resolve(JSObject().put("notifications", notificationState()))
  }

  private fun notificationState(): String =
    if (Build.VERSION.SDK_INT < 33) "granted" else (getPermissionState(NOTIFICATIONS) ?: PermissionState.PROMPT).toString()

  // --- Helpers ---------------------------------------------------------------------------------

  /** The page that wrote went away: its writers with it, and the queue it reported. */
  private fun pageGone() {
    val gone = page
    page = Any()
    worker.execute { files.closeOwnedBy(gone) }
    main.post { background.pageGone() }
  }

  /**
   * Runs [block] on the worker thread and resolves with what it returns, or rejects by code
   * ([DownloadFiles.codeOf]). Every failure settles the call: one that escaped the task would end
   * the app (an uncaught exception on any thread does), and leave the call waiting.
   */
  private fun io(call: PluginCall, block: () -> JSObject) {
    worker.execute {
      try {
        call.resolve(block())
      } catch (e: Exception) {
        call.reject(e.message ?: "The download storage failed", DownloadFiles.codeOf(e))
      }
    }
  }

  private fun name(call: PluginCall): String? {
    val file = call.getString("file")
    if (file == null || !DownloadFiles.isSafeName(file)) {
      bad(call, "Not a download file name")
      return null
    }
    return file
  }

  private fun handle(call: PluginCall): String? {
    val handle = call.getString("handle")
    if (handle.isNullOrEmpty() || handle.length > MAX_HANDLE_CHARS) {
      bad(call, "A handle is missing")
      return null
    }
    return handle
  }

  /** A whole, non-negative number of [name] up to JavaScript's safe integers. */
  private fun whole(call: PluginCall, name: String): Long? {
    val value = call.data.opt(name) as? Number
    val number = value?.toDouble()
    if (number == null || number.isNaN() || number < 0 || number > MAX_SAFE_INTEGER || number != Math.floor(number)) {
      bad(call, "$name must be a whole, non-negative number")
      return null
    }
    return number.toLong()
  }

  private fun bad(call: PluginCall, message: String) = call.reject(message, DownloadFiles.BAD_REQUEST)

  private fun strings(array: JSONArray?): List<String> =
    if (array == null) emptyList() else (0 until minOf(array.length(), MAX_ARTISTS)).mapNotNull { array.opt(it) as? String }

  companion object {
    const val NAME = "FxmDownloads"
    const val NOTIFICATIONS = "notifications"
    const val MUSIC_FOLDER = "musicFolder"

    /** The most bytes one `read` returns: 1 MiB. */
    const val MAX_READ_BYTES = 1024L * 1024
    private const val MAX_HANDLE_CHARS = 32
    private const val MAX_TITLE_CHARS = 200
    private const val MAX_ARTISTS = 20
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

    /** What every plugin of the process shares. */
    private class Shared(val worker: ExecutorService, val files: DownloadFiles, val background: BackgroundDownloads)

    private var shared: Shared? = null

    /**
     * One worker thread, one store and one service controller for the process, whichever
     * activity's plugin asks: a recreated activity must find the writers its predecessor's page
     * left open, and the service it kept running; one thread keeps every file call in order.
     */
    @Synchronized
    private fun shared(context: android.content.Context): Shared {
      shared?.let { return it }
      val files = DownloadFiles(DownloadFiles.directory(context))
      val main = Handler(Looper.getMainLooper())
      val background =
        BackgroundDownloads(
          DownloadService.control(context),
          { delayMs, task ->
            val runnable = Runnable(task)
            main.postDelayed(runnable, delayMs)
            return@BackgroundDownloads { main.removeCallbacks(runnable) }
          },
          { files.bytesWritten },
        )
      DownloadService.controller = background
      val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "fxm-downloads").apply { isDaemon = true } }
      return Shared(worker, files, background).also { shared = it }
    }
  }
}
