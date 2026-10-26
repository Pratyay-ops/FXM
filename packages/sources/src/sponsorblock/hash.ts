/**
 * The privacy step of every SponsorBlock lookup: FXM never sends a videoId, only the first four
 * hex characters of its SHA-256 hash. One prefix stands for about 1 in 65,536 of all videos, so
 * SponsorBlock answers with every video in that group that has segments, and FXM picks its own out
 * on the device.
 *
 * @module
 */

import { FxmError } from '@fxm/core'

/** How many hex characters of the hash FXM sends: 4, the length SponsorBlock recommends. */
export const HASH_PREFIX_LENGTH = 4

/** Computes a SHA-256 digest, like `crypto.subtle.digest('SHA-256', data)`. */
export type Sha256 = (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>

/** A YouTube videoId: 11 characters of the URL-safe base64 alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u

/** Whether `value` is a YouTube videoId, the only kind of ID SponsorBlock is asked about. */
export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value)
}

/**
 * SHA-256 through Web Crypto, which browsers offer only in a secure context (HTTPS or
 * localhost), as every FXM app is. Rejects with an `Unsupported` `FxmError` where it is missing,
 * for example on a page served over plain HTTP from another device: FXM then skips nothing
 * rather than send the videoId itself.
 */
export const webCryptoSha256: Sha256 = async (data) => {
  // Typed as always present, but browsers leave it out of insecure contexts.
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (subtle === undefined) {
    throw new FxmError(
      'Unsupported',
      'SponsorBlock lookups need Web Crypto, which is missing outside secure contexts',
    )
  }
  return subtle.digest('SHA-256', data)
}

/** The first {@link HASH_PREFIX_LENGTH} hex characters, lower case, of SHA-256(`videoId`). */
export async function hashPrefix(
  videoId: string,
  sha256: Sha256 = webCryptoSha256,
): Promise<string> {
  const digest = new Uint8Array(await sha256(new TextEncoder().encode(videoId)))
  let prefix = ''
  for (const byte of digest.subarray(0, HASH_PREFIX_LENGTH / 2)) {
    prefix += byte.toString(16).padStart(2, '0')
  }
  return prefix
}
