import { describe, expect, it } from 'vitest'
import { wavTone } from './wav'

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

describe('wavTone', () => {
  it('writes a mono 16-bit PCM WAV file of the right length', () => {
    const bytes = wavTone({ seconds: 0.5, frequency: 440, sampleRate: 8000 })
    const view = new DataView(bytes.buffer)
    expect(text(bytes, 0, 4)).toBe('RIFF')
    expect(text(bytes, 8, 8)).toBe('WAVEfmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(bytes, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8000)
    expect(bytes.byteLength).toBe(44 + 8000)
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
  })

  it('fades the tone in and out, and stays within the volume', () => {
    const bytes = wavTone({ seconds: 1, frequency: 440, volume: 0.5 })
    const view = new DataView(bytes.buffer)
    const samples = (bytes.byteLength - 44) / 2
    const sample = (index: number) => view.getInt16(44 + index * 2, true)
    expect(sample(0)).toBe(0)
    expect(sample(samples - 1)).toBe(0)
    let peak = 0
    for (let index = 0; index < samples; index += 1) peak = Math.max(peak, Math.abs(sample(index)))
    expect(peak).toBeGreaterThan(0x7fff * 0.45)
    expect(peak).toBeLessThanOrEqual(Math.round(0x7fff * 0.5))
  })

  it('is silent without a frequency', () => {
    const bytes = wavTone({ seconds: 0.05 })
    expect(bytes.subarray(44).every((byte) => byte === 0)).toBe(true)
  })
})
