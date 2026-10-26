package io.github.pratyayops.fxm.player

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EffectsTest {
  /** The web app's presets (`EQUALIZER_PRESETS` in @fxm/core). */
  private val rock = listOf(4.0, 3.0, 1.5, 0.0, -1.0, -0.5, 1.0, 2.5, 3.5, 4.0)
  private val bassBoost = listOf(6.0, 5.0, 4.0, 2.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0)
  private val vocal = listOf(-2.0, -2.0, -1.0, 1.0, 3.0, 4.0, 3.0, 1.5, 0.0, -1.0)

  private fun single(band: Int, gain: Double) = List(10) { if (it == band) gain else 0.0 }

  /** The level of the second half of [samples], past the filters' settling, in dB. */
  private fun levelDb(samples: DoubleArray): Double {
    val from = samples.size / 2
    var sum = 0.0
    for (index in from until samples.size) sum += samples[index] * samples[index]
    return 10 * log10(sum / (samples.size - from))
  }

  private fun sine(frequency: Double, rate: Int, amplitude: Double = 0.25): DoubleArray =
    DoubleArray(rate / 2) { amplitude * sin(2 * PI * frequency * it / rate) }

  @Test
  fun `the bands match the web app's`() {
    assertEquals(listOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0), EqualizerBands.HZ)
    assertEquals(sqrt(2.0), EqualizerBands.Q, 0.0)
  }

  @Test
  fun `a peaking filter has its gain at its centre`() {
    for ((band, frequency) in EqualizerBands.HZ.withIndex()) {
      assertEquals(6.0, EqualizerMath.responseDb(single(band, 6.0), frequency, 48_000.0), 1e-6)
    }
    assertEquals(Biquad.IDENTITY, Biquad.peaking(30_000.0, 1.4, 6.0, 48_000.0))
    assertEquals(0.0, Biquad.magnitudeDb(Biquad.peaking(1000.0, 1.4, 0.0, 48_000.0), 1000.0, 48_000.0), 1e-9)
  }

  @Test
  fun `the curve and the headroom are the web app's`() {
    // equalizerResponseDb and equalizerHeadroomDb of @fxm/core, for the same presets.
    assertEquals(-4.62, EqualizerMath.headroomDb(rock, 48_000.0), 0.0)
    assertEquals(-7.13, EqualizerMath.headroomDb(bassBoost, 48_000.0), 0.0)
    assertEquals(-5.16, EqualizerMath.headroomDb(vocal, 44_100.0), 0.0)
    assertEquals(-0.3722317872032377, EqualizerMath.responseDb(rock, 1000.0, 48_000.0), 1e-9)
    assertEquals(6.931879963750536, EqualizerMath.responseDb(bassBoost, 62.0, 48_000.0), 1e-9)
    assertEquals(5.162499735383284, EqualizerMath.responseDb(vocal, 1000.0, 44_100.0), 1e-9)
    assertEquals(0.0, EqualizerMath.headroomDb(List(10) { -3.0 }, 48_000.0), 0.0)
  }

  @Test
  fun `the equalizer changes a float signal as its curve says, with the headroom`() {
    val rate = 48_000
    val dsp = EqualizerDsp(rate, 1)
    dsp.update(EqualizerSettings(true, rock))
    assertTrue(dsp.active)
    for (frequency in listOf(62.0, 1000.0, 8000.0)) {
      dsp.reset()
      val input = sine(frequency, rate)
      val output = DoubleArray(input.size) { dsp.processSample(input[it], 0) }
      val expected = EqualizerMath.responseDb(rock, frequency, rate.toDouble()) + EqualizerMath.headroomDb(rock, rate.toDouble())
      assertEquals(expected, levelDb(output) - levelDb(input), 0.05)
    }
  }

  @Test
  fun `the equalizer processes 16-bit and float buffers, channel by channel`() {
    val rate = 44_100
    val input = sine(4000.0, rate)
    for (encoding in PcmEncoding.entries) {
      val dsp = EqualizerDsp(rate, 2)
      dsp.update(EqualizerSettings(true, single(7, 6.0)))
      val bytes = ByteBuffer.allocate(input.size * 2 * encoding.bytesPerSample).order(ByteOrder.nativeOrder())
      for (sample in input) {
        // Left: the sine; right: silence.
        if (encoding == PcmEncoding.PCM_16) {
          bytes.putShort((sample * 32768).toInt().toShort()).putShort(0)
        } else {
          bytes.putFloat(sample.toFloat()).putFloat(0f)
        }
      }
      bytes.flip()
      val out = ByteBuffer.allocate(bytes.capacity()).order(ByteOrder.nativeOrder())
      dsp.process(bytes, out, encoding)
      out.flip()
      val left = DoubleArray(input.size)
      val right = DoubleArray(input.size)
      for (index in input.indices) {
        if (encoding == PcmEncoding.PCM_16) {
          left[index] = out.getShort() / 32768.0
          right[index] = out.getShort() / 32768.0
        } else {
          left[index] = out.getFloat().toDouble()
          right[index] = out.getFloat().toDouble()
        }
      }
      // +6 dB at 4 kHz, minus the 6 dB headroom: the sine comes out at its level.
      assertEquals(0.0, levelDb(left) - levelDb(input), 0.1)
      assertTrue(right.all { it == 0.0 })
    }
  }

  @Test
  fun `off or flat, the equalizer copies the bytes`() {
    val dsp = EqualizerDsp(48_000, 2)
    dsp.update(EqualizerSettings(false, rock))
    assertFalse(dsp.active)
    dsp.update(EqualizerSettings(true, List(10) { 0.0 }))
    assertFalse(dsp.active)
    val bytes = ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8))
    val out = ByteBuffer.allocate(8)
    dsp.process(bytes, out, PcmEncoding.PCM_16)
    assertEquals(listOf<Byte>(1, 2, 3, 4, 5, 6, 7, 8), out.array().toList())
  }

  @Test
  fun `16-bit output is clipped, never wrapped`() {
    val dsp = EqualizerDsp(48_000, 1)
    dsp.update(EqualizerSettings(true, List(10) { 12.0 }))
    // The headroom keeps a full-scale sine inside; a square wave at full scale still rings over.
    val bytes = ByteBuffer.allocate(2 * 4800).order(ByteOrder.nativeOrder())
    repeat(4800) { bytes.putShort(if ((it / 24) % 2 == 0) Short.MAX_VALUE else Short.MIN_VALUE) }
    bytes.flip()
    val out = ByteBuffer.allocate(bytes.capacity()).order(ByteOrder.nativeOrder())
    dsp.process(bytes, out, PcmEncoding.PCM_16)
    out.flip()
    var previous = 0
    var jumps = 0
    while (out.hasRemaining()) {
      val value = out.getShort().toInt()
      if (kotlin.math.abs(value - previous) > 60_000) jumps += 1
      previous = value
    }
    assertEquals(0, jumps)
  }

  @Test
  fun `loudness turns tracks down to the target, never up`() {
    val on = LoudnessSettings(enabled = true, targetLufs = -14.0)
    // YouTube's loudnessDb 3.89: -10.11 LUFS.
    assertEquals(-3.89, LoudnessGain.gainDb(Loudness(-10.11), on), 0.0)
    assertEquals(-7.89, LoudnessGain.gainDb(Loudness(-10.11), on.copy(targetLufs = -18.0)), 0.0)
    assertEquals(0.0, LoudnessGain.gainDb(Loudness(-20.0), on), 0.0)
    assertEquals(-7.0, LoudnessGain.gainDb(Loudness(-10.0, albumLufs = -7.0), on.copy(album = true)), 0.0)
    assertEquals(-4.0, LoudnessGain.gainDb(Loudness(-10.0), on.copy(album = true)), 0.0)
    assertEquals(-29.0, LoudnessGain.gainDb(Loudness(6.0), on.copy(targetLufs = -23.0)), 0.0)
    assertEquals(0.0, LoudnessGain.gainDb(Loudness(-10.11), on.copy(enabled = false)), 0.0)
    assertEquals(0.0, LoudnessGain.gainDb(null, on), 0.0)
    assertEquals(0.501f, LoudnessGain.factor(-6.0), 0.001f)
  }
}
