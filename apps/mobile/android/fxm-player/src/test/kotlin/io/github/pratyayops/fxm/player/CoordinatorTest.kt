package io.github.pratyayops.fxm.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CoordinatorTest {
  private val clock = FakeClock()
  private val scheduler = FakeScheduler(clock)
  private val port = FakePort()
  private val table = SourceTable()
  private val host = FakeHost()
  private val coordinator = Coordinator(port, table, host, clock, scheduler)
  private val link = RecordingLink()

  private val forbidden = Failure(FailureType.NETWORK, 403, "ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 403)")

  private fun start(vararg upcoming: Entry, hasMore: Boolean = false, attach: Boolean = true) {
    if (attach) coordinator.attach(link)
    coordinator.load(testEntry("a"), 0, upcoming.toList(), hasMore, Repeat.OFF)
    coordinator.play()
    scheduler.runDue()
    link.events.clear()
    port.ops.clear()
  }

  // --- Loading and the queue -------------------------------------------------------------------

  @Test
  fun `load prepares the entry with the upcoming ones queued, paused until play`() {
    coordinator.load(testEntry("a"), 5_000, listOf(testEntry("b"), testEntry("c")), true, Repeat.OFF)
    assertEquals(listOf("pause", "set a,b,c @0 5000"), port.ops)
    assertFalse(port.playWhenReady)
    for (slot in port.items) assertEquals(slot.entry.source.url, table.requestFor(slot.key).url)
    coordinator.play()
    assertTrue(port.playWhenReady)
  }

  @Test
  fun `loading the queued next entry skips to it and keeps its buffer`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b"), testEntry("c")), true, Repeat.OFF)
    port.ops.clear()
    val fresh = streamUrl(sig = 2)
    coordinator.load(testEntry("b", url = fresh), 0, listOf(testEntry("c"), testEntry("d")), true, Repeat.OFF)
    assertEquals(listOf("pause", "seek 1 0", "removeBefore 1", "replaceFrom 2 d"), port.ops)
    assertEquals(listOf("b", "c", "d"), port.ids)
    // Same file, fresh URL: the next request for it uses the new one.
    assertEquals(fresh, table.requestFor(port.items[0].key).url)
  }

  @Test
  fun `loading the current entry again prepares it afresh at the position`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b")), false, Repeat.OFF)
    port.ops.clear()
    coordinator.load(testEntry("a", url = streamUrl(sig = 2)), 12_000, listOf(testEntry("b")), false, Repeat.OFF)
    assertEquals(listOf("pause", "set a,b @0 12000"), port.ops)
  }

  @Test
  fun `upcoming entries that stay keep their place and the rest is replaced`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b"), testEntry("c"), testEntry("d")), true, Repeat.OFF)
    val dropped = port.items.map { it.key }
    port.ops.clear()
    val fresh = streamUrl(sig = 2)
    coordinator.setUpcoming(listOf(testEntry("b", url = fresh), testEntry("x"), testEntry("d")), true, Repeat.OFF)
    assertEquals(listOf("replaceFrom 2 x,d"), port.ops)
    assertEquals(listOf("a", "b", "x", "d"), port.ids)
    assertEquals(fresh, table.requestFor(port.items[1].key).url)
    // c's slot, and d's old one, are gone from the table.
    assertNull(table[dropped[2]])
    assertNull(table[dropped[3]])
  }

  @Test
  fun `another file for an upcoming entry replaces it, so Media3 prepares it again`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b")), false, Repeat.OFF)
    val old = port.items[1].key
    port.ops.clear()
    coordinator.setUpcoming(listOf(testEntry("b", url = streamUrl(itag = 18, clen = null))), false, Repeat.OFF)
    assertEquals(listOf("replaceFrom 1 b"), port.ops)
    assertNotEquals(old, port.items[1].key)
    assertNull(table[old])
  }

  @Test
  fun `new metadata updates a queued entry in place`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b")), false, Repeat.OFF)
    val key = port.items[1].key
    port.ops.clear()
    coordinator.setUpcoming(listOf(testEntry("b", title = "b (Remastered)")), false, Repeat.OFF)
    assertEquals(listOf("replaceAt 1 b"), port.ops)
    assertEquals(key, port.items[1].key)
    assertEquals("b (Remastered)", port.items[1].entry.metadata.title)
  }

  @Test
  fun `the same upcoming entries change nothing`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b"), testEntry("c")), false, Repeat.OFF)
    port.ops.clear()
    coordinator.setUpcoming(listOf(testEntry("b"), testEntry("c")), false, Repeat.OFF)
    assertEquals(emptyList<String>(), port.ops)
  }

  // --- Track boundaries ------------------------------------------------------------------------

  @Test
  fun `the next entry starts by itself, and the web app hears of it`() {
    start(testEntry("b"), testEntry("c"))
    val played = port.items[0].key
    port.advance(coordinator)
    assertEquals(listOf(Event.Transition("a", "b", TransitionReason.AUTO)), link.notices)
    assertEquals(listOf("removeBefore 1"), port.ops)
    assertEquals(listOf("b", "c"), port.ids)
    assertNull(table[played])
    assertTrue(port.playWhenReady)
  }

  @Test
  fun `repeat one loops the entry natively and reports each round`() {
    coordinator.attach(link)
    coordinator.load(testEntry("a"), 0, emptyList(), false, Repeat.ONE)
    assertTrue(port.looping)
    coordinator.onAutoTransition(repeated = true)
    assertEquals(listOf(Event.Transition("a", "a", TransitionReason.REPEAT)), link.notices)
    assertEquals(listOf("a"), port.ids)
    coordinator.setUpcoming(emptyList(), false, Repeat.OFF)
    assertFalse(port.looping)
  }

  @Test
  fun `the web app hears when the playlist ran out, and nothing restarts it`() {
    start(hasMore = true)
    port.state = PlaybackState.ENDED
    coordinator.onStateChanged()
    scheduler.runDue()
    assertEquals(PlaybackState.ENDED, link.states.last().state)
    assertEquals(0, host.restarts)
  }

  @Test
  fun `without the web app, a playlist that ran out brings it back when it has more`() {
    start(hasMore = true, attach = false)
    port.state = PlaybackState.ENDED
    coordinator.onStateChanged()
    assertEquals(1, host.restarts)
    coordinator.setUpcoming(emptyList(), false, Repeat.OFF)
    coordinator.onStateChanged()
    assertEquals(1, host.restarts)
  }

  // --- Failures ----------------------------------------------------------------------------------

  @Test
  fun `a failure goes to the web app, which retries`() {
    start(testEntry("b"))
    port.fail(coordinator, forbidden)
    assertEquals(listOf(Event.Error("a", forbidden)), link.notices)
    coordinator.load(testEntry("a", url = streamUrl(sig = 2)), 12_000, listOf(testEntry("b")), false, Repeat.OFF)
    scheduler.advance(60_000)
    assertEquals(listOf("pause", "set a,b @0 12000"), port.ops)
  }

  @Test
  fun `a failure the web app does not act on is skipped natively`() {
    start(testEntry("b"))
    port.fail(coordinator, forbidden)
    scheduler.advance(29_999)
    assertFalse("seek 1 0" in port.ops)
    scheduler.advance(1)
    assertEquals(listOf("seek 1 0", "prepare", "removeBefore 1"), port.ops)
    assertEquals(Event.Transition("a", "b", TransitionReason.SKIP), link.notices.last())
  }

  @Test
  fun `a failure after the URL expired is reported as expired`() {
    coordinator.attach(link)
    coordinator.load(testEntry("a", expiresAt = clock.now - 1), 0, emptyList(), false, Repeat.OFF)
    port.fail(coordinator, forbidden)
    assertEquals(
      Event.Error("a", Failure(FailureType.EXPIRED, 403, forbidden.message)),
      link.notices.single(),
    )
  }

  @Test
  fun `without the web app a failure is skipped at once, and four in a row stop`() {
    start(testEntry("b"), testEntry("c"), testEntry("d"), testEntry("e"), attach = false)
    repeat(3) { port.fail(coordinator, forbidden) }
    assertEquals(listOf("d", "e"), port.ids)
    assertTrue(port.playWhenReady)
    port.fail(coordinator, forbidden)
    assertEquals(listOf("d", "e"), port.ids)
    assertFalse(port.playWhenReady)
  }

  @Test
  fun `a web app that goes away hands over the failure it was deciding about`() {
    start(testEntry("b"))
    port.fail(coordinator, forbidden)
    coordinator.detach(link)
    assertEquals(listOf("seek 1 0", "prepare", "removeBefore 1"), port.ops)
    assertEquals(listOf("b"), port.ids)
  }

  @Test
  fun `only the attached web app is detached`() {
    start(testEntry("b"))
    coordinator.detach(RecordingLink())
    assertTrue(coordinator.attached)
  }

  // --- System controls ---------------------------------------------------------------------------

  @Test
  fun `next and previous from the system go to the web app`() {
    start(testEntry("b"))
    coordinator.onSystemNext()
    coordinator.acknowledge()
    coordinator.onSystemPrevious()
    coordinator.acknowledge()
    scheduler.advance(60_000)
    assertEquals(
      listOf(Event.Command(SystemCommand.NEXT), Event.Command(SystemCommand.PREVIOUS)),
      link.notices,
    )
    assertEquals(emptyList<String>(), port.ops)
  }

  @Test
  fun `a system next the web app does not take up runs natively`() {
    start(testEntry("b"))
    coordinator.onSystemNext()
    scheduler.advance(7_999)
    assertEquals(emptyList<String>(), port.ops)
    scheduler.advance(1)
    assertEquals(listOf("seek 1 0", "removeBefore 1"), port.ops)
    assertEquals(Event.Transition("a", "b", TransitionReason.SKIP), link.notices.last())
  }

  @Test
  fun `the web app acting on its own counts as taking up a system control`() {
    start(testEntry("b"))
    coordinator.onSystemNext()
    coordinator.pause()
    scheduler.advance(60_000)
    assertEquals(listOf("pause"), port.ops)
  }

  @Test
  fun `without the web app, next skips and previous restarts natively`() {
    start(testEntry("b"), attach = false)
    port.position = 30_000
    coordinator.onSystemNext()
    coordinator.onSystemPrevious()
    assertEquals(listOf("seek 1 0", "removeBefore 1", "seek 0 0"), port.ops)
    coordinator.onSystemNext()
    assertEquals(0, host.restarts)
  }

  @Test
  fun `next is offered while an entry is queued or the web app may have more`() {
    assertFalse(coordinator.canSkipForward)
    assertFalse(coordinator.canSkipBack)
    coordinator.load(testEntry("a"), 0, emptyList(), false, Repeat.OFF)
    assertFalse(coordinator.canSkipForward)
    assertTrue(coordinator.canSkipBack)
    coordinator.setUpcoming(emptyList(), true, Repeat.OFF)
    assertTrue(coordinator.canSkipForward)
    coordinator.setUpcoming(listOf(testEntry("b")), false, Repeat.OFF)
    assertTrue(coordinator.canSkipForward)
    coordinator.setUpcoming(emptyList(), false, Repeat.OFF)
    coordinator.attach(link)
    assertTrue(coordinator.canSkipForward)
  }

  @Test
  fun `the controls are told when what they may do changes`() {
    var changes = 0
    coordinator.onControlsChanged = { changes += 1 }
    coordinator.load(testEntry("a"), 0, emptyList(), false, Repeat.OFF)
    coordinator.attach(link)
    coordinator.detach(link)
    assertEquals(3, changes)
  }

  // --- Fresh URLs --------------------------------------------------------------------------------

  @Test
  fun `a network change is reported, and IP-bound upcoming URLs are asked for afresh once`() {
    start(testEntry("b"))
    coordinator.onNetworkChanged(cellular = true)
    assertEquals(
      listOf(Event.Network(1, true), Event.Request("b", RequestReason.NETWORK)),
      link.notices,
    )
    coordinator.tick()
    assertEquals(2, link.notices.size)
    // A source resolved on the new network is fresh.
    coordinator.setUpcoming(listOf(testEntry("b", url = streamUrl(sig = 2), network = 1)), false, Repeat.OFF)
    coordinator.tick()
    assertEquals(2, link.notices.size)
  }

  @Test
  fun `mobile data reported after the change reaches the web app with the same network id`() {
    start(testEntry("b", ipBound = false))
    coordinator.onNetworkChanged(cellular = false)
    coordinator.onCellularChanged(true)
    coordinator.onCellularChanged(true)
    assertEquals(listOf(Event.Network(1, false), Event.Network(1, true)), link.notices)
    assertTrue(coordinator.session().cellular)
  }

  @Test
  fun `URLs that are not IP-bound survive a network change`() {
    start(testEntry("b", ipBound = false))
    coordinator.onNetworkChanged(cellular = false)
    assertEquals(listOf(Event.Network(1, false)), link.notices)
  }

  @Test
  fun `an upcoming URL that would expire before it finished is asked for afresh`() {
    port.duration = 200_000
    coordinator.attach(link)
    val expiring = testEntry("b", expiresAt = clock.now + 5 * 60_000)
    coordinator.load(testEntry("a"), 0, listOf(expiring, testEntry("c")), false, Repeat.OFF)
    coordinator.tick()
    assertEquals(listOf(Event.Request("b", RequestReason.EXPIRING)), link.notices)
  }

  @Test
  fun `an upcoming URL that lasts is left alone, and nothing is asked without the web app`() {
    port.duration = 200_000
    start(testEntry("b", expiresAt = clock.now + 6 * 60 * 60_000))
    coordinator.tick()
    assertEquals(emptyList<Event>(), link.notices)
    coordinator.detach(link)
    coordinator.setUpcoming(listOf(testEntry("b", expiresAt = clock.now + 60_000)), false, Repeat.OFF)
    coordinator.onNetworkChanged(cellular = false)
    coordinator.tick()
    assertEquals(emptyList<Event>(), link.notices)
  }

  // --- Sessions and state ------------------------------------------------------------------------

  @Test
  fun `attaching returns where playback is, with the web app's snapshot`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b")), true, Repeat.OFF)
    coordinator.saveSnapshot("""{"v":1}""")
    coordinator.play()
    port.position = 42_000
    port.duration = 180_000
    val session = coordinator.attach(link)
    assertEquals(listOf("a", "b"), session.entries.map { it.id })
    assertEquals("a", session.state.id)
    assertEquals(42_000L, session.state.positionMs)
    assertEquals(180_000L, session.state.durationMs)
    assertTrue(session.state.playWhenReady)
    assertEquals("""{"v":1}""", session.snapshot)
    assertNull(session.error)
    assertEquals(0, session.network)
  }

  @Test
  fun `the session keeps a failure nothing has replaced yet`() {
    coordinator.load(testEntry("a"), 0, listOf(testEntry("b")), false, Repeat.OFF)
    coordinator.attach(link)
    port.fail(coordinator, forbidden)
    assertEquals(forbidden, coordinator.session().error)
  }

  @Test
  fun `state reaches the web app once per burst of changes`() {
    coordinator.attach(link)
    coordinator.load(testEntry("a"), 0, emptyList(), false, Repeat.OFF)
    coordinator.play()
    coordinator.seek(10_000)
    scheduler.runDue()
    val state = link.states.single()
    assertEquals("a", state.id)
    assertEquals(10_000L, state.positionMs)
    assertTrue(state.playWhenReady)
    assertEquals(-1L, state.durationMs)
  }

  @Test
  fun `the volume stays from 0 to 1`() {
    coordinator.setVolume(2f)
    assertEquals(1f, port.level)
    coordinator.setVolume(-1f)
    assertEquals(0f, port.level)
  }

  @Test
  fun `release forgets the queue, the sources and the snapshot`() {
    start(testEntry("b"))
    val key = port.items[0].key
    coordinator.saveSnapshot("x")
    coordinator.release()
    assertEquals(listOf("clear"), port.ops)
    assertEquals(emptyList<Entry>(), coordinator.session().entries)
    assertNull(coordinator.session().snapshot)
    try {
      table.requestFor(key)
      fail("expected an UnknownEntryException")
    } catch (expected: UnknownEntryException) {
      // The released entry's bytes can no longer be fetched.
    }
  }
}
