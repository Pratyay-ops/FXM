package io.github.pratyayops.fxm.player

/** A clock the test moves. */
class FakeClock(var now: Long = 1_800_000_000_000L) : Clock {
  override fun now(): Long = now
}

/** A [Scheduler] whose tasks run only when the test moves time on, in time order. */
class FakeScheduler(private val clock: FakeClock) : Scheduler {
  private class Task(val at: Long, val order: Int, val run: () -> Unit) {
    var cancelled = false
  }

  private val tasks = mutableListOf<Task>()
  private var count = 0

  override fun schedule(delayMs: Long, task: () -> Unit): Cancelable {
    val scheduled = Task(clock.now + delayMs, count++, task)
    tasks += scheduled
    return Cancelable { scheduled.cancelled = true }
  }

  /** Runs every task due by now, including ones they schedule for now. */
  fun runDue() = advance(0)

  /** Moves time on by [ms], running each task when its time comes. */
  fun advance(ms: Long) {
    val target = clock.now + ms
    while (true) {
      tasks.removeAll { it.cancelled }
      val next = tasks.filter { it.at <= target }.minWithOrNull(compareBy({ it.at }, { it.order })) ?: break
      tasks.remove(next)
      clock.now = maxOf(clock.now, next.at)
      next.run()
    }
    clock.now = target
  }
}

/** A [ResolverHost] that counts the restarts asked for. */
class FakeHost(var possible: Boolean = true) : ResolverHost {
  var restarts = 0

  override fun restartResolver(): Boolean {
    restarts += 1
    return possible
  }
}

/** A [JsLink] that records what the web app would receive. */
class RecordingLink : JsLink {
  val events = mutableListOf<Event>()

  override fun send(event: Event) {
    events += event
  }

  /** Everything but the state updates. */
  val notices: List<Event>
    get() = events.filter { it !is Event.State }

  val states: List<NativeState>
    get() = events.filterIsInstance<Event.State>().map { it.state }
}

/**
 * Media3's player as far as the coordinator sees it: a playlist of slots, a current index and a
 * position, with a log of every operation.
 */
class FakePort : PlayerPort {
  val items = mutableListOf<Slot>()
  val ops = mutableListOf<String>()
  var index = -1
  var position = 0L
  var duration = -1L
  var looping = false
  var level = 1f
  var wantsPlay = false
  override var state = PlaybackState.IDLE

  override val playWhenReady: Boolean
    get() = wantsPlay

  override val currentIndex: Int
    get() = if (items.isEmpty()) -1 else index

  override val positionMs: Long
    get() = position

  override val durationMs: Long
    get() = duration

  override val isPlaying: Boolean
    get() = wantsPlay && state == PlaybackState.READY

  override fun setSlots(slots: List<Slot>, index: Int, positionMs: Long) {
    items.clear()
    items.addAll(slots)
    this.index = index
    position = positionMs
    state = PlaybackState.BUFFERING
    ops += "set ${ids(slots)} @$index $positionMs"
  }

  override fun replaceFrom(index: Int, slots: List<Slot>) {
    while (items.size > index) items.removeAt(items.size - 1)
    items.addAll(slots)
    ops += "replaceFrom $index ${ids(slots)}"
  }

  override fun replaceAt(index: Int, slot: Slot) {
    items[index] = slot
    ops += "replaceAt $index ${slot.entry.id}"
  }

  override fun removeBefore(index: Int) {
    repeat(index) { items.removeAt(0) }
    this.index -= index
    ops += "removeBefore $index"
  }

  override fun seekTo(index: Int, positionMs: Long) {
    this.index = index
    position = positionMs
    if (state == PlaybackState.ENDED) state = PlaybackState.BUFFERING
    ops += "seek $index $positionMs"
  }

  override fun prepare() {
    if (state == PlaybackState.IDLE) state = PlaybackState.BUFFERING
    ops += "prepare"
  }

  override fun setPlayWhenReady(playWhenReady: Boolean) {
    wantsPlay = playWhenReady
    ops += if (playWhenReady) "play" else "pause"
  }

  override fun setRepeatOne(repeatOne: Boolean) {
    looping = repeatOne
    ops += "repeatOne $repeatOne"
  }

  override fun setVolume(volume: Float) {
    level = volume
  }

  var appliedEqualizer = EqualizerSettings()
  var appliedSpeed = 1f
  var pauseAtEnd = false

  override fun setEqualizer(settings: EqualizerSettings) {
    appliedEqualizer = settings
  }

  override fun setSpeed(speed: Float) {
    appliedSpeed = speed
  }

  override fun setPauseAtEndOfMediaItems(pause: Boolean) {
    pauseAtEnd = pause
    ops += "pauseAtEnd $pause"
  }

  override fun clear() {
    items.clear()
    index = -1
    state = PlaybackState.IDLE
    ops += "clear"
  }

  /** The current entry played to its end and Media3 moved on to the next. */
  fun advance(coordinator: Coordinator) {
    index += 1
    position = 0
    coordinator.onAutoTransition(repeated = false)
  }

  /** The current entry failed. */
  fun fail(coordinator: Coordinator, failure: Failure) {
    state = PlaybackState.IDLE
    coordinator.onError(failure)
  }

  val ids: List<String>
    get() = items.map { it.entry.id }

  private fun ids(slots: List<Slot>) = slots.joinToString(",") { it.entry.id }
}

/** A googlevideo-style URL: [itag] and [lmt] name the file, [sig] varies between resolutions. */
fun streamUrl(itag: Int = 251, lmt: String = "1700000000000000", sig: Int = 1, clen: Int? = 4000000): String =
  "https://rr1---sn-fxmtest.googlevideo.com/videoplayback?itag=$itag&lmt=$lmt" +
    (clen?.let { "&clen=$it" } ?: "") +
    "&sig=$sig"

/** The file key the web app sends for a [streamUrl] (`streamFileKey` in @fxm/player). */
fun fileKeyOf(url: String): String? =
  Regex("itag=(\\d+)&lmt=(\\d+)(?:&clen=(\\d+))?").find(url)?.let {
    "googlevideo:${it.groupValues[1]}:${it.groupValues[2]}:${it.groupValues[3]}:"
  }

fun testEntry(
  id: String,
  url: String = streamUrl(),
  expiresAt: Long? = null,
  ipBound: Boolean = true,
  network: Int? = null,
  title: String = id,
  fileKey: String? = fileKeyOf(url),
  loudness: Loudness? = null,
): Entry =
  Entry(
    id = id,
    uid = id.fold(0L) { acc, char -> acc * 31 + char.code } and 0xffffL,
    source = Source(url, emptyMap(), expiresAt, ipBound, network, fileKey, loudness),
    metadata = Metadata(title, listOf("$id artist")),
  )
