package io.github.pratyayops.fxm.player

import android.os.Handler

/** A [Scheduler] on an Android [Handler]: the main thread's, for the coordinator. */
class HandlerScheduler(private val handler: Handler) : Scheduler {
  override fun schedule(delayMs: Long, task: () -> Unit): Cancelable {
    val runnable = Runnable(task)
    handler.postDelayed(runnable, delayMs)
    return Cancelable { handler.removeCallbacks(runnable) }
  }
}
