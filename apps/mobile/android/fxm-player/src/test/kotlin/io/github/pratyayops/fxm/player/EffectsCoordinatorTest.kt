package io.github.pratyayops.fxm.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EffectsCoordinatorTest {
  private val clock = FakeClock()
  private val scheduler = FakeScheduler(clock)
  private val port = FakePort()
  private val coordinator = Coordinator(port, SourceTable(), FakeHost(), clock, scheduler)
  private val link = RecordingLink()

  private val loud = Loudness(-10.11)
  private val normalize = LoudnessSettings(enabled = true, targetLufs = -14.0)

  private fun start(vararg upcoming: Entry, first: Entry = testEntry("a", loudness = loud)) {
    coordinator.attach(link)
    coordinator.load(first, 0, upcoming.toList(), false, Repeat.OFF)
    coordinator.play()
    scheduler.runDue()
    link.events.clear()
    port.ops.clear()
  }

  @Test
  fun `the equalizer and the speed go to Media3`() {
    val settings = EffectsSettings(EqualizerSettings(true, List(10) { 2.0 }), normalize, 1.25f)
    coordinator.setEffects(settings)
    assertEquals(settings.equalizer, port.appliedEqualizer)
    assertEquals(1.25f, port.appliedSpeed)
    coordinator.setEffects(settings.copy(speed = 9f))
    assertEquals(2f, port.appliedSpeed)
  }

  @Test
  fun `each entry plays at its own level, also across the boundaries Media3 crosses`() {
    start(testEntry("b"), testEntry("c", loudness = Loudness(-12.0)))
    coordinator.setVolume(0.8f)
    assertEquals(0.8f, port.level, 1e-6f)
    coordinator.setEffects(EffectsSettings(loudness = normalize))
    assertEquals(0.8f * LoudnessGain.factor(-3.89), port.level, 1e-6f)
    port.advance(coordinator)
    // b says nothing about its loudness: it plays as it is.
    assertEquals(0.8f, port.level, 1e-6f)
    port.advance(coordinator)
    assertEquals(0.8f * LoudnessGain.factor(-2.0), port.level, 1e-6f)
    coordinator.setEffects(EffectsSettings())
    assertEquals(0.8f, port.level, 1e-6f)
  }

  @Test
  fun `a loaded entry gets its level at once`() {
    coordinator.setEffects(EffectsSettings(loudness = normalize))
    coordinator.load(testEntry("a", loudness = loud), 0, emptyList(), false, Repeat.OFF)
    assertEquals(LoudnessGain.factor(-3.89), port.level, 1e-6f)
  }

  @Test
  fun `the sleep timer fades out, pauses, tells the web app and puts the volume back`() {
    start(testEntry("b"))
    coordinator.setVolume(1f)
    coordinator.setSleepTimer(SleepTimer(clock.now + 60_000, 10_000, false))
    scheduler.advance(49_999)
    assertEquals(1f, port.level, 0f)
    assertTrue(port.playWhenReady)
    scheduler.advance(5_001)
    assertEquals(0.5f, port.level, 0.03f)
    scheduler.advance(5_000)
    assertFalse(port.playWhenReady)
    assertEquals(1f, port.level, 0f)
    assertEquals(listOf<Event>(Event.Sleep(SleepReason.TIMER)), link.notices)
  }

  @Test
  fun `cancelling the sleep timer brings the volume back`() {
    start()
    coordinator.setSleepTimer(SleepTimer(clock.now + 20_000, 10_000, false))
    scheduler.advance(15_000)
    assertTrue(port.level < 1f)
    coordinator.setSleepTimer(null)
    assertEquals(1f, port.level, 0f)
    scheduler.advance(60_000)
    assertTrue(port.playWhenReady)
    assertTrue(link.notices.isEmpty())
  }

  @Test
  fun `the sleep timer pauses at the end of the track through Media3`() {
    start(testEntry("b"))
    coordinator.setSleepTimer(SleepTimer(null, 0, true))
    assertTrue(port.pauseAtEnd)
    coordinator.onPausedAtEndOfItem()
    assertFalse(port.pauseAtEnd)
    assertEquals(listOf<Event>(Event.Sleep(SleepReason.END_OF_TRACK)), link.notices)
    // Only once: a later pause at an end is not the timer's.
    coordinator.onPausedAtEndOfItem()
    assertEquals(1, link.notices.size)
  }

  @Test
  fun `the sleep timer works without the web app`() {
    start()
    coordinator.detach(link)
    coordinator.setSleepTimer(SleepTimer(clock.now + 1_000, 0, false))
    scheduler.advance(1_000)
    assertFalse(port.playWhenReady)
  }

  @Test
  fun `a timer whose time passed pauses at once, and release cancels one`() {
    start()
    coordinator.setSleepTimer(SleepTimer(clock.now - 5, 10_000, false))
    assertFalse(port.playWhenReady)
    coordinator.setSleepTimer(SleepTimer(null, 0, true))
    coordinator.release()
    assertFalse(port.pauseAtEnd)
  }
}
