package io.github.pratyayops.fxm.player

import android.app.Activity
import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference

/**
 * Brings the web app back after its WebView renderer died, killed by the system for memory or
 * with adb. The FxmPlayer plugin reports the death as handled
 * (`WebViewClient.onRenderProcessGone` returns `true`), so Android does not kill the app's
 * process, and the native player keeps playing. A dead WebView cannot be used again, so this
 * recreates the activity, whose new WebView loads the web app, which attaches to the native
 * player and carries on ([RestartPolicy] spaces out repeated deaths). [restartResolver] runs a
 * pending restart at once when the native player needs the web app. Main thread only.
 */
object WebViewRecovery : ResolverHost {
  private val handler = Handler(Looper.getMainLooper())
  private val policy = RestartPolicy()
  private var activity: WeakReference<Activity>? = null
  private var dead: WeakReference<Activity>? = null
  private var visible = false
  private var pending: Runnable? = null

  /** [activity] hosts the web app now. */
  fun register(activity: Activity) {
    this.activity = WeakReference(activity)
  }

  fun unregister(activity: Activity) {
    if (this.activity?.get() === activity) this.activity = null
  }

  fun setVisible(activity: Activity, visible: Boolean) {
    if (this.activity?.get() === activity) this.visible = visible
  }

  /** [activity]'s WebView renderer is gone. */
  fun onRendererGone(activity: Activity) {
    dead = WeakReference(activity)
    schedule(activity, policy.delayAfterDeath(System.currentTimeMillis(), visible))
  }

  /** Recreates the activity whose renderer died, now; `false` when there is none to recreate. */
  override fun restartResolver(): Boolean {
    val activity = dead?.get() ?: return false
    if (activity.isFinishing || activity.isDestroyed) return false
    schedule(activity, 0)
    return true
  }

  private fun schedule(activity: Activity, delayMs: Long) {
    pending?.let(handler::removeCallbacks)
    val restart =
      Runnable {
        pending = null
        dead = null
        if (!activity.isFinishing && !activity.isDestroyed) activity.recreate()
      }
    pending = restart
    handler.postDelayed(restart, delayMs)
  }
}
