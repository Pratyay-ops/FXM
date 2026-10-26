package io.github.pratyayops.fxm.spotify

/** At most [max] events in any rolling window of [windowMs]. */
class RateLimiter(private val max: Int, private val windowMs: Long) {
  private val times = ArrayDeque<Long>()

  /** Takes a slot at [now]: `null` when there was one, else the milliseconds until one frees. */
  @Synchronized
  fun tryAcquire(now: Long): Long? {
    while (times.isNotEmpty() && times.first() <= now - windowMs) times.removeFirst()
    if (times.size >= max) return (times.first() + windowMs - now).coerceAtLeast(1)
    times.addLast(now)
    return null
  }
}
