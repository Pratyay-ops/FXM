package io.github.pratyayops.fxm.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryTest {
  /** An activity hosting the web app. */
  private class Page {
    var alive = true
    var recreated = 0
  }

  private val clock = FakeClock()
  private val scheduler = FakeScheduler(clock)
  private val recovery =
    RendererRecovery<Page>(scheduler, clock, alive = { it.alive }, recreate = { it.recreated += 1 })

  /** A page that is registered, has died once in the background and was brought back. */
  private fun diedOnce(): Page {
    val page = Page()
    recovery.register(page)
    recovery.setVisible(page, false)
    recovery.onRendererGone(page)
    scheduler.runDue()
    assertEquals(1, page.recreated)
    return page
  }

  @Test
  fun `the first death brings the page back at once`() {
    val page = Page()
    recovery.register(page)
    recovery.onRendererGone(page)
    assertTrue(recovery.restartPending)
    scheduler.runDue()
    assertEquals(1, page.recreated)
    assertFalse(recovery.restartPending)
  }

  @Test
  fun `a page that dies again in the background waits, until the user opens the app`() {
    val page = diedOnce()
    clock.now += 60_000
    recovery.onRendererGone(page)
    scheduler.advance(29_000)
    assertEquals(1, page.recreated)
    // The user opens the app: a dead page is on screen, so it comes back now.
    recovery.setVisible(page, true)
    scheduler.runDue()
    assertEquals(2, page.recreated)
    // Not a second time when the old delay runs out.
    scheduler.advance(60_000)
    assertEquals(2, page.recreated)
  }

  @Test
  fun `without a restart waiting, coming on screen does nothing`() {
    val page = diedOnce()
    recovery.setVisible(page, true)
    scheduler.advance(10 * 60_000)
    assertEquals(1, page.recreated)
  }

  @Test
  fun `only the page hosting the web app counts as on screen`() {
    val page = diedOnce()
    clock.now += 60_000
    recovery.onRendererGone(page)
    recovery.setVisible(Page(), true)
    scheduler.advance(1_000)
    assertEquals(1, page.recreated)
    scheduler.advance(30_000)
    assertEquals(2, page.recreated)
  }

  @Test
  fun `a page that dies on screen comes back at once, however often it died`() {
    val page = diedOnce()
    recovery.setVisible(page, true)
    repeat(3) {
      clock.now += 1_000
      recovery.onRendererGone(page)
      scheduler.runDue()
    }
    assertEquals(4, page.recreated)
  }

  @Test
  fun `the native player can ask for the page at once`() {
    assertFalse(recovery.restartResolver())
    val page = diedOnce()
    clock.now += 60_000
    recovery.onRendererGone(page)
    assertTrue(recovery.restartResolver())
    scheduler.runDue()
    assertEquals(2, page.recreated)
    // Nothing is dead any more.
    assertFalse(recovery.restartResolver())
  }

  @Test
  fun `a page that is finishing is not recreated`() {
    val page = diedOnce()
    clock.now += 60_000
    recovery.onRendererGone(page)
    page.alive = false
    assertFalse(recovery.restartResolver())
    scheduler.advance(10 * 60_000)
    assertEquals(1, page.recreated)
  }
}
