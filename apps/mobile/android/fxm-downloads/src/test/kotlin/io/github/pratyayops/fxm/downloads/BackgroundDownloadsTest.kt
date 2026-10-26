package io.github.pratyayops.fxm.downloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundDownloadsTest {
  /** The service as the controller drives it, recording what it does. */
  private class FakeService : DownloadServiceControl {
    val calls = mutableListOf<String>()
    var refuse = false
    var running = false
    var awake = false
    var notice: Notice? = null

    override fun start(notice: Notice): Boolean {
      calls += "start"
      if (refuse) return false
      running = true
      this.notice = notice
      return true
    }

    override fun update(notice: Notice) {
      this.notice = notice
    }

    override fun stop() {
      calls += "stop"
      running = false
    }

    override fun keepAwake(awake: Boolean) {
      this.awake = awake
    }
  }

  /** Timers on a fake clock. */
  private class FakeTimers : Timers {
    var now = 0L
    private val tasks = mutableListOf<Triple<Long, Int, () -> Unit>>()
    private var next = 0

    override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
      val entry = Triple(now + delayMs, next++, task)
      tasks += entry
      return { tasks.remove(entry) }
    }

    fun advance(ms: Long) {
      val until = now + ms
      while (true) {
        val due = tasks.filter { it.first <= until }.minWithOrNull(compareBy({ it.first }, { it.second })) ?: break
        tasks.remove(due)
        now = due.first
        due.third()
      }
      now = until
    }
  }

  private val service = FakeService()
  private val timers = FakeTimers()
  private var bytes = 0L
  private val background = BackgroundDownloads(service, timers, { bytes })

  private fun report(downloading: Int, queued: Int = 0, online: Boolean = true, title: String? = null) =
    background.report(QueueReport(downloading, queued, online, title))

  @Test
  fun `the service runs while the queue has work and stops a little after`() {
    assertFalse(report(0))
    assertEquals(emptyList<String>(), service.calls)
    assertTrue(report(1, 2, title = "Creep"))
    assertTrue(service.running && service.awake)
    assertEquals(Notice("Downloading “Creep”", "2 more waiting", true), service.notice)
    // The next download follows within moments: nothing stops in between.
    report(0)
    assertFalse(service.awake)
    timers.advance(2_000)
    assertTrue(report(1, 1))
    timers.advance(10_000)
    assertTrue(service.running)
    assertEquals(listOf("start"), service.calls)
    report(0)
    timers.advance(4_999)
    assertTrue(service.running)
    timers.advance(1)
    assertFalse(service.running)
    assertFalse(background.isRunning)
    assertEquals(listOf("start", "stop"), service.calls)
  }

  @Test
  fun `the device sleeps while downloads wait for a network`() {
    report(0, 3, online = false)
    assertTrue(service.running)
    assertFalse(service.awake)
    assertEquals(Notice("Downloads wait for a network", "3 songs waiting", false), service.notice)
    report(2, 1, online = true)
    assertTrue(service.awake)
    assertEquals(Notice("Downloading 2 songs", "1 more waiting", true), service.notice)
  }

  @Test
  fun `the notification shows the bytes written`() {
    bytes = 1_000_000
    report(1)
    assertNull(service.notice?.text)
    bytes = 13_350_000
    timers.advance(2_000)
    assertEquals("12.4 MB so far", service.notice?.text)
    assertEquals(Notice("Downloading a song", "12.4 MB so far", true), service.notice)
  }

  @Test
  fun `a refused start is tried again with the next report, or when the app is on screen`() {
    service.refuse = true
    assertFalse(report(1))
    service.refuse = false
    assertTrue(report(1))
    assertEquals(listOf("start", "start"), service.calls)
    background.serviceStopped(timedOut = false)
    service.refuse = true
    assertFalse(report(1))
    service.refuse = false
    background.appVisible()
    assertTrue(background.isRunning)
    assertEquals(listOf("start", "start", "start", "start"), service.calls)
    // On screen while it runs: nothing to start.
    background.appVisible()
    assertEquals(4, service.calls.size)
  }

  @Test
  fun `a page that went away has a minute for its successor to report`() {
    report(1)
    background.pageGone()
    timers.advance(59_000)
    assertTrue(service.running)
    // The new page runs the queue and reports.
    report(1)
    timers.advance(120_000)
    assertTrue(service.running)
    background.pageGone()
    timers.advance(60_000)
    assertFalse(service.running)
    // Gone while nothing ran: nothing to stop.
    background.pageGone()
    timers.advance(60_000)
    assertEquals(listOf("start", "stop"), service.calls)
  }

  @Test
  fun `after Android's time limit the service waits for the app to be on screen`() {
    report(1)
    background.serviceStopped(timedOut = true)
    assertFalse(background.isRunning)
    assertFalse(service.awake)
    assertFalse(report(1))
    assertEquals(listOf("start"), service.calls)
    background.appVisible()
    assertTrue(background.isRunning)
    assertEquals(listOf("start", "start"), service.calls)
  }

  @Test
  fun `a service Android stopped otherwise starts again with the next report`() {
    report(1)
    background.serviceStopped(timedOut = false)
    assertTrue(report(1))
    assertEquals(listOf("start", "start"), service.calls)
    // Nothing waits after a stop the controller didn't make.
    background.serviceStopped(timedOut = false)
    timers.advance(600_000)
    assertEquals(listOf("start", "start"), service.calls)
  }
}
