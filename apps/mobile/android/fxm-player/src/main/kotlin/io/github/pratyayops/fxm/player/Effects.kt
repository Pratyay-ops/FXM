package io.github.pratyayops.fxm.player

import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The audio effects (stage 8.1), as plain Kotlin the JVM tests run: the equalizer's filters,
 * their headroom and the loudness gain. The web app's `@fxm/core` computes the same (its
 * `effects/biquad.ts`, `equalizer.ts` and `loudness.ts`), so a setting sounds the same in the
 * browser, the desktop app and here. [EqualizerProcessor] runs [EqualizerDsp] in Media3's audio
 * sink; [Coordinator] applies the loudness gain through the player's volume.
 */
object EqualizerBands {
  /** The bands' centre frequencies, in Hz: `EQUALIZER_BANDS_HZ` in @fxm/core. */
  val HZ: List<Double> = listOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)

  /** Each band's quality factor: √2, about an octave (`EQUALIZER_Q`). */
  val Q: Double = sqrt(2.0)

  const val MIN_GAIN_DB = -12.0
  const val MAX_GAIN_DB = 12.0
}

/** The equalizer setting: on or off, and one gain per band in dB. */
data class EqualizerSettings(
  val enabled: Boolean = false,
  val gainsDb: List<Double> = List(EqualizerBands.HZ.size) { 0.0 },
) {
  /** Whether it changes anything: on, with a band away from 0 dB. */
  val active: Boolean
    get() = enabled && gainsDb.any { it != 0.0 }
}

/** Loudness normalization: on or off, the target level in LUFS, and album gain where known. */
data class LoudnessSettings(
  val enabled: Boolean = false,
  val targetLufs: Double = -14.0,
  val album: Boolean = false,
)

/** Every effect the web app sets with `setEffects`. */
data class EffectsSettings(
  val equalizer: EqualizerSettings = EqualizerSettings(),
  val loudness: LoudnessSettings = LoudnessSettings(),
  /** Playback speed, 0.5 to 2; the pitch stays. */
  val speed: Float = 1f,
)

/** How loud an entry is (`FxmPlayerSource.loudness`): integrated loudness in LUFS. */
data class Loudness(val trackLufs: Double, val albumLufs: Double? = null)

/** A biquad's coefficients, normalized so that a0 is 1. */
data class BiquadCoefficients(val b0: Double, val b1: Double, val b2: Double, val a1: Double, val a2: Double)

/** Biquad filters as Web Audio's `BiquadFilterNode` computes them (the Audio EQ Cookbook). */
object Biquad {
  val IDENTITY = BiquadCoefficients(1.0, 0.0, 0.0, 0.0, 0.0)

  /** A peaking filter: [gainDb] at [frequencyHz], with quality factor [q]. */
  fun peaking(frequencyHz: Double, q: Double, gainDb: Double, sampleRate: Double): BiquadCoefficients {
    if (!(frequencyHz > 0) || frequencyHz >= sampleRate / 2 || !(q > 0) || !gainDb.isFinite()) return IDENTITY
    val a = 10.0.pow(gainDb / 40)
    val w0 = 2 * PI * frequencyHz / sampleRate
    val alpha = sin(w0) / (2 * q)
    val cosW0 = cos(w0)
    val a0 = 1 + alpha / a
    return BiquadCoefficients(
      b0 = (1 + alpha * a) / a0,
      b1 = (-2 * cosW0) / a0,
      b2 = (1 - alpha * a) / a0,
      a1 = (-2 * cosW0) / a0,
      a2 = (1 - alpha / a) / a0,
    )
  }

  /** How much [c] amplifies a sine at [frequencyHz], in dB. */
  fun magnitudeDb(c: BiquadCoefficients, frequencyHz: Double, sampleRate: Double): Double {
    val w = 2 * PI * frequencyHz / sampleRate
    val numRe = c.b0 + c.b1 * cos(w) + c.b2 * cos(2 * w)
    val numIm = -(c.b1 * sin(w) + c.b2 * sin(2 * w))
    val denRe = 1 + c.a1 * cos(w) + c.a2 * cos(2 * w)
    val denIm = -(c.a1 * sin(w) + c.a2 * sin(2 * w))
    return 10 * log10((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm))
  }
}

/** The equalizer's filters and headroom (`equalizerFilters`, `equalizerHeadroomDb`). */
object EqualizerMath {
  fun clampGain(gainDb: Double): Double =
    if (gainDb.isFinite()) gainDb.coerceIn(EqualizerBands.MIN_GAIN_DB, EqualizerBands.MAX_GAIN_DB) else 0.0

  fun filters(gainsDb: List<Double>, sampleRate: Double): List<BiquadCoefficients> =
    EqualizerBands.HZ.mapIndexed { band, frequency ->
      Biquad.peaking(frequency, EqualizerBands.Q, clampGain(gainsDb.getOrElse(band) { 0.0 }), sampleRate)
    }

