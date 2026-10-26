package io.github.pratyayops.fxm.player

import android.app.Activity
import android.os.Handler
import android.os.Looper

/**
 * Brings the web app back after its WebView renderer died, killed by the system for memory or
 * with adb. The FxmPlayer plugin reports the death as handled
 * (`WebViewClient.onRenderProcessGone` returns `true`), so Android does not kill the app's
 * process, and the native player keeps playing. A dead WebView cannot be used again, so this
 * recreates the activity, whose new WebView loads the web app, which attaches to the native
 * player and carries on. When, is [RendererRecovery]'s decision: repeated deaths in the background
 * are spaced out ([RestartPolicy]), coming back on screen restarts at once, and so does
 * [restartResolver] when the native player needs the web app. Main thread only.
 */
object WebViewRecovery : ResolverHost {
  private val recovery =
    RendererRecovery<Activity>(
      HandlerScheduler(Handler(Looper.getMainLooper())),
      { System.currentTimeMillis() },
      alive = { !it.isFinishing && !it.isDestroyed },
      recreate = { it.recreate() },
    )

  /** [activity] hosts the web app now. */
  fun register(activity: Activity) = recovery.register(activity)

  fun unregister(activity: Activity) = recovery.unregister(activity)

  /** Whether [activity] is on screen: coming back while a restart waits runs it at once. */
  fun setVisible(activity: Activity, visible: Boolean) = recovery.setVisible(activity, visible)

  /** [activity]'s WebView renderer is gone. */
  fun onRendererGone(activity: Activity) = recovery.onRendererGone(activity)

  /** Recreates the activity whose renderer died, now; `false` when there is none to recreate. */
  override fun restartResolver(): Boolean = recovery.restartResolver()
}
