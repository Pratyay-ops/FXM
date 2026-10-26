import { describe, expect, it } from 'vitest'
import { MAX_DOWNLOAD_BYTES, maxDownloadBytes, peakKbps } from './limits'
import type { DownloadFileFormat } from './types'

const opus: DownloadFileFormat = {
  codec: 'opus',
  container: 'webm',
  media: 'audio',
  tier: 'high',
  bitrateKbps: 160,
}
const cdFlac: DownloadFileFormat = {
  codec: 'flac',
  container: 'flac',
  media: 'audio',
  tier: 'lossless',
  sampleRateHz: 44_100,
  bitDepth: 16,
}
const itag18: DownloadFileFormat = {
  codec: 'aac',
  container: 'mp4',
  media: 'muxed-video',
  tier: 'normal',
  bitrateKbps: 96,
}

const FOUR_MINUTES = 4 * 60_000

describe('the download size limit', () => {
  it('follows the peak bitrate of the format', () => {
    expect(peakKbps(opus)).toBe(512)
    expect(peakKbps({ ...opus, bitrateKbps: 640 })).toBe(640)
    expect(peakKbps(cdFlac)).toBeCloseTo(1411.2)
    // Unknown lossless: 24-bit 192 kHz stereo.
    expect(peakKbps({ codec: 'pcm', container: 'wav', media: 'audio', tier: 'lossless' })).toBe(
      9216,
    )
    expect(peakKbps(itag18)).toBe(2000)
  })

  it('leaves real files far below it', () => {
    const real = (kbps: number) => ((FOUR_MINUTES / 1000) * kbps * 1000) / 8
    expect(maxDownloadBytes(opus, FOUR_MINUTES)).toBeGreaterThan(5 * real(160))
    expect(maxDownloadBytes(cdFlac, FOUR_MINUTES)).toBeGreaterThan(1.5 * real(1411.2))
    expect(maxDownloadBytes(itag18, FOUR_MINUTES)).toBeGreaterThan(3 * real(600))
    expect(maxDownloadBytes(opus, FOUR_MINUTES)).toBeLessThan(30_000_000)
  })

  it('caps every file, also one of unknown length', () => {
    expect(maxDownloadBytes(opus)).toBe(MAX_DOWNLOAD_BYTES)
    expect(maxDownloadBytes(opus, 0)).toBe(MAX_DOWNLOAD_BYTES)
    expect(maxDownloadBytes(opus, Number.NaN)).toBe(MAX_DOWNLOAD_BYTES)
    // Ten hours of 24-bit 192 kHz audio would be far more.
    expect(
      maxDownloadBytes({ ...cdFlac, sampleRateHz: 192_000, bitDepth: 24 }, 10 * 3_600_000),
    ).toBe(MAX_DOWNLOAD_BYTES)
  })
})