  /** [count] frequencies spaced evenly on a log scale from 20 Hz to 20 kHz. */
  fun logFrequencies(count: Int): List<Double> =
    List(count) { index -> 20.0 * exp(ln(1000.0) * index / (count - 1)) }

  /** What the cascade does at [frequencyHz], in dB. */
  fun responseDb(gainsDb: List<Double>, frequencyHz: Double, sampleRate: Double): Double =
    filters(gainsDb, sampleRate).sumOf { Biquad.magnitudeDb(it, frequencyHz, sampleRate) }

  /**
   * How far to lower the level before the filters so that boosts can't clip a full-scale
   * signal, in dB (0 or negative): minus the curve's highest point, as the web app works it out.
   */
  fun headroomDb(gainsDb: List<Double>, sampleRate: Double): Double {
    if (gainsDb.none { it > 0 }) return 0.0
    val frequencies = EqualizerBands.HZ + logFrequencies(256)
    val peak = max(0.0, frequencies.maxOf { responseDb(gainsDb, it, sampleRate) })
    // Rounded as the web app rounds (JavaScript's Math.round, like Java's: half up).
    return -(Math.round(peak * 100) / 100.0) + 0.0
  }
}

/** The loudness gain the native player applies (`loudnessGainDb` with `boost: false`). */
object LoudnessGain {
  /** The most a track is turned down, in dB (`MAX_LOUDNESS_CUT_DB`). */
  const val MAX_CUT_DB = 30.0

  /**
   * The gain that brings a track of [loudness] down to the target, in dB: 0 when it is off, the
   * loudness unknown, or the track quieter than the target. The native player only turns tracks
   * down, through the player's volume, which applies at the track boundary Media3 crosses.
   */
  fun gainDb(loudness: Loudness?, settings: LoudnessSettings): Double {
    if (!settings.enabled || loudness == null) return 0.0
    val lufs = if (settings.album && loudness.albumLufs != null) loudness.albumLufs else loudness.trackLufs
    val gain = settings.targetLufs - lufs
    if (!gain.isFinite() || gain >= 0) return 0.0
    return Math.round(max(gain, -MAX_CUT_DB) * 100) / 100.0
  }

  /** A gain in dB as a volume factor. */
  fun factor(gainDb: Double): Float = 10.0.pow(gainDb / 20).toFloat()
}

/** The PCM encodings [EqualizerDsp] processes: Media3's 16-bit integer and float PCM. */
enum class PcmEncoding(val bytesPerSample: Int) {
  PCM_16(2),
  PCM_FLOAT(4),
}

/**
 * The equalizer on interleaved PCM: the headroom gain, then ten peaking filters per channel in
 * transposed direct form II. Runs on the audio thread; [update] takes a new setting, keeping the
 * filters' state so a change doesn't click.
 */
class EqualizerDsp(private val sampleRate: Int, private val channels: Int) {
  private var coefficients: List<BiquadCoefficients> = List(EqualizerBands.HZ.size) { Biquad.IDENTITY }
  private var preGain = 1.0
  private val z1 = Array(channels) { DoubleArray(EqualizerBands.HZ.size) }
  private val z2 = Array(channels) { DoubleArray(EqualizerBands.HZ.size) }

  /** Whether it changes the signal: off or flat, [process] copies it. */
  var active = false
    private set

  fun update(settings: EqualizerSettings) {
    active = settings.active && channels > 0 && sampleRate > 0
    if (!active) return
    val rate = sampleRate.toDouble()
    coefficients = EqualizerMath.filters(settings.gainsDb, rate)
    preGain = 10.0.pow(EqualizerMath.headroomDb(settings.gainsDb, rate) / 20)
  }

  /** Forgets the filters' state, e.g. after a seek. */
  fun reset() {
    for (channel in 0 until channels) {
      z1[channel].fill(0.0)
      z2[channel].fill(0.0)
    }
  }

  /** One sample of [channel], from -1 to 1. */
  fun processSample(sample: Double, channel: Int): Double {
    var x = sample * preGain
    val state1 = z1[channel]
    val state2 = z2[channel]
    for (band in coefficients.indices) {
      val c = coefficients[band]
      val y = c.b0 * x + state1[band]
      state1[band] = c.b1 * x - c.a1 * y + state2[band]
      state2[band] = c.b2 * x - c.a2 * y
      x = y
    }
    return x
  }

  /**
   * Processes the frames in [input] into [output] (both in the platform's byte order, as Media3
   * hands them out), which must have room for them. Off or flat, it copies them.
   */
  fun process(input: ByteBuffer, output: ByteBuffer, encoding: PcmEncoding) {
    if (!active) {
      output.put(input)
      return
    }
    var channel = 0
    while (input.remaining() >= encoding.bytesPerSample) {
      when (encoding) {
        PcmEncoding.PCM_16 -> {
          val y = processSample(input.getShort() / 32768.0, channel)
          output.putShort((y * 32768.0).coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
        PcmEncoding.PCM_FLOAT -> output.putFloat(processSample(input.getFloat().toDouble(), channel).toFloat())
      }
      channel = (channel + 1) % channels
    }
  }
}
