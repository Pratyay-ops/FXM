/**
 * Cover art for saved files: the track's largest artwork, fetched with the platform's `fetch`,
 * checked to be a JPEG or PNG image (WebP and GIF are converted when the platform can), and
 * left out when anything goes wrong: a file without its cover beats no file.
 *
 * @module
 */

import type { Artwork, ProviderContext } from '@fxm/core'
import { readU16BE, readU32BE } from './bytes'
import type { CoverArt } from './types'

/** The largest cover FXM embeds: more is never artwork. */
export const MAX_COVER_BYTES = 8 * 1024 * 1024

/** An image's type and size, from its first bytes. */
export interface ImageInfo {
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  readonly width?: number
  readonly height?: number
}

/** The size in a JPEG's frame header (SOFn), when it has one. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1] ?? 0
    const length = readU16BE(bytes, at + 2)
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: readU16BE(bytes, at + 5), width: readU16BE(bytes, at + 7) }
    }
    at += 2 + length
  }
  return undefined
}

/** What an image is, from its signature; `undefined` for anything that isn't an image. */
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', ...jpegSize(bytes) }
  }
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { mimeType: 'image/png', width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
  }
  const text = String.fromCharCode(...bytes.subarray(0, 12))
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return { mimeType: 'image/webp' }
  if (text.startsWith('GIF8')) return { mimeType: 'image/gif' }
  return undefined
}

/** The artwork to embed: the largest the source offers. */
export function largestArtwork(artwork: readonly Artwork[]): Artwork | undefined {
  return [...artwork].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
}

/** Options for {@link fetchCover}. */
export interface FetchCoverOptions {
  /** The platform's `fetch` (a provider context's). */
  readonly fetch: ProviderContext['fetch']
  readonly signal?: AbortSignal
  /**
   * Converts an image tags can't hold (WebP, GIF) to JPEG, e.g. through a canvas. Without it,
   * such covers are left out.
   */
  readonly toJpeg?: (image: Blob) => Promise<Blob | undefined>
}

async function readCover(blob: Blob): Promise<CoverArt | undefined> {
  if (blob.size === 0 || blob.size > MAX_COVER_BYTES) return undefined
  const data = new Uint8Array(await blob.arrayBuffer())
  const info = sniffImage(data)
  if (info?.mimeType !== 'image/jpeg' && info?.mimeType !== 'image/png') return undefined
  return {
    mimeType: info.mimeType,
    data,
    ...(info.width === undefined ? {} : { width: info.width }),
    ...(info.height === undefined ? {} : { height: info.height }),
  }
}

/**
 * The track's cover as JPEG or PNG bytes, or `undefined` when it has none or it can't be had.
 * Never throws (unless `signal` aborts).
 */
export async function fetchCover(
  artwork: readonly Artwork[],
  options: FetchCoverOptions,
): Promise<CoverArt | undefined> {
  const chosen = largestArtwork(artwork)
  if (chosen === undefined || !/^https:\/\//.test(chosen.url)) return undefined
  try {
    const response = await options.fetch(chosen.url, {
      credentials: 'omit',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) return undefined
    const announced = Number(response.headers.get('content-length') ?? 0)
    if (announced > MAX_COVER_BYTES) return undefined
    const blob = await response.blob()
    const cover = await readCover(blob)
    if (cover !== undefined || options.toJpeg === undefined) return cover
    const head = sniffImage(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))
    if (head === undefined) return undefined
    const converted = await options.toJpeg(blob)
    return converted === undefined ? undefined : await readCover(converted)
  } catch (error) {
    if (options.signal?.aborted) throw error
    return undefined
  }
}
