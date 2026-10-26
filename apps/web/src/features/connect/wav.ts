/**
 * Tiny WAV files made on the device: the silent sound that unlocks playback in browsers that
 * want a tap first, and the fake streams of the development fake mode.
 *
 * @module
 */

/** Options for {@link wavTone}. */
export interface WavToneOptions {
  /** Length in seconds. */
  readonly seconds: number
  /** The tone's pitch in Hz; 0 for silence. Default 0. */
  readonly frequency?: number
  /** Samples per second. Default 8,000, plenty for a test tone. */
  readonly sampleRate?: number
  /** Loudness from 0 to 1. Default 0.2. */
  readonly volume?: number
}

/** A mono 16-bit PCM WAV file holding a sine tone that fades in and out, or silence. */
export function wavTone({
  seconds,
  frequency = 0,
  sampleRate = 8000,
  volume = 0.2,
}: WavToneOptions): Uint8Array<ArrayBuffer> {
  const samples = Math.max(1, Math.round(seconds * sampleRate))
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // the size of the fmt chunk
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per sample frame
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  const fade = Math.min(samples / 2, sampleRate * 0.05)
  const amplitude = Math.max(0, Math.min(1, volume)) * 0x7fff
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / fade, (samples - 1 - index) / fade)
    const value =
      frequency > 0
        ? Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude * envelope
        : 0
    view.setInt16(44 + index * 2, Math.round(value), true)
  }
  return bytes
}
