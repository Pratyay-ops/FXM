/**
 * Cover art for local files: a small thumbnail of the cover embedded in a file, or of the
 * folder's own image (`cover.jpg`, `folder.png` and the like) when the file has none.
 *
 * Thumbnails are kept as `data:` URLs of at most {@link THUMBNAIL_SIZE} pixels. A `data:` URL
 * works everywhere a track goes (the library, the queue, the system media controls, a backup)
 * and survives reloads, where an object URL would not; at this size it costs a few kilobytes.
 * The full-size cover stays in the file.
 *
 * @module
 */

import { fnv1a64 } from './ids'

/** A cover thumbnail, as tracks carry it in `artwork`. */
export interface Thumbnail {
  url: string
  width: number
  height: number
}

/** Makes a thumbnail of an image, or `undefined` when the browser can't decode it. */
export type MakeThumbnail = (image: Blob) => Promise<Thumbnail | undefined>

/** The longest side of a thumbnail, in pixels: sharp in lists and the player bar. */
export const THUMBNAIL_SIZE = 128

/** A thumbnail URL longer than this means something went wrong; it is dropped. */
const MAX_URL_LENGTH = 32 * 1024

/** Image types every browser decodes. SVG and the like are skipped. */
const RASTER_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'])

/** Whether `type` (a picture's MIME type) is an image FXM makes thumbnails of. */
export function isRasterImage(type: string): boolean {
  return RASTER_TYPES.has(type.trim().toLowerCase())
}

/** Bytes hashed whole at each end of an image by {@link imageKey}. */
const KEY_EDGE = 8192

/** Every this many bytes, one byte of the middle of an image is hashed by {@link imageKey}. */
const KEY_STRIDE = 512

/**
 * The key a cover's thumbnail is stored under: a hash of the image's length, its first and last
 * 8 KB and a sample of the rest. Every track of an album usually embeds the same cover, so it is
 * computed once per file; hashing megabytes of identical images whole for each would stall the
 * scan, and two different images that agree on all of this don't occur in practice.
 */
export function imageKey(bytes: Uint8Array): string {
  if (bytes.length <= 4 * KEY_EDGE) return `${bytes.length}-${fnv1a64(bytes)}`
  const middle = bytes.subarray(KEY_EDGE, bytes.length - KEY_EDGE)
  const sample = new Uint8Array(2 * KEY_EDGE + Math.ceil(middle.length / KEY_STRIDE))
  sample.set(bytes.subarray(0, KEY_EDGE))
  sample.set(bytes.subarray(bytes.length - KEY_EDGE), KEY_EDGE)
  for (let index = 0; index * KEY_STRIDE < middle.length; index++) {
    sample[2 * KEY_EDGE + index] = middle[index * KEY_STRIDE] ?? 0
  }
  return `${bytes.length}-${fnv1a64(sample)}`
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read'))
    reader.readAsDataURL(blob)
  })
}

/** Draws `bitmap` at `width` × `height` on a canvas, offscreen where the browser can. */
function draw(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): OffscreenCanvas | HTMLCanvasElement | undefined {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
    return canvas
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) return undefined
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

async function encode(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
): Promise<Blob | null> {
  try {
    if ('convertToBlob' in canvas) return await canvas.convertToBlob({ type, quality: 0.8 })
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.8))
  } catch {
    return null
  }
}

/**
 * Scales `image` down to fit {@link THUMBNAIL_SIZE} and encodes it as WebP, or as JPEG where the
 * browser can't encode WebP (Safari). `undefined` where the browser lacks the canvas APIs or
 * can't decode the image: the track then shows the placeholder.
 */
export const makeThumbnail: MakeThumbnail = async (image) => {
  if (typeof createImageBitmap !== 'function' || !isRasterImage(image.type)) return undefined
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(image)
    const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = draw(bitmap, width, height)
    if (canvas === undefined) return undefined
    let blob = await encode(canvas, 'image/webp')
    // A browser that can't encode WebP hands back a PNG, which is far bigger: use JPEG then.
    if (blob === null || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg')
    if (blob === null) return undefined
    const url = await readAsDataUrl(blob)
    return url.length > MAX_URL_LENGTH ? undefined : { url, width, height }
  } catch {
    return undefined
  } finally {
    bitmap?.close()
  }
}

/** Names of folder images, best first: `cover.jpg` beats `folder.jpg`, and so on. */
const FOLDER_IMAGE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall']

/** Extensions of folder images, with the MIME type to read them as. */
const FOLDER_IMAGE_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * How good a folder image `name` is, lower is better, or `undefined` when it isn't one: only
 * the conventional names in {@link FOLDER_IMAGE_NAMES} count, case-insensitively.
 */
export function folderImageRank(name: string): number | undefined {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const base = name.slice(0, dot).toLowerCase()
  const extension = name.slice(dot + 1).toLowerCase()
  if (!Object.hasOwn(FOLDER_IMAGE_TYPES, extension)) return undefined
  const rank = FOLDER_IMAGE_NAMES.indexOf(base)
  return rank < 0 ? undefined : rank
}

/** The MIME type of a folder image, from its name. */
export function folderImageType(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return FOLDER_IMAGE_TYPES[extension] ?? 'application/octet-stream'
}
