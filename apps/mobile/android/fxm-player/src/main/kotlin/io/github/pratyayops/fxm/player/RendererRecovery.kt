package io.github.pratyayops.fxm.player

import java.lang.ref.WeakReference

/**
 * When to recreate the web app's activity after its WebView renderer died: the decisions behind
 * [WebViewRecovery], in plain Kotlin over a [Scheduler] and a [Clock], so the JVM tests cover them.
 *
 * - A death schedules the restart after [RestartPolicy]'s delay: at once the first time, or while
 *   the app is on screen; later and later after repeated deaths in the background.
 * - Coming back on screen while a restart waits runs it at once: the user is looking at a dead
 *   page.
 * - [restartResolver] runs a waiting restart at once when the native player needs the web app.
 *
 * [A] is the activity; [alive] tells whether one can still be recreated (not finishing or
 * destroyed), and [recreate] recreates it. Activities are held weakly. One thread only.
 */
class RendererRecovery<A : Any>(
  private val scheduler: Scheduler,
  private val clock: Clock,
  private val alive: (A) -> Boolean,
  private val recreate: (A) -> Unit,
  private val policy: RestartPolicy = RestartPolicy(),
) : ResolverHost {
  private var host: WeakReference<A>? = null
  private var dead: WeakReference<A>? = null
  private var visible = false
  private var pending: Cancelable? = null

  /** Whether a restart is scheduled. */
  val restartPending: Boolean
    get() = pending != null

  /** [activity] hosts the web app now. */
  fun register(activity: A) {
    host = WeakReference(activity)
  }

  fun unregister(activity: A) {
    if (host?.get() === activity) host = null
  }

  /** Whether [activity], the one hosting the web app, is on screen. */
  fun setVisible(activity: A, visible: Boolean) {
    if (host?.get() !== activity) return
    this.visible = visible
    if (visible && pending != null && dead?.get() === activity) restartResolver()
  }

  /** [activity]'s WebView renderer is gone. */
  fun onRendererGone(activity: A) {
    dead = WeakReference(activity)
    schedule(activity, policy.delayAfterDeath(clock.now(), visible))
  }

  /** Recreates the activity whose renderer died, now; `false` when there is none to recreate. */
  override fun restartResolver(): Boolean {
    val activity = dead?.get() ?: return false
    if (!alive(activity)) return false
    schedule(activity, 0)
    return true
  }

  private fun schedule(activity: A, delayMs: Long) {
    pending?.cancel()
    pending =
      scheduler.schedule(delayMs) {
        pending = null
        dead = null
        if (alive(activity)) recreate(activity)
      }
  }
}
