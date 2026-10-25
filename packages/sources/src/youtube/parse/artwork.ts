/**
 * Cover art and photos from InnerTube's thumbnail lists, in the sizes they list.
 *
 * @module
 */

import type { Artwork } from '@fxm/core'
import { asArray, asNumber, asRecord, asString, recordAt } from '../json'

/** The size YouTube Music shows album covers at on an album page. */
export const LARGE_ARTWORK = 544

/** A Google image URL's size suffix: `=w120-h120…` or `=s88…`. */
const SIZED = /=(?:w(\d+)-h(\d+)|s(\d+))(?=[-a-z0-9]*$)/u

/**
 * The artwork in a thumbnail list (`[{ url, width, height }]`), smallest first, without repeats.
 * Protocol-relative URLs get `https:`, and anything but http(s) is dropped.
 *
 * Google's image servers render any size, so when the largest image of a square cover or photo
 * on `*.googleusercontent.com` or `*.ggpht.com` is smaller than {@link LARGE_ARTWORK} pixels,
 * that size is added, as YouTube Music's own album pages show it: search results list only 60
 * and 120 pixels.
 */
export function artworkOf(thumbnails: unknown): Artwork[] {
  const seen = new Set<string>()
  const artwork: Artwork[] = []
  for (const item of asArray(thumbnails)) {
    const thumbnail = asRecord(item)
    const raw = asString(thumbnail?.url)
    if (raw === undefined) continue
    const url = raw.startsWith('//') ? `https:${raw}` : raw
    if (!/^https?:\/\//u.test(url) || seen.has(url)) continue
    seen.add(url)
    const width = positive(thumbnail?.width)
    const height = positive(thumbnail?.height)
    artwork.push({
      url,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    })
  }
  artwork.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  const large = enlarged(artwork.at(-1))
  if (large !== undefined && !seen.has(large.url)) artwork.push(large)
  return artwork
}

function positive(value: unknown): number | undefined {
  const number = asNumber(value)
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined
}

function enlarged(largest: Artwork | undefined): Artwork | undefined {
  if (largest?.width === undefined || largest.width >= LARGE_ARTWORK) return undefined
  if (largest.height !== undefined && largest.height !== largest.width) return undefined
  if (!URL.canParse(largest.url)) return undefined
  const { hostname } = new URL(largest.url)
  if (!/(?:^|\.)(?:googleusercontent|ggpht)\.com$/u.test(hostname)) return undefined
  const match = SIZED.exec(largest.url)
  if (match === null) return undefined
  const size =
    match[3] === undefined ? `=w${LARGE_ARTWORK}-h${LARGE_ARTWORK}` : `=s${LARGE_ARTWORK}`
  return {
    url: largest.url.replace(SIZED, size),
    width: LARGE_ARTWORK,
    height: LARGE_ARTWORK,
  }
}

/** The artwork of a `musicThumbnailRenderer` (or a renderer holding one), if any. */
export function musicThumbnailArtwork(holder: unknown): Artwork[] {
  const renderer =
    recordAt(holder, 'musicThumbnailRenderer') ??
    recordAt(holder, 'thumbnail', 'musicThumbnailRenderer') ??
    recordAt(holder, 'thumbnailRenderer', 'musicThumbnailRenderer') ??
    recordAt(holder, 'croppedSquareThumbnailRenderer')
  return artworkOf(recordAt(renderer, 'thumbnail')?.thumbnails)
}
