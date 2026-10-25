package io.github.pratyayops.fxm.player

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * `FxmPlayer`: the native player for the web app, the native side of
 * packages/player/src/native/plugin.ts. It binds [PlaybackService] and hands the web app's
 * commands to its [Coordinator] on the main thread; the coordinator's [Event]s come back as
 * plugin events once the web app has called `attach`.
 *
 * It also keeps the app alive when the WebView's renderer dies: it reports the death as handled,
 * stops talking to the dead page and lets [WebViewRecovery] recreate the activity, while the
 * service plays on.
 */
@CapacitorPlugin(name = FxmPlayerPlugin.NAME)
class FxmPlayerPlugin : Plugin() {
  private val main = Handler(Looper.getMainLooper())
  private var service: PlaybackService? = null
  private var bound = false
  private var visible = true
  /** Set once the renderer died: nothing may reach the dead page any more. */
  @Volatile private var gone = false
  /** Work that waits for the service, run on the main thread once it is bound. */
  private val waiting = mutableListOf<(PlaybackService?) -> Unit>()

  private val link =
    JsLink { event ->
      if (!gone) {
        val (name, data) = PlayerMessages.event(event)
        notifyListeners(name, JSObject.fromJSONObject(data))
      }
    }

  private val connection =
    object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
        val connected = (binder as? PlaybackService.LocalBinder)?.service
        service = connected
        connected?.setVisible(visible)
        flush(connected)
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        service = null
      }

      override fun onNullBinding(name: ComponentName?) {
        flush(null)
      }
    }

  private val renderer =
    object : WebViewListener() {
      override fun onRenderProcessGone(webView: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        gone = true
        service?.let { it.coordinator.detach(link) }
        val host = activity
        if (host != null) WebViewRecovery.onRendererGone(host)
        // Handled: otherwise Android kills the whole process, and the player with it.
        return true
      }
    }

  override fun load() {
    bridge.addWebViewListener(renderer)
    activity?.let(WebViewRecovery::register)
  }

  override fun handleOnStart() = setVisible(true)

  override fun handleOnStop() = setVisible(false)

  override fun handleOnDestroy() {
    service?.let { it.coordinator.detach(link) }
    if (bound) {
      runCatching { context.unbindService(connection) }
      bound = false
    }
    service = null
    flush(null)
    activity?.let(WebViewRecovery::unregister)
  }

  /** Attaches the web app and resolves with the native player's session. */
  @PluginMethod
  fun attach(call: PluginCall) {
    onService(call) { call.resolve(js(PlayerMessages.session(it.coordinator.attach(link)))) }
  }

  /** Plays an entry from a position, paused until `play`, with entries queued after it. */
  @PluginMethod
  fun load(call: PluginCall) {
    val data = call.data
    val parsed =
      parse(call) {
        LoadRequest(
          PlayerMessages.entry(data.optJSONObject("entry")),
          PlayerMessages.position(data, "startAtMs"),
          PlayerMessages.entries(data.optJSONArray("upcoming")),
          PlayerMessages.hasMore(data),
          PlayerMessages.repeat(data.opt("repeat")),
        )
      } ?: return
    onService(call) {
      it.coordinator.load(parsed.entry, parsed.startAtMs, parsed.upcoming, parsed.hasMore, parsed.repeat)
      call.resolve()
    }
  }

  /** Replaces the entries queued after the current one. */
  @PluginMethod
  fun setUpcoming(call: PluginCall) {
    val data = call.data
    val upcoming = parse(call) { PlayerMessages.entries(data.optJSONArray("upcoming")) } ?: return
    val repeat = parse(call) { PlayerMessages.repeat(data.opt("repeat")) } ?: return
    val hasMore = PlayerMessages.hasMore(data)
    onService(call) {
      it.coordinator.setUpcoming(upcoming, hasMore, repeat)
      call.resolve()
    }
  }

  @PluginMethod
  fun play(call: PluginCall) {
    onService(call) {
      it.coordinator.play()
      call.resolve()
    }
  }

  @PluginMethod
  fun pause(call: PluginCall) {
    onService(call) {
      it.coordinator.pause()
      call.resolve()
    }
  }

  @PluginMethod
  fun seek(call: PluginCall) {
    val data = call.data
    val positionMs = parse(call) { PlayerMessages.position(data, "positionMs") } ?: return
    onService(call) {
      it.coordinator.seek(positionMs)
      call.resolve()
    }
  }

  @PluginMethod
  fun setVolume(call: PluginCall) {
    val data = call.data
    val volume = parse(call) { PlayerMessages.volume(data) } ?: return
    onService(call) {
      it.coordinator.setVolume(volume)
      call.resolve()
    }
  }

  /** The web app took over a system control's next or previous. */
  @PluginMethod
  fun ack(call: PluginCall) {
    onService(call) {
      it.coordinator.acknowledge()
      call.resolve()
    }
  }

  /** Keeps the web app's own state for when it attaches again. */
  @PluginMethod
  fun saveSnapshot(call: PluginCall) {
    val data = call.data
    val parsed = parse(call) { Snapshot(PlayerMessages.snapshot(data)) } ?: return
    onService(call) {
      it.coordinator.saveSnapshot(parsed.data)
      call.resolve()
    }
  }

  /** Stops playback and forgets the queue. */
  @PluginMethod
  fun release(call: PluginCall) {
    onService(call) {
      it.coordinator.release()
      call.resolve()
    }
  }

  /**
   * Debug builds only: crashes the WebView's renderer, as Android documents for testing renderer
   * deaths (`loadUrl("chrome://crash")`), so the owner can check that playback survives one
   * without root. Release builds refuse it.
   */
  @PluginMethod
  fun crashRendererForTesting(call: PluginCall) {
    val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debuggable) {
      call.reject("Only debug builds can crash their renderer", UNAVAILABLE)
      return
    }
    call.resolve()
    main.post { bridge.webView.loadUrl("chrome://crash") }
  }

  private data class LoadRequest(
    val entry: Entry,
    val startAtMs: Long,
    val upcoming: List<Entry>,
    val hasMore: Boolean,
    val repeat: Repeat,
  )

  private data class Snapshot(val data: String?)

  private fun setVisible(visible: Boolean) {
    this.visible = visible
    activity?.let { WebViewRecovery.setVisible(it, visible) }
    main.post { service?.setVisible(visible) }
  }

  /** Parses the call's options, or rejects it with `BAD_REQUEST` and returns `null`. */
  private inline fun <T> parse(call: PluginCall, block: () -> T): T? =
    try {
      block()
    } catch (e: PlayerMessageException) {
      call.reject(e.message ?: "Invalid options", BAD_REQUEST)
      null
    }

  /** Runs [block] with the service on the main thread, binding it first when needed. */
  private fun onService(call: PluginCall, block: (PlaybackService) -> Unit) {
    main.post {
      val current = service
      if (current != null) {
        run(call, current, block)
        return@post
      }
      waiting += { connected ->
        if (connected == null) call.reject("The player service is not available", UNAVAILABLE)
        else run(call, connected, block)
      }
      bind()
    }
  }

  private fun run(call: PluginCall, service: PlaybackService, block: (PlaybackService) -> Unit) {
    try {
      block(service)
    } catch (e: RuntimeException) {
      call.reject(e.message ?: "The player failed", INTERNAL)
    }
  }

  private fun bind() {
    if (bound) return
    val intent = Intent(context, PlaybackService::class.java).setAction(PlaybackService.ACTION_BIND)
    bound = runCatching { context.bindService(intent, connection, Context.BIND_AUTO_CREATE) }.getOrDefault(false)
    if (!bound) flush(null)
  }

  private fun flush(connected: PlaybackService?) {
    val work = waiting.toList()
    waiting.clear()
    for (task in work) task(connected)
  }

  private fun js(json: JSONObject): JSObject = JSObject.fromJSONObject(json)

  companion object {
    const val NAME = "FxmPlayer"
    private const val BAD_REQUEST = "BAD_REQUEST"
    private const val UNAVAILABLE = "UNAVAILABLE"
    private const val INTERNAL = "INTERNAL"
  }
}
