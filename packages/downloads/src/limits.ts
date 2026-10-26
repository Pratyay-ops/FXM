/**
 * How large a download's file may be: a ceiling no real file of the track comes near, so a server
 * that sends far more (a mislabelled multi-gigabyte upload, an answer that never ends) can't fill
 * the storage that the library shares with downloads.
 *
 * @module
 */

import type { DownloadFileFormat } from './types'

/** No download is ever larger than this: 2 GiB, also the limit when the duration is unknown. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3

/** Room for what isn't audio: headers, cover art, a container's index. */
const SLACK_BYTES = 4 * 1024 ** 2

/** How much more than the peak bitrate a file may take, for variable bitrates and short tracks. */
const MARGIN = 1.5

/** The codecs whose bitrate follows the sample rate and bit depth rather than a target. */
const LOSSLESS: ReadonlySet<string> = new Set(['flac', 'alac', 'pcm'])

/**
 * The highest average bitrate a file of `format` can reasonably have, in kbps:
 *
 * - a muxed video (YouTube's itag 18, 360p): 2,000, about three times what it needs;
 * - lossless audio: uncompressed stereo at its sample rate and bit depth (24-bit 192 kHz when
 *   unknown), which FLAC and ALAC stay below;
 * - lossy audio: its bitrate, and never less than 512, more than any codec's highest setting.
 */
export function peakKbps(format: DownloadFileFormat): number {
  if (format.media === 'muxed-video') return 2_000
  if (LOSSLESS.has(format.codec)) {
    const rate = format.sampleRateHz ?? 192_000
    const depth = format.bitDepth ?? 24
    return (rate * depth * 2) / 1_000
  }
  return Math.max(format.bitrateKbps ?? 0, 512)
}

/**
 * The largest file to accept for a download of `format` lasting `durationMs`: the duration at
 * the format's peak bitrate ({@link peakKbps}), half as much again, plus room for what isn't
 * audio; never more than {@link MAX_DOWNLOAD_BYTES}, which is also the limit for an unknown
 * duration. A 4-minute Opus song may take up to about 27 MB; a 4-minute 16-bit CD-quality FLAC
 * up to about 68 MB.
 */
export function maxDownloadBytes(format: DownloadFileFormat, durationMs?: number): number {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
    return MAX_DOWNLOAD_BYTES
  }
  const bytes = (durationMs / 1_000) * ((peakKbps(format) * 1_000) / 8) * MARGIN + SLACK_BYTES
  return Math.min(MAX_DOWNLOAD_BYTES, Math.ceil(bytes))
}
