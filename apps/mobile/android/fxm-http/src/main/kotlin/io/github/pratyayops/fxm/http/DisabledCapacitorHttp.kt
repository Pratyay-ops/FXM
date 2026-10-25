package io.github.pratyayops.fxm.http

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Takes the place of Capacitor's built-in `CapacitorHttp` plugin, refusing every call with
 * `UNAVAILABLE`.
 *
 * The bridge registers the built-in plugin in every app, whatever `plugins.CapacitorHttp.enabled`
 * says: that setting only turns off the JavaScript patch of `fetch` and `XMLHttpRequest` (and the
 * patch's local proxy), while the plugin's own methods stay callable from any script in the
 * WebView. They reach any host and port with any method and headers through `HttpURLConnection`,
 * which sends and stores the WebView's cookies, and return the whole response: an open proxy
 * beside FxmHttp's rules. MainActivity registers this class before the bridge starts, and the
 * bridge registers the app's plugins after its own, under their names, so this one replaces it.
 */
@CapacitorPlugin(name = DisabledCapacitorHttp.NAME)
class DisabledCapacitorHttp : Plugin() {
  @PluginMethod fun request(call: PluginCall) = refuse(call)

  @PluginMethod fun get(call: PluginCall) = refuse(call)

  @PluginMethod fun post(call: PluginCall) = refuse(call)

  @PluginMethod fun put(call: PluginCall) = refuse(call)

  @PluginMethod fun patch(call: PluginCall) = refuse(call)

  @PluginMethod fun delete(call: PluginCall) = refuse(call)

  private fun refuse(call: PluginCall) = call.unavailable(MESSAGE)

  companion object {
    /** The built-in plugin's name on the bridge. */
    const val NAME = "CapacitorHttp"

    /** What every call is refused with. */
    const val MESSAGE = "CapacitorHttp is disabled in FXM; use FxmHttp"
  }
}
