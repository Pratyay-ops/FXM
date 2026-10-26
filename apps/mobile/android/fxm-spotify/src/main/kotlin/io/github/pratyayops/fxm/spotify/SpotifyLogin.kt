package io.github.pratyayops.fxm.spotify

import android.annotation.SuppressLint
import android.content.Context
import androidx.webkit.ProfileStore
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import io.github.pratyayops.fxm.http.FxmHttp
import java.io.File
import java.io.IOException

/**
 * The Spotify login's pieces, one of each per app process: the kept login ([store]), the token
 * call ([tokenCall]) and the login window's WebView profile ([PROFILE]). Only the application
 * context is kept, never an activity.
 */
object SpotifyLogin {
  /**
   * The login window's WebView profile. Its cookies and storage are its own: the app's WebView,
   * Capacitor's cookie plugin and Capacitor's process-wide cookie handler all use the default
   * profile's, so Spotify's cookies never reach them.
   */
  const val PROFILE = "fxm-spotify-login"

  /** The kept login's file, in the app's no-backup folder. */
  private const val FILE = "fxm-spotify-session"

  @Volatile private var store: SessionStore? = null

  @Volatile private var tokens: SpotifyTokenCall? = null

  /** The kept login, sealed with a key in the Android Keystore. */
  fun store(context: Context): SessionStore {
    val app = context.applicationContext
    return store
      ?: synchronized(this) {
        store
          ?: SessionStore(FileSessionFile(File(app.noBackupFilesDir, FILE)), KeystoreCipher())
            .also { store = it }
      }
  }

  /** The token call, on fxm-http's shared client. */
  fun tokenCall(context: Context): SpotifyTokenCall {
    val app = context.applicationContext
    return tokens
      ?: synchronized(this) {
        tokens ?: SpotifyTokenCall(FxmHttp.client(app), store(app)).also { tokens = it }
      }
  }

  /**
   * Whether the login window can open: its WebView needs a profile of its own (androidx.webkit's
   * multi-profile support), which older WebViews lack. Without one, Spotify's cookies would land in
   * the app's own cookie store, where any script of the page could read them through Capacitor's
   * cookie plugin, so the window doesn't open at all.
   */
  fun windowAvailable(): Boolean =
    try {
      WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
    } catch (e: RuntimeException) {
      // No WebView installed, or one that fails to load.
      false
    }

  /**
   * Clears the login window's profile: its cookies, Spotify's among them, and its storage, and on
   * WebViews that can ([WebViewFeature.DELETE_BROWSING_DATA]) its network cache and every other
   * store too. Main thread, as the WebView's profiles require.
   */
  @SuppressLint("RequiresFeature") // windowAvailable() checks for profiles.
  fun clearWindow() {
    if (!windowAvailable()) return
    val profile = ProfileStore.getInstance().getProfile(PROFILE) ?: return
    profile.cookieManager.removeAllCookies(null)
    profile.cookieManager.flush()
    profile.webStorage.deleteAllData()
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
      WebStorageCompat.deleteBrowsingData(profile.webStorage) {}
    }
  }

  /**
   * Wipes the login window's profile: deletes it whole (cookies, cache, storage, service workers),
   * or clears it ([clearWindow]) where WebView won't delete it. WebView deletes a profile only
   * while this process hasn't loaded it: once a login window opened, the profile is cleared, and
   * deleted at the app's next start (the plugin's `load`). Main thread.
   */
  @SuppressLint("RequiresFeature") // windowAvailable() checks for profiles.
  fun wipeWindow() {
    if (!windowAvailable()) return
    try {
      ProfileStore.getInstance().deleteProfile(PROFILE)
    } catch (e: IllegalStateException) {
      // Loaded in this process, or a WebView still uses it.
      clearWindow()
    }
  }

  /**
   * Logs out on this device: deletes the kept login and its key, and wipes the login window's
   * profile ([wipeWindow]). Throws when the login is still kept ([SessionStore.forget]), after
   * wiping the profile all the same. Main thread, as the WebView's profiles require.
   */
  fun logout(context: Context) {
    val forgotten =
      try {
        store(context).forget()
        null
      } catch (e: IOException) {
        e
      }
    wipeWindow()
    if (forgotten != null) throw forgotten
  }
}
