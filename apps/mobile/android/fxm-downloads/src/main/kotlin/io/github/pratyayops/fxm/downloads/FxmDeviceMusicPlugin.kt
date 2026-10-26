package io.github.pratyayops.fxm.downloads

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * `FxmDeviceMusic`: the device's own music for the web app's local files (stage 6.4), the native
 * side of `apps/web/src/features/local-files/device/plugin.ts`. It lists the songs MediaStore
 * knows ([DeviceMusicQuery]) and their album covers; the web app plays them from their `content:`
 * URIs.
 *
 * Reading them needs `READ_MEDIA_AUDIO` on Android 13 and later and `READ_EXTERNAL_STORAGE` before;
 * the web app sees either as `music`. The plugin asks only when the web app calls
 * `requestAccess`, which it does when the user opens the device's music, never on its own; never
 * `MANAGE_EXTERNAL_STORAGE`.
 */
@CapacitorPlugin(
  name = FxmDeviceMusicPlugin.NAME,
  permissions = [
    Permission(alias = FxmDeviceMusicPlugin.AUDIO, strings = [Manifest.permission.READ_MEDIA_AUDIO]),
    Permission(alias = FxmDeviceMusicPlugin.STORAGE, strings = [Manifest.permission.READ_EXTERNAL_STORAGE]),
  ],
)
class FxmDeviceMusicPlugin : Plugin() {
  private val worker: ExecutorService =
    Executors.newSingleThreadExecutor { task -> Thread(task, "fxm-device-music").apply { isDaemon = true } }

  /** The permission alias this Android version reads music with. */
  private val alias: String
    get() = if (Build.VERSION.SDK_INT >= 33) AUDIO else STORAGE

  /** Whether the app may read the device's music: `{ music }`, a Capacitor permission state. */
  @PluginMethod
  fun checkAccess(call: PluginCall) {
    call.resolve(access())
  }

  /** Asks the user to let the app read the device's music, where Android still asks. */
  @PluginMethod
  fun requestAccess(call: PluginCall) {
    if (getPermissionState(alias) == PermissionState.GRANTED) {
      call.resolve(access())
      return
    }
    requestPermissionForAlias(alias, call, "accessAnswered")
  }

  @PermissionCallback
  private fun accessAnswered(call: PluginCall) {
    call.resolve(access())
  }

  /** Opens the app's page in Android's settings, where the user can allow music after refusing. */
  @PluginMethod
  fun openSettings(call: PluginCall) {
    val intent =
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
      call.resolve()
    } catch (e: RuntimeException) {
      call.reject("Android's settings can't be opened", DownloadFiles.UNAVAILABLE)
    }
  }

  /**
   * One page of songs: up to `limit` (at most [MAX_PAGE]) after the MediaStore id `after` (a
   * string; none for the first page). Resolves with `items`, the `next` id to continue after
   * (`null` at the end) and, for the first page, the `total`.
   */
  @PluginMethod
  fun scan(call: PluginCall) {
    if (!granted(call)) return
    val after = call.getString("after")?.toLongOrNull() ?: 0L
    val limit = (call.getInt("limit") ?: MAX_PAGE).coerceIn(1, MAX_PAGE)
    run(call) {
      val query = DeviceMusicQuery(context.contentResolver)
      val page = query.page(after, limit)
      val result = JSObject().put("items", JSArray(page.items)).put("next", page.next?.toString() ?: JSObject.NULL)
      if (after == 0L) result.put("total", query.count())
      result
    }
  }

  /**
   * The covers of `albums` (`{ volume, id, track }` each, at most [MAX_ALBUMS]), at most `size`
   * pixels on their longer side: `pictures`, `{ volume, id, data, width, height }` each with the
   * JPEG in base64, for the albums that have one.
   */
  @PluginMethod
  fun artwork(call: PluginCall) {
    if (!granted(call)) return
    val albums =
      call.getArray("albums")?.let { array ->
        (0 until minOf(array.length(), MAX_ALBUMS)).mapNotNull { index -> albumRef(array.optJSONObject(index)) }
      } ?: emptyList()
    val size = (call.getInt("size") ?: DEFAULT_ART_PX).coerceIn(MIN_ART_PX, MAX_ART_PX)
    run(call) {
      val query = DeviceMusicQuery(context.contentResolver)
      val pictures = JSArray()
      for (album in albums) {
        val thumbnail = query.thumbnail(album, size) ?: continue
        pictures.put(
          JSONObject()
            .put("volume", album.volume)
            .put("id", album.id.toString())
            .put("data", Base64.encodeToString(thumbnail.jpeg, Base64.NO_WRAP))
            .put("width", thumbnail.width)
            .put("height", thumbnail.height),
        )
      }
      JSObject().put("pictures", pictures)
    }
  }

  private fun access(): JSObject = JSObject().put("music", (getPermissionState(alias) ?: PermissionState.PROMPT).toString())

  /** Whether the app may read music; rejects the call with `DENIED` otherwise. */
  private fun granted(call: PluginCall): Boolean {
    if (getPermissionState(alias) == PermissionState.GRANTED) return true
    call.reject("FXM may not read the music on this device", DownloadFiles.DENIED)
    return false
  }

  private fun albumRef(json: JSONObject?): AlbumRef? {
    val volume = json?.optString("volume")?.takeIf { VOLUME.matches(it) } ?: return null
    val id = json.optString("id").toLongOrNull()?.takeIf { it > 0 } ?: return null
    val track = json.optString("track").toLongOrNull()?.takeIf { it > 0 }
    return AlbumRef(volume, id, track)
  }

  private fun run(call: PluginCall, block: () -> JSObject) {
    worker.execute {
      try {
        call.resolve(block())
      } catch (e: SecurityException) {
        call.reject("FXM may not read the music on this device", DownloadFiles.DENIED)
      } catch (e: RuntimeException) {
        call.reject(e.message ?: "The device's music can't be read", DownloadFiles.IO)
      }
    }
  }

  companion object {
    const val NAME = "FxmDeviceMusic"
    const val AUDIO = "audio"
    const val STORAGE = "storage"

    /** The most songs one `scan` returns. */
    const val MAX_PAGE = 500

    /** The most covers one `artwork` call makes. */
    const val MAX_ALBUMS = 24
    private const val DEFAULT_ART_PX = 128
    private const val MIN_ART_PX = 32
    private const val MAX_ART_PX = 512

    private val VOLUME = Regex("[A-Za-z0-9_-]{1,64}")
  }
}
