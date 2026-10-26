package io.github.pratyayops.fxm.player

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import java.nio.ByteBuffer

/**
 * The equalizer in Media3's audio sink (stage 8.1): [EqualizerDsp] on the decoded PCM, 16-bit or
 * float, before the speed change and the output. Every stream passes through it, YouTube's too:
 * unlike a web page, the native player reads every byte. Settings arrive from the main thread
 * ([setEqualizer]) and apply from the next buffer; off or flat, buffers are copied unchanged.
 */
class EqualizerProcessor : BaseAudioProcessor() {
  @Volatile private var settings = EqualizerSettings()
  @Volatile private var version = 0
  private var applied = -1
  private var dsp: EqualizerDsp? = null
  private var encoding = PcmEncoding.PCM_16

  /** Takes a new equalizer setting; safe from any thread. */
  fun setEqualizer(settings: EqualizerSettings) {
    this.settings = settings
    version += 1
  }

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    encoding =
      when (inputAudioFormat.encoding) {
        C.ENCODING_PCM_16BIT -> PcmEncoding.PCM_16
        C.ENCODING_PCM_FLOAT -> PcmEncoding.PCM_FLOAT
        else -> throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
      }
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val size = inputBuffer.remaining()
    if (size == 0) return
    val format = inputAudioFormat
    val current = dsp ?: EqualizerDsp(format.sampleRate, format.channelCount).also { dsp = it }
    val wanted = version
    if (applied != wanted) {
      current.update(settings)
      applied = wanted
    }
    val output = replaceOutputBuffer(size)
    current.process(inputBuffer, output, encoding)
    output.flip()
  }

  override fun onFlush() {
    // A new format, or a seek: fresh filters for what comes next.
    dsp = null
    applied = -1
  }

  override fun onReset() {
    dsp = null
    applied = -1
  }
}
