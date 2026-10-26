package io.github.pratyayops.fxm.player

import kotlin.math.max

/**
 * The native player's logic, between the web app (through the FxmPlayer plugin), Media3 (through
 * a [PlayerPort]) and the system's media controls. Every method runs on one thread: the main
 * thread in the app.
 *
 * The web app owns the queue and resolves every stream. It loads the current entry and keeps a
 * deeper queue of resolved [upcoming][setUpcoming] entries here, so the native player crosses
 * track boundaries by itself, gapless and without waiting for JavaScript, which may be slow in
 * the background or gone (its WebView renderer killed). While the web app is attached, it
 * decides: failures, the system's next and previous buttons and fresh URLs go to it as [Event]s.
 * When it does not answer in time, or is not attached, the native player carries on alone: it
 * skips a failed entry, plays what it has queued and, when that runs out, asks the
 * [ResolverHost] to bring the web app back.
 */
class Coordinator(
  private val port: PlayerPort,
  private val table: SourceTable,
  private val host: ResolverHost,
  private val clock: Clock,
  private val scheduler: Scheduler,
  private val config: Config = Config(),
) {
  /** Timeouts and limits. */
  data class Config(
    /** How long the web app may take to act on a failure before the native player skips. */
    val errorTimeoutMs: Long = 30_000,
    /** How long the web app may take to acknowledge a system control's next or previous. */
    val commandTimeoutMs: Long = 8_000,
    /** Failed entries in a row after which the native player stops on its own. */
    val maxFailures: Int = 4,
    /** Ask for a fresh URL this long before an upcoming entry's URL expires (when it would
     * start), as the web app's stream lifecycle does. */
    val refreshMarginMs: Long = 10 * 60_000,
  )

  private val slots = mutableListOf<Slot>()
  private var nextKey = 1L
  private var link: JsLink? = null
  private var hasMore = false
  private var repeat = Repeat.OFF
  private var network = 0
  private var cellular = false
  private var snapshot: String? = null
  private var failures = 0
  private var error: Failure? = null
  private var errorFallback: Cancelable? = null
  private var commandFallback: Cancelable? = null
  private var pendingCommand: SystemCommand? = null
  /** The URL each upcoming entry had when a fresh one was requested, so it is asked once. */
  private val requested = mutableMapOf<String, String>()
  private var stateQueued = false

  /** Called when what the system controls may do changes (see [canSkipForward]). */
  var onControlsChanged: () -> Unit = {}

  /** Whether the web app is attached. */
  val attached: Boolean
    get() = link != null

  /** Whether "next" can do anything: an entry is queued, or the web app has (or decides) more. */
  val canSkipForward: Boolean
    get() = port.currentIndex >= 0 && (port.currentIndex + 1 < slots.size || hasMore || link != null)

  /** Whether there is an entry to restart or go back from. */
  val canSkipBack: Boolean
    get() = port.currentIndex >= 0

  /** The entries in the playlist, current first (played ones are dropped). */
  val entries: List<Entry>
    get() = slots.drop(max(0, port.currentIndex)).map { it.entry }

  // --- The web app ---------------------------------------------------------------------------

  /** Attaches the web app; from now on it gets the [Event]s. Returns where playback is. */
  fun attach(link: JsLink): Session {
    this.link = link
    requested.clear()
    onControlsChanged()
    checkFreshness()
    return session()
  }

  /**
   * Detaches [link] (the WebView went away or its renderer died). What waited for it happens
   * natively now.
   */
  fun detach(link: JsLink) {
    if (this.link !== link) return
    this.link = null
    onControlsChanged()
    val command = pendingCommand
    commandFallback?.cancel()
    commandFallback = null
    pendingCommand = null
    when (command) {
      SystemCommand.NEXT -> skipForward()
      SystemCommand.PREVIOUS -> restartCurrent()
      null -> {}
    }
    if (errorFallback != null) {
      errorFallback?.cancel()
      errorFallback = null
      currentSlot()?.let { recoverNatively(it.entry.id) }
    } else if (port.state == PlaybackState.ENDED && hasMore) {
      host.restartResolver()
    }
  }

  /**
   * Plays [entry] from [startAtMs], paused until [play], with [upcoming] queued after it. An
   * entry that is already queued with the same bytes is skipped to, keeping what is buffered.
   */
  fun load(entry: Entry, startAtMs: Long, upcoming: List<Entry>, hasMore: Boolean, repeat: Repeat) {
    webAppActed()
    failures = 0
    error = null
    val start = max(0L, startAtMs)
    val current = port.currentIndex
    val queuedAt = slots.indexOfFirst { it.entry.id == entry.id }
    if (current >= 0 &&
      queuedAt > current &&
      StreamIdentity.sameBytes(slots[queuedAt].entry.source, entry.source)
    ) {
      val slot = slots[queuedAt].copy(entry = entry, network = networkOf(entry.source))
      slots[queuedAt] = slot
      table.put(slot.key, entry.source)
      port.setPlayWhenReady(false)
      port.seekTo(queuedAt, start)
      prune(queuedAt)
      replaceUpcoming(upcoming)
    } else {
      val fresh = (listOf(entry) + upcoming).map(::newSlot)
      slots.clear()
      slots.addAll(fresh)
      table.retain(fresh.map { it.key }.toSet())
      port.setPlayWhenReady(false)
      port.setSlots(fresh, 0, start)
    }
    this.hasMore = hasMore
    setRepeat(repeat)
    requested.keys.retainAll(slots.map { it.entry.id }.toSet())
    onControlsChanged()
    checkFreshness()
    queueState()
  }

  /**
   * Replaces the entries queued after the current one. The unchanged leading entries (the same
   * ids and bytes, in the same order) keep their slot and buffer, and a fresh URL for them is used
   * from their next request; everything after the first change gets new slots.
   */
  fun setUpcoming(upcoming: List<Entry>, hasMore: Boolean, repeat: Repeat) {
    this.hasMore = hasMore
    setRepeat(repeat)
    if (port.currentIndex >= 0) replaceUpcoming(upcoming)
    requested.keys.retainAll(slots.map { it.entry.id }.toSet())
    onControlsChanged()
    checkFreshness()
  }

  fun play() {
    webAppActed()
    if (port.state == PlaybackState.IDLE && port.currentIndex >= 0) port.prepare()
    port.setPlayWhenReady(true)
    queueState()
  }

  fun pause() {
    webAppActed()
    port.setPlayWhenReady(false)
    queueState()
  }

  fun seek(positionMs: Long) {
    webAppActed()
    val index = port.currentIndex
    if (index >= 0) port.seekTo(index, max(0L, positionMs))
    queueState()
  }

  fun setVolume(volume: Float) {
    port.setVolume(volume.coerceIn(0f, 1f))
  }

  /** The web app took over a system control's next or previous. */
  fun acknowledge() {
    commandFallback?.cancel()
    commandFallback = null
    pendingCommand = null
  }

  /** Keeps the web app's own state for when it attaches again, e.g. after its renderer died. */
  fun saveSnapshot(data: String?) {
    snapshot = data
  }

  /** Stops playback and forgets everything. */
  fun release() {
    errorFallback?.cancel()
    errorFallback = null
    acknowledge()
    slots.clear()
    table.clear()
    port.clear()
    hasMore = false
    snapshot = null
    error = null
    failures = 0
    requested.clear()
    onControlsChanged()
    queueState()
  }

  // --- Media3 ----------------------------------------------------------------------------------

  /** Media3 moved to another playlist item by itself: the previous one ended, or repeats. */
  fun onAutoTransition(repeated: Boolean) {
    val index = port.currentIndex
    val slot = slots.getOrNull(index) ?: return
    failures = 0
    error = null
    if (repeated) {
      send(Event.Transition(slot.entry.id, slot.entry.id, TransitionReason.REPEAT))
    } else {
      val from = slots.getOrNull(index - 1)?.entry?.id
      prune(index)
      send(Event.Transition(from, slot.entry.id, TransitionReason.AUTO))
      checkFreshness()
      onControlsChanged()
    }
    queueState()
  }

  /** Media3's playback state or `isPlaying` changed. */
  fun onStateChanged() {
    if (port.state == PlaybackState.ENDED && link == null && hasMore) host.restartResolver()
    queueState()
  }

  /** The current entry failed. */
  fun onError(failure: Failure) {
    val slot = currentSlot() ?: return
    val expiresAt = slot.entry.source.expiresAt
    val reported =
      if (failure.type == FailureType.NETWORK && expiresAt != null && clock.now() >= expiresAt) {
        failure.copy(type = FailureType.EXPIRED)
      } else {
        failure
      }
    error = reported
    val link = link
    if (link == null) {
      recoverNatively(slot.entry.id)
    } else {
      link.send(Event.Error(slot.entry.id, reported))
      errorFallback?.cancel()
      errorFallback =
        scheduler.schedule(config.errorTimeoutMs) {
          errorFallback = null
          recoverNatively(slot.entry.id)
        }
    }
    queueState()
  }

  /** Periodic housekeeping while playing: the state, and URLs that will expire. */
  fun tick() {
    checkFreshness()
    queueState()
  }

  // --- System controls and the device --------------------------------------------------------

  /** The notification, lock screen, a headset or Bluetooth asked for the next entry. */
  fun onSystemNext() = systemCommand(SystemCommand.NEXT)

  /** The notification, lock screen, a headset or Bluetooth asked for the previous entry. */
  fun onSystemPrevious() = systemCommand(SystemCommand.PREVIOUS)

  /** The device moved to another network: IP-bound URLs resolved before may now fail. */
  fun onNetworkChanged(cellular: Boolean) {
    network += 1
    this.cellular = cellular
    send(Event.Network(network, cellular))
    checkFreshness()
  }

  /**
   * Whether the device is on mobile data now. Android reports it just after the new network, so
   * the web app hears it with the same network id: its quality ceiling changes, its URLs stay.
   */
  fun onCellularChanged(cellular: Boolean) {
    if (this.cellular == cellular) return
    this.cellular = cellular
    send(Event.Network(network, cellular))
  }

  /** The current state, as sent with [Event.State]. */
  fun state(): NativeState =
    NativeState(
      id = currentSlot()?.entry?.id,
      positionMs = max(0L, port.positionMs),
      durationMs = if (port.durationMs > 0) port.durationMs else -1,
      playing = port.isPlaying,
      playWhenReady = port.playWhenReady,
      state = port.state,
    )

  fun session(): Session = Session(entries, state(), error, snapshot, network, cellular)

  // --- Internals -------------------------------------------------------------------------------

  private fun currentSlot(): Slot? = slots.getOrNull(port.currentIndex)

  private fun networkOf(source: Source): Int = source.network ?: network

  private fun newSlot(entry: Entry): Slot {
    val slot = Slot(entry, nextKey++, networkOf(entry.source))
    table.put(slot.key, entry.source)
    return slot
  }

  private fun send(event: Event) {
    link?.send(event)
  }

  private fun queueState() {
    if (stateQueued) return
    stateQueued = true
    scheduler.schedule(0) {
      stateQueued = false
      send(Event.State(state()))
    }
  }

  private fun setRepeat(repeat: Repeat) {
    if (this.repeat == repeat) return
    this.repeat = repeat
    port.setRepeatOne(repeat == Repeat.ONE)
  }

  /** The web app acted (loaded, played, paused or sought): nothing waits for it any more. */
  private fun webAppActed() {
    errorFallback?.cancel()
    errorFallback = null
    acknowledge()
  }

  private fun replaceUpcoming(upcoming: List<Entry>) {
    val current = port.currentIndex
    val old = slots.subList(current + 1, slots.size).toList()
    var same = 0
    while (same < old.size &&
      same < upcoming.size &&
      old[same].entry.id == upcoming[same].id &&
      StreamIdentity.sameBytes(old[same].entry.source, upcoming[same].source)
    ) {
      val slot = old[same].copy(entry = upcoming[same], network = networkOf(upcoming[same].source))
      slots[current + 1 + same] = slot
      table.put(slot.key, slot.entry.source)
      if (slot.entry.metadata != old[same].entry.metadata) port.replaceAt(current + 1 + same, slot)
      same += 1
    }
    if (same == old.size && same == upcoming.size) return
    val fresh = upcoming.drop(same).map(::newSlot)
    while (slots.size > current + 1 + same) slots.removeAt(slots.size - 1)
    slots.addAll(fresh)
    port.replaceFrom(current + 1 + same, fresh)
    table.retain(slots.map { it.key }.toSet())
  }

  /** Drops the slots before [index], which have played. */
  private fun prune(index: Int) {
    if (index <= 0) return
    port.removeBefore(index)
    repeat(index) { slots.removeAt(0) }
    table.retain(slots.map { it.key }.toSet())
  }

  private fun systemCommand(command: SystemCommand) {
    val link = link
    if (link == null) {
      runNatively(command)
      return
    }
    link.send(Event.Command(command))
    commandFallback?.cancel()
    pendingCommand = command
    commandFallback =
      scheduler.schedule(config.commandTimeoutMs) {
        commandFallback = null
        pendingCommand = null
        runNatively(command)
      }
  }

  private fun runNatively(command: SystemCommand) {
    when (command) {
      SystemCommand.NEXT -> skipForward()
      SystemCommand.PREVIOUS -> restartCurrent()
    }
  }

  /** Moves to the next queued entry, or asks for the web app when only it has more. */
  private fun skipForward(): Boolean {
    val index = port.currentIndex
    if (index < 0) return false
    if (index + 1 >= slots.size) {
      if (hasMore && link == null) host.restartResolver()
      return false
    }
    val from = slots[index].entry.id
    error = null
    port.seekTo(index + 1, 0)
    if (port.state == PlaybackState.IDLE) port.prepare()
    prune(index + 1)
    send(Event.Transition(from, slots[0].entry.id, TransitionReason.SKIP))
    checkFreshness()
    onControlsChanged()
    queueState()
    return true
  }

  private fun restartCurrent() {
    val index = port.currentIndex
    if (index < 0) return
    port.seekTo(index, 0)
    if (port.state == PlaybackState.IDLE) port.prepare()
    queueState()
  }

  /** The web app did not act on the failure of entry [failedId]: skip it, or stop. */
  private fun recoverNatively(failedId: String) {
    if (currentSlot()?.entry?.id != failedId || error == null) return
    failures += 1
    if (failures >= config.maxFailures) {
      port.setPlayWhenReady(false)
      queueState()
      return
    }
    if (!skipForward()) {
      if (!hasMore) port.setPlayWhenReady(false)
      queueState()
    }
  }

  /**
   * Asks the web app for a fresh source for the next entry when its URL is bound to an earlier
   * network or expires before it would finish. Each URL is asked about once.
   */
  private fun checkFreshness() {
    if (link == null) return
    val index = port.currentIndex
    if (index < 0) return
    val next = slots.getOrNull(index + 1) ?: return
    val source = next.entry.source
    val stale = source.ipBound && next.network < network
    val remainingMs = if (port.durationMs > 0) max(0L, port.durationMs - port.positionMs) else 0L
    val expiresAt = source.expiresAt
    val expiring = expiresAt != null && expiresAt - clock.now() < remainingMs + config.refreshMarginMs
    if (!stale && !expiring) return
    if (requested[next.entry.id] == source.url) return
    requested[next.entry.id] = source.url
    send(Event.Request(next.entry.id, if (stale) RequestReason.NETWORK else RequestReason.EXPIRING))
  }
}
