package io.github.pratyayops.fxm.player

/**
 * The player [Coordinator] drives: Media3's ExoPlayer in the app ([ExoPort]), a fake in the
 * tests. Its playlist holds one item per [Slot], in the coordinator's order.
 */
interface PlayerPort {
  /** The current item's index, or -1 while the playlist is empty. */
  val currentIndex: Int
  val positionMs: Long
  /** The current item's duration, or -1 while unknown. */
  val durationMs: Long
  val playWhenReady: Boolean
  val isPlaying: Boolean
  val state: PlaybackState

  /** Replaces the playlist with [slots] and prepares it at [index] and [positionMs], paused. */
  fun setSlots(slots: List<Slot>, index: Int, positionMs: Long)

  /** Replaces every item from [index] on with [slots]. */
  fun replaceFrom(index: Int, slots: List<Slot>)

  /** Replaces the item at [index]: in place when the key is the same (new metadata only). */
  fun replaceAt(index: Int, slot: Slot)

  /** Removes the items before [index]; the current item keeps playing. */
  fun removeBefore(index: Int)

  fun seekTo(index: Int, positionMs: Long)

  /** Prepares the player again after an error. */
  fun prepare()

  fun setPlayWhenReady(playWhenReady: Boolean)

  fun setRepeatOne(repeatOne: Boolean)

  fun setVolume(volume: Float)

  /** Stops and empties the playlist. */
  fun clear()
}

/** Delivers [Event]s to the attached web app. */
fun interface JsLink {
  fun send(event: Event)
}

/**
 * Restarts the web app when the native player needs it and it is gone: after its WebView renderer
 * was killed, the activity is recreated, and its player attaches again ([WebViewRecovery]).
 * Returns whether a restart is possible (there is an activity to recreate).
 */
fun interface ResolverHost {
  fun restartResolver(): Boolean
}

/** The time, in epoch milliseconds. */
fun interface Clock {
  fun now(): Long
}

/** Runs tasks later on the coordinator's thread (the main thread in the app). */
fun interface Scheduler {
  fun schedule(delayMs: Long, task: () -> Unit): Cancelable
}

fun interface Cancelable {
  fun cancel()
}
