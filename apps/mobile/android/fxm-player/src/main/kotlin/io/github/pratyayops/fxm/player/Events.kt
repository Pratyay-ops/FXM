package io.github.pratyayops.fxm.player

/** Media3's playback states, with the names the bridge uses. */
enum class PlaybackState(val wire: String) {
  IDLE("idle"),
  BUFFERING("buffering"),
  READY("ready"),
  ENDED("ended"),
}

/** What the native player is doing, as the web app sees it. */
data class NativeState(
  /** The current entry's id, or `null` when the playlist is empty. */
  val id: String?,
  val positionMs: Long,
  /** The current entry's duration, or -1 while unknown. */
  val durationMs: Long,
  /** Whether audio is coming out. */
  val playing: Boolean,
  /** Whether it plays as soon as it can (Media3's `playWhenReady`). */
  val playWhenReady: Boolean,
  val state: PlaybackState,
)

/** The kinds of playback failure, as the web app's `EngineError` names them. */
enum class FailureType(val wire: String) {
  NETWORK("network"),
  DECODE("decode"),
  UNSUPPORTED("unsupported"),
  EXPIRED("expired"),
}

/** Why playback of an entry failed. [status] is the HTTP status, where there was one. */
data class Failure(val type: FailureType, val status: Int?, val message: String)

/** Why the native player moved to another entry by itself. */
enum class TransitionReason(val wire: String) {
  /** The previous entry played to its end. */
  AUTO("auto"),

  /** The entry ended and plays again (repeat one). */
  REPEAT("repeat"),

  /** The native player skipped: an entry failed or a system control asked for the next one
   * while the web app did not answer. */
  SKIP("skip"),
}

/** Why the native player asks for a fresh source for an upcoming entry. */
enum class RequestReason(val wire: String) {
  /** Its URL expires before it would finish playing. */
  EXPIRING("expiring"),

  /** It is bound to an IP address and was resolved on an earlier network. */
  NETWORK("network"),
}

/** A media control the web app decides about, because it owns the queue. */
enum class SystemCommand(val wire: String) {
  NEXT("next"),
  PREVIOUS("previous"),
}

/** What the native player tells the web app. */
sealed interface Event {
  /** The playback state; sent on every change and about once a second while playing. */
  data class State(val state: NativeState) : Event

  /** The native player moved from entry [from] to [to] by itself. */
  data class Transition(val from: String?, val to: String?, val reason: TransitionReason) : Event

  /** Entry [id] failed to play. */
  data class Error(val id: String?, val failure: Failure) : Event

  /** Upcoming entry [id] needs a fresh source. */
  data class Request(val id: String, val reason: RequestReason) : Event

  /** A system control (notification, lock screen, headset, Bluetooth) asked for [command]. */
  data class Command(val command: SystemCommand) : Event

  /** The device changed network; [id] counts the changes. */
  data class Network(val id: Int, val cellular: Boolean) : Event
}

/**
 * The native player's whole state, for a web app that attaches: after the WebView renderer was
 * killed and recreated, it continues from here.
 */
data class Session(
  /** The current entry and the ones queued after it. */
  val entries: List<Entry>,
  val state: NativeState,
  /** How the current entry failed, while nothing has replaced it. */
  val error: Failure?,
  /** The web app's own state it asked the native player to keep ([Coordinator.saveSnapshot]). */
  val snapshot: String?,
  val network: Int,
  val cellular: Boolean,
)
