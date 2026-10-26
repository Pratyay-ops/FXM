package io.github.pratyayops.fxm.player

import androidx.media3.common.PlaybackException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PoliciesTest {
  // --- Restarting the web app ------------------------------------------------------------------

  @Test
  fun `a dead renderer is replaced at once, then later and later`() {
    val policy = RestartPolicy()
    var now = 0L
    val delays =
      (1..5).map {
        val delay = policy.delayAfterDeath(now, visible = false)
        now += delay + 1_000
        delay
      }
    assertEquals(listOf(0L, 30_000L, 120_000L, 600_000L, 600_000L), delays)
  }

  @Test
  fun `on screen, the page is replaced at once`() {
    val policy = RestartPolicy()
    policy.delayAfterDeath(0, visible = false)
    assertEquals(0L, policy.delayAfterDeath(1_000, visible = true))
    // That still counted as a death.
    assertEquals(120_000L, policy.delayAfterDeath(2_000, visible = false))
  }

  @Test
  fun `half an hour without a death starts the delays over`() {
    val policy = RestartPolicy()
    policy.delayAfterDeath(0, visible = false)
    assertEquals(30_000L, policy.delayAfterDeath(60_000, visible = false))
    // The last restart was at 90 s (60 s + its 30 s delay).
    assertEquals(0L, policy.delayAfterDeath(90_000 + 30 * 60_000L, visible = false))
  }

  // --- Network changes -------------------------------------------------------------------------

  @Test
  fun `the first network is no change, another one is`() {
    val changes = NetworkChanges()
    assertFalse(changes.onAvailable("100"))
    assertFalse(changes.onAvailable("100"))
    assertTrue(changes.onAvailable("101"))
  }

  @Test
  fun `losing the network is a change, and so is getting it back`() {
    val changes = NetworkChanges()
    changes.onAvailable("100")
    assertFalse(changes.onLost("99"))
    assertTrue(changes.onLost("100"))
    assertFalse(changes.onLost("100"))
    assertTrue(changes.onAvailable("100"))
  }

  @Test
  fun `new addresses on the same network are a change`() {
    val changes = NetworkChanges()
    changes.onAvailable("100")
    assertFalse(changes.onAddresses("100", setOf("192.0.2.10", "2001:db8::1")))
    assertFalse(changes.onAddresses("100", setOf("2001:db8::1", "192.0.2.10")))
    assertTrue(changes.onAddresses("100", setOf("192.0.2.10", "2001:db8::2")))
    // Another network's addresses don't matter.
    assertFalse(changes.onAddresses("101", setOf("198.51.100.1")))
    // Nor do a new default network's first ones.
    assertTrue(changes.onAvailable("101"))
    assertFalse(changes.onAddresses("101", setOf("198.51.100.1")))
  }

  // --- Failures ----------------------------------------------------------------------------------

  @Test
  fun `HTTP failures keep their status for the stream lifecycle`() {
    assertEquals(
      Failure(FailureType.NETWORK, 403, "m"),
      Failures.classify(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 403, false, "m"),
    )
    assertEquals(
      Failure(FailureType.NETWORK, null, "m"),
      Failures.classify(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, null, false, "m"),
    )
    assertTrue(403 in Failures.GIVE_UP_STATUSES && 410 in Failures.GIVE_UP_STATUSES)
    assertFalse(500 in Failures.GIVE_UP_STATUSES)
  }

  @Test
  fun `formats the device cannot play are unsupported, broken bytes are decode errors`() {
    for (code in listOf(
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
      PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
      PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
    )) {
      assertEquals(FailureType.UNSUPPORTED, Failures.classify(code, null, false, "m").type)
    }
    for (code in listOf(
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
      PlaybackException.ERROR_CODE_DECODING_FAILED,
      PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED,
    )) {
      assertEquals(FailureType.DECODE, Failures.classify(code, 200, false, "m").type)
    }
  }

  @Test
  fun `a request FXM's rules refused is unsupported`() {
    assertEquals(
      Failure(FailureType.UNSUPPORTED, null, "m"),
      Failures.classify(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, null, true, "m"),
    )
  }
}
