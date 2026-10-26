package io.github.pratyayops.fxm.downloads

/** What the web app's download queue reports (`setBackground` in `@fxm/downloads`). */
data class QueueReport(
  /** Downloads being fetched now. */
  val downloading: Int,
  /** Downloads waiting their turn: for a slot, the network, or a wait a server asked for. */
  val queued: Int,
  /** Whether the device is online. */
  val online: Boolean,
  /** The title of a song being downloaded, for the notification. */
  val title: String? = null,
) {
  /** Whether the queue has work: the app must keep running for it. */
  val active: Boolean
    get() = downloading > 0 || queued > 0
}

/** What the progress notification says. */
data class Notice(val title: String, val text: String?, val downloading: Boolean)

/** The foreground service, as [BackgroundDownloads] drives it. */
interface DownloadServiceControl {
  /**
   * Starts the service in the foreground, showing [notice]. `false` when Android refused: from
   * Android 12 on, an app in the background may not start one. The service reports [generation]
   * back when it stops ([BackgroundDownloads.serviceStopped]).
   */
  fun start(notice: Notice, generation: Long): Boolean

  /** Shows [notice] in the running service's notification. */
  fun update(notice: Notice)

  /** Stops the service and removes its notification. */
  fun stop()

  /** Holds the partial wake lock and the Wi-Fi lock, or lets them go. */
  fun keepAwake(awake: Boolean)
}

/** Runs [task] after [delayMs] on the controller's thread; the result cancels it. */
fun interface Timers {
  fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
}

/**
 * Keeps the app running while the web app's download queue has work (stage 6.4). The queue
 * runs in the WebView's JavaScript, which Android freezes in a cached app, so a `dataSync`
 * foreground service with a progress notification keeps the process, and with it the page,
 * going while downloads run, also with the screen off ([DownloadServiceControl.keepAwake] holds
 * the wake and Wi-Fi locks while the device is online). The web app reports its queue on every
 * change ([report]); the service starts with the first download and stops a few seconds after
 * the last one.
 *
 * - **A page that goes away** (a reload, a renderer that died) stops reporting; its successor
 *   reports within moments once it runs the queue again. If none does within [Config.orphanMs],
 *   the service stops ([pageGone]).
 * - **Android's limit.** Android 15 stops `dataSync` services after 6 hours a day
 *   ([serviceStopped] with `timedOut`); the queue then runs while FXM is on screen, and the
 *   service starts again once the app has been on screen ([appVisible]), which resets the limit.
 *   A start Android refused (an app in the background) is tried again then too.
 * - **Each start counts** (its generation). A service the controller stopped may only hear of it
 *   (`onDestroy`) after the controller started it again for the next download: that end is old
 *   news, and the service runs on.
 *
 * Every method runs on one thread (the main thread in the app).
 */
class BackgroundDownloads(
  private val control: DownloadServiceControl,
  private val timers: Timers,
  /** Every byte the downloads wrote so far (`DownloadFiles.bytesWritten`). */
  private val bytesWritten: () -> Long,
  private val config: Config = Config(),
) {
  /** Timings. */
  data class Config(
    /** How long the queue may be idle before the service stops: the next download may follow. */
    val idleMs: Long = 5_000,
    /** How long the service waits for a new page to report after the old one went away. */
    val orphanMs: Long = 60_000,
    /** How often the notification shows the bytes written while downloads run. */
    val tickMs: Long = 2_000,
  )

  /** The page's last report, while that page lives. */
  private var last: QueueReport? = null
  private var running = false
  /** The latest start's number: only its end stops what runs. */
  private var generation = 0L
  /** Android stopped the service at its time limit: don't start it again from the background. */
  private var blocked = false
  private var bytesAtStart = 0L
  private var stopTimer: (() -> Unit)? = null
  private var orphanTimer: (() -> Unit)? = null
  private var ticker: (() -> Unit)? = null

  /** Whether the service runs. */
  val isRunning: Boolean
    get() = running

  /** The web app's queue now. Returns whether the service runs. */
  fun report(report: QueueReport): Boolean {
    last = report
    orphanTimer?.invoke()
    orphanTimer = null
    if (!report.active) {
      if (running && stopTimer == null) stopTimer = timers.schedule(config.idleMs) { stopNow() }
      control.keepAwake(false)
      if (running) control.update(notice(report))
      return running
    }
    stopTimer?.invoke()
    stopTimer = null
    if (!running) {
      if (blocked) return false
      bytesAtStart = bytesWritten()
      generation += 1
      running = control.start(notice(report), generation)
      if (!running) return false
      tick()
    } else {
      control.update(notice(report))
    }
    control.keepAwake(report.online)
    return true
  }

  /**
   * The page that reported went away: its report with it, so the app's return doesn't start the
   * service for a queue nobody runs. Stops unless the next page reports soon.
   */
  fun pageGone() {
    last = null
    if (!running || orphanTimer != null) return
    orphanTimer =
      timers.schedule(config.orphanMs) {
        orphanTimer = null
        stopNow()
      }
  }

  /**
   * Android stopped the service started as [generation]: at its time limit when [timedOut], or
   * otherwise. The end of an earlier start changes nothing for the one that runs now.
   */
  fun serviceStopped(timedOut: Boolean, generation: Long) {
    if (timedOut) blocked = true
    if (!running || generation != this.generation) return
    running = false
    clearTimers()
    control.keepAwake(false)
  }

  /**
   * The app is on screen: Android lets it start the service again, after its time limit or a
   * start it refused while the app was in the background.
   */
  fun appVisible() {
    blocked = false
    if (!running) last?.takeIf { it.active }?.let(::report)
  }

  /** What the notification says for [report]. */
  fun notice(report: QueueReport): Notice {
    val downloading = report.downloading
    val title =
      when {
        downloading == 1 && !report.title.isNullOrBlank() -> "Downloading “${report.title.trim()}”"
        downloading > 1 -> "Downloading $downloading songs"
        downloading == 1 -> "Downloading a song"
        !report.online -> "Downloads wait for a network"
        report.queued > 0 -> "Downloads waiting"
        else -> "Downloads finished"
      }
    val parts = mutableListOf<String>()
    if (report.queued > 0) parts += if (downloading > 0) "${report.queued} more waiting" else "${songs(report.queued)} waiting"
    val bytes = bytesWritten() - bytesAtStart
    if (bytes > 0) parts += "${megabytes(bytes)} so far"
    return Notice(title, parts.joinToString(" · ").ifEmpty { null }, downloading > 0)
  }

  private fun tick() {
    ticker?.invoke()
    ticker =
      timers.schedule(config.tickMs) {
        ticker = null
        if (!running) return@schedule
        last?.takeIf { it.downloading > 0 }?.let { control.update(notice(it)) }
        tick()
      }
  }

  private fun stopNow() {
    if (!running) return
    running = false
    clearTimers()
    control.keepAwake(false)
    control.stop()
  }

  private fun clearTimers() {
    for (cancel in listOfNotNull(stopTimer, orphanTimer, ticker)) cancel()
    stopTimer = null
    orphanTimer = null
    ticker = null
  }

  private companion object {
    fun songs(count: Int) = if (count == 1) "1 song" else "$count songs"

    /** `12.3 MB`, in decimal megabytes like Android's own storage figures. */
    fun megabytes(bytes: Long): String {
      val tenths = (bytes + 50_000) / 100_000
      return "${tenths / 10}.${tenths % 10} MB"
    }
  }
}
