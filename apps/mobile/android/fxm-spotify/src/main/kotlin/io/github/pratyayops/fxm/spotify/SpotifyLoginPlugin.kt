package io.github.pratyayops.fxm.spotify

import android.content.Intent
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * `FxmSpotifyLogin`: the Android app's Spotify login, the native side of
 * packages/platform/src/android-spotify-login.ts.
 *
 * - `status` says whether a login is kept, and whether the login window can open here.
 * - `login` opens the login window ([SpotifyLoginActivity]) and resolves once it closes.
 * - `logout` deletes the kept login and its key and clears the login window's cookies.
 * - `requestToken` sends the token call with the kept login ([SpotifyTokenCall]) and resolves with
 *   Spotify's status and JSON body. The cookie never crosses the bridge, nor does the password.
 *
 * Capacitor runs plugin methods on one thread, so the token call runs on a worker of its own.
 */
@CapacitorPlugin(name = LoginProtocol.PLUGIN_NAME)
class SpotifyLoginPlugin : Plugin() {
  private lateinit var store: SessionStore
  private lateinit var tokens: SpotifyTokenCall
  private var available = false

  override fun load() {
    store = SpotifyLogin.store(context)
    tokens = SpotifyLogin.tokenCall(context)
    available = SpotifyLogin.windowAvailable()
  }

  /** Resolves with where the login stands. */
  @PluginMethod
  fun status(call: PluginCall) {
    call.resolve(state())
  }

  /** Opens the login window; resolves with where the login stands once it closes. */
  @PluginMethod
  fun login(call: PluginCall) {
    if (!available) return call.resolve(state())
    if (SpotifyLoginActivity.open) {
      return reject(call, LoginFailure(LoginErrorCode.BUSY, "The Spotify login window is open"))
    }
    val screen =
      activity
        ?: return reject(
          call,
          LoginFailure(LoginErrorCode.NO_ACTIVITY, "There is no screen to open the login on"),
        )
    startActivityForResult(call, Intent(screen, SpotifyLoginActivity::class.java), "loginClosed")
  }

  @ActivityCallback
  private fun loginClosed(call: PluginCall?, result: ActivityResult) {
    // No call: the page that asked is gone (its activity was recreated). The login is kept anyway,
    // and the new page finds it with `status`.
    if (call == null) return
    if (result.resultCode == SpotifyLoginActivity.RESULT_NOT_KEPT) {
      reject(call, LoginFailure(LoginErrorCode.STORAGE, "FXM couldn't keep the Spotify login"))
    } else {
      call.resolve(state())
    }
    bridge.releaseCall(call)
  }

  /** Logs out on this device; resolves with where the login stands then. */
  @PluginMethod
  fun logout(call: PluginCall) {
    bridge.executeOnMainThread {
      try {
        SpotifyLogin.logout(context)
        call.resolve(state())
      } catch (e: RuntimeException) {
        // On the main thread, an uncaught exception would end the app.
        reject(call, LoginFailure(LoginErrorCode.STORAGE, "FXM couldn't log out of Spotify here"))
      }
    }
  }

  /** Sends the token call with the kept login; resolves with Spotify's status and JSON body. */
  @PluginMethod
  fun requestToken(call: PluginCall) {
    val params =
      try {
        LoginMessages.tokenParams(call.data)
      } catch (e: LoginFailure) {
        return reject(call, e)
      }
    WORKER.execute {
      try {
        call.resolve(js(LoginMessages.answer(tokens.request(params))))
      } catch (e: LoginFailure) {
        reject(call, e)
      } catch (e: RuntimeException) {
        reject(call, LoginFailure(LoginErrorCode.NETWORK, "The Spotify token request failed"))
      }
    }
  }

  private fun state(): JSObject = js(LoginMessages.state(store.isLoggedIn(), available))

  /** Rejects with the failure's code, and `data.retryAfterMs` when it says how long to wait. */
  private fun reject(call: PluginCall, failure: LoginFailure) {
    val data = failure.retryAfterMs?.let { JSObject().put("retryAfterMs", it) }
    call.reject(failure.message ?: failure.code.name, failure.code.name, null, data)
  }

  private fun js(json: JSONObject): JSObject = JSObject.fromJSONObject(json)

  companion object {
    /** The token calls, one at a time, off Capacitor's plugin thread. */
    private val WORKER: ExecutorService =
      Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "fxm-spotify-token").apply { isDaemon = true }
      }
  }
}
