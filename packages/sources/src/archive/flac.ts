/**
 * Reads a FLAC file's sample rate and bit depth from its first 42 bytes: the `fLaC` marker and
 * the STREAMINFO block that must follow it. The Archive's metadata states neither (only its
 * `24bit Flac` format name hints at the depth), so the source can probe a stream when asked.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from '../shared'

/** What a FLAC file's STREAMINFO block says. */
export interface FlacStreamInfo {
  /** Samples per second, e.g. 44100. */
  sampleRateHz: number
  /** Number of channels, 1 to 8. */
  channels: number
  /** Bits per sample, 4 to 32. */
  bitDepth: number
  /** Samples per channel in the whole file; 0 when the encoder did not know. */
  totalSamples: number
}

/** The bytes {@link parseFlacStreamInfo} needs: the marker, a block header and STREAMINFO. */
export const FLAC_HEADER_BYTES = 42

/**
 * The STREAMINFO of a FLAC file from its first {@link FLAC_HEADER_BYTES} bytes, or `null` when
 * they are not the start of a FLAC file (an ID3 tag in front of the marker counts as not).
 */
export function parseFlacStreamInfo(bytes: Uint8Array): FlacStreamInfo | null {
  if (bytes.length < FLAC_HEADER_BYTES) return null
  const byte = (index: number) => bytes[index] ?? 0
  const marker = String.fromCharCode(byte(0), byte(1), byte(2), byte(3))
  const blockType = byte(4) & 0x7f
  const blockLength = (byte(5) << 16) | (byte(6) << 8) | byte(7)
  if (marker !== 'fLaC' || blockType !== 0 || blockLength < 34) return null
  const sampleRateHz = (byte(18) << 12) | (byte(19) << 4) | (byte(20) >> 4)
  const channels = ((byte(20) >> 1) & 0x07) + 1
  const bitDepth = (((byte(20) & 0x01) << 4) | (byte(21) >> 4)) + 1
  const low = ((byte(22) << 24) | (byte(23) << 16) | (byte(24) << 8) | byte(25)) >>> 0
  const totalSamples = (byte(21) & 0x0f) * 2 ** 32 + low
  if (sampleRateHz === 0 || bitDepth < 4) return null
  return { sampleRateHz, channels, bitDepth, totalSamples }
}

/**
 * Fetches the first bytes of a FLAC URL with a single range request (`Range: bytes=0-41`, which
 * browsers send without a CORS preflight) and reads its STREAMINFO. `null` when the server
 * ignores the range (the body is then cancelled unread, never downloaded), answers with an error,
 * cannot be reached, or the bytes are not FLAC. Rejects only with the caller's cancellation.
 */
export async function probeFlac(
  ctx: ProviderContext,
  url: string,
  timeoutMs: number,
): Promise<FlacStreamInfo | null> {
  const { signal } = ctx
  try {
    const response = await fetchWithTimeout(ctx.fetch, url, {
      headers: { Range: `bytes=0-${FLAC_HEADER_BYTES - 1}` },
      credentials: 'omit',
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    return parseFlacStreamInfo(new Uint8Array(await response.arrayBuffer()))
  } catch {
    if (signal?.aborted) throw signal.reason
    return null
  }
}
