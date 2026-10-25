/**
 * Queue items and resolved streams as the native player's entries.
 *
 * @module
 */

import type { Artwork, Codec, Container, QueueItem, StreamOption, Track } from '@fxm/core'
import type { PlaySupport } from '../engine'
import type { NativeEntry, NativeMetadata, NativeSource } from './plugin'

/** The largest artwork the lock screen gets: Android scales anything bigger down anyway. */
const MAX_ARTWORK_PX = 1024

/** Codec and container pairs Media3 plays on every Android version FXM supports (7 and later). */
const PROBABLY: ReadonlySet<string> = new Set([
  'opus/webm',
  'opus/ogg',
  'vorbis/webm',
  'vorbis/ogg',
  'aac/mp4',
  'aac/m4a',
  'mp3/mp3',
  'flac/flac',
  'flac/ogg',
  'pcm/wav',
])

function formatOf(codec: Codec, container: Container): string {
  return `${codec}/${container}`
}

/**
 * How sure the native player is that it can play `stream` (see `PlaySupport`): `no` for streams
 * it refuses (not progressive, not HTTPS, or `capped`), `probably` for the formats Media3 plays on
 * every Android version FXM supports (Opus 251 in WebM, AAC 140 and itag 18 in MP4, MP3, FLAC,
 * Vorbis, WAV), `maybe` for the rest. Unlike an `<audio>` element, it can send request headers.
 */
export function nativeSupport(stream: StreamOption): PlaySupport {
  if (stream.fullLength === 'capped' || stream.protocol !== 'progressive') return 'no'
  if (!stream.url.startsWith('https://')) return 'no'
  return PROBABLY.has(formatOf(stream.codec, stream.container)) ? 'probably' : 'maybe'
}

/**
 * The artwork to show on the lock screen: the largest image of at most 1024 px that says its
 * size, else the last one (sources list them smallest first). Only HTTPS images.
 */
export function lockScreenArtwork(artwork: readonly Artwork[]): string | undefined {
  const usable = artwork.filter((image) => image.url.startsWith('https://'))
  const sized = usable.filter(
    (image) =>
      image.width !== undefined &&
      image.width > 0 &&
      Math.max(image.width, image.height ?? 0) <= MAX_ARTWORK_PX,
  )
  if (sized.length > 0) {
    return sized.reduce((best, image) => ((image.width ?? 0) > (best.width ?? 0) ? image : best))
      .url
  }
  return usable.at(-1)?.url
}

/** What the notification and the lock screen show for `track`. */
export function nativeMetadata(track: Track): NativeMetadata {
  const artworkUrl = lockScreenArtwork(track.artwork)
  return {
    title: track.title.trim() === '' ? 'Untitled' : track.title,
    artists: track.artists.map((artist) => artist.name).filter((name) => name !== ''),
    ...(track.album?.name ? { album: track.album.name } : {}),
    ...(artworkUrl === undefined ? {} : { artworkUrl }),
    ...(track.durationMs !== undefined && track.durationMs > 0
      ? { durationMs: track.durationMs }
      : {}),
  }
}

/** `stream` as a native source; `network` is the native network it was resolved on. */
export function nativeSource(stream: StreamOption, network?: number): NativeSource {
  const headers = stream.requestHeaders
  return {
    url: stream.url,
    ipBound: stream.ipBound,
    ...(headers !== undefined && Object.keys(headers).length > 0
      ? { headers: { ...headers } }
      : {}),
    ...(stream.expiresAt !== undefined && Number.isFinite(stream.expiresAt)
      ? { expiresAt: Math.max(0, Math.floor(stream.expiresAt)) }
      : {}),
    ...(network === undefined ? {} : { network }),
  }
}

/** The native entry `id` that plays `item` through `stream`. */
export function nativeEntry(
  id: string,
  item: QueueItem,
  stream: StreamOption,
  network?: number,
): NativeEntry {
  return {
    id,
    uid: item.uid,
    source: nativeSource(stream, network),
    metadata: nativeMetadata(item.track),
  }
}
