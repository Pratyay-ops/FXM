package io.github.pratyayops.fxm.player

/**
 * When to recreate the web app after its WebView renderer died. The first time at once; if it
 * dies again soon after, later and later, so a renderer the system keeps killing for memory does
 * not take the app into a restart loop. After [healthyAfterMs] without a death the delays start
 * over. While the app is on screen the user is looking at a dead page, so it is recreated at once.
 */
class RestartPolicy(
  private val delaysMs: List<Long> = listOf(0, 30_000, 120_000, 600_000),
  private val healthyAfterMs: Long = 30 * 60_000,
) {
  private var deaths = 0
  private var lastRestartAt: Long? = null

  init {
    require(delaysMs.isNotEmpty()) { "At least one delay" }
  }

  /** The delay before recreating the web app after a renderer death at [now]. */
  fun delayAfterDeath(now: Long, visible: Boolean): Long {
    val last = lastRestartAt
    if (last != null && now - last >= healthyAfterMs) deaths = 0
    val delay = if (visible) 0 else delaysMs[minOf(deaths, delaysMs.size - 1)]
    deaths += 1
    lastRestartAt = now + delay
    return delay
  }
}
