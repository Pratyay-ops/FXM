/**
 * Queue items and resolved streams as the native player's entries, and back.
 *
 * @module
 */

import {
  type Artwork,
  type Codec,
  type Container,
  type QueueItem,
  type StreamOption,
  sanitizeStreamLoudness,
  type Track,
} from '@fxm/core'
import type { PlaySupport } from '../engine'
import { deviceFileUri, pageOrigin, webViewFileUrl } from './device-files'
import {
  FXM_PLAYER_MAX_ENTRY_DATA,
  type FxmPlayerEntry,
  type FxmPlayerMetadata,
  type FxmPlayerSource,
} from './plugin'

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

/** What the plugin takes for headers (`PlayerMessages.source`): OkHttp's rules. */
const MAX_HEADERS = 32
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HEADER_VALUE = /^[\t\x20-\x7e]*$/

// The values a StreamOption read back from an entry's data may have.
const CODECS: ReadonlySet<string> = new Set(['opus', 'aac', 'mp3', 'vorbis', 'flac', 'alac', 'pcm'])
const CONTAINERS: ReadonlySet<string> = new Set(['webm', 'mp4', 'm4a', 'mp3', 'ogg', 'flac', 'wav'])
const MEDIA: ReadonlySet<string> = new Set(['audio', 'muxed-video'])
const TIERS: ReadonlySet<string> = new Set(['lossless', 'high', 'normal', 'low'])
const FULL_LENGTH: ReadonlySet<string> = new Set(['verified', 'unverified'])

function formatOf(codec: Codec, container: Container): string {
  return `${codec}/${container}`
}

/** Whether the plugin takes `stream`'s URL and headers, which OkHttp would otherwise refuse. */
function sendable(stream: StreamOption): boolean {
  let url: URL
  try {
    url = new URL(stream.url)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.hostname === '') return false
  const headers = Object.entries(stream.requestHeaders ?? {})
  return (
    headers.length <= MAX_HEADERS &&
    headers.every(
      ([name, value]) =>
        typeof value === 'string' && HEADER_NAME.test(name) && HEADER_VALUE.test(value),
    )
  )
}

/**
 * How sure the native player is that it can play `stream` (see `PlaySupport`): `no` for streams
 * it refuses (not progressive, `capped`, neither an absolute HTTPS URL nor a file on the device,
 * or headers the plugin would refuse), `probably` for the formats Media3 plays on every Android
 * version FXM supports (Opus 251 in WebM, AAC 140 and itag 18 in MP4, MP3, FLAC, Vorbis, WAV),
 * `maybe` for the rest. Unlike an `<audio>` element, it can send request headers. Files on the
 * device (stage 6.4: offline copies and the device's music, at the WebView URLs of
 * `device-files.ts` for the page's `origin`) play from the device; a `blob:` URL can't.
 */
export function nativeSupport(
  stream: StreamOption,
  origin: string | null = pageOrigin() ?? null,
): PlaySupport {
  if (stream.fullLength === 'capped' || stream.protocol !== 'progressive') return 'no'
  if (deviceFileUri(stream.url, origin) === undefined && !sendable(stream)) return 'no'
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
export function nativeMetadata(track: Track): FxmPlayerMetadata {
  const artworkUrl = lockScreenArtwork(track.artwork)
  const { durationMs } = track
  return {
    title: track.title.trim() === '' ? 'Untitled' : track.title,
    artists: track.artists.map((artist) => artist.name).filter((name) => name !== ''),
    ...(track.album?.name ? { album: track.album.name } : {}),
    ...(artworkUrl === undefined ? {} : { artworkUrl }),
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0
      ? { durationMs }
      : {}),
  }
}

/**
 * The key naming the bytes `url` serves ({@link FxmPlayerSource.fileKey}), when the URL says.
 * googlevideo URLs carry the format (`itag`), the encoded file's last-modified time (`lmt`), its
 * length (`clen`, except itag 18) and duration (`dur`); a fresh URL for the same file differs
 * only in its signed and per-request fields (see fxm-player's CLEAN-ROOM.md). Until the YouTube
 * source names the file on the `StreamOption` itself, this is where that knowledge lives, so the
 * native player needs none.
 */
export function streamFileKey(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.googlevideo.com')) {
    return undefined
  }
  const params = parsed.searchParams
  const itag = params.get('itag')
  const lmt = params.get('lmt')
  if (!itag || !lmt) return undefined
  return ['googlevideo', itag, lmt, params.get('clen') ?? '', params.get('dur') ?? ''].join(':')
}

/**
 * `stream` as a native source; `network` is the native network it was resolved on. A file on the
 * device is a `file` source of its `file:` or `content:` URI, which never expires and is bound to
 * no network.
 */
export function nativeSource(
  stream: StreamOption,
  network?: number,
  origin: string | null = pageOrigin() ?? null,
): FxmPlayerSource {
  const file = deviceFileUri(stream.url, origin)
  if (file !== undefined) return { kind: 'file', url: file }
  const headers = stream.requestHeaders
  const fileKey = streamFileKey(stream.url)
  const loudness = stream.loudness
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
    ...(fileKey === undefined ? {} : { fileKey }),
    ...(loudness === undefined
      ? {}
      : {
          loudness: {
            trackLufs: loudness.trackLufs,
            ...(loudness.albumLufs === undefined ? {} : { albumLufs: loudness.albumLufs }),
          },
        }),
  }
}

/** `stream` as an entry's data: everything but the URL, which the source carries. */
function streamData(stream: StreamOption): string | undefined {
  const { url: _url, ...rest } = stream
  const data = JSON.stringify(rest)
  return data.length <= FXM_PLAYER_MAX_ENTRY_DATA ? data : undefined
}

/** The native entry `id` that plays `item` through `stream`, with the stream as its data. */
export function nativeEntry(
  id: string,
  item: QueueItem,
  stream: StreamOption,
  network?: number,
  origin: string | null = pageOrigin() ?? null,
): FxmPlayerEntry {
  const data = streamData(stream)
  return {
    id,
    uid: item.uid,
    source: nativeSource(stream, network, origin),
    metadata: nativeMetadata(item.track),
    ...(data === undefined ? {} : { data }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

/**
 * The stream an entry plays, read back from its data in a session: `undefined` unless the data
 * is a stream the native player can play, for the entry's URL (for a file on the device, the
 * WebView URL of its URI, as the stream had it). The data comes back from the native side, so it
 * is checked like anything read from storage; only known fields are copied.
 */
export function restoreStream(
  entry: FxmPlayerEntry,
  origin: string | null = pageOrigin() ?? null,
): StreamOption | undefined {
  if (entry.data === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(entry.data)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { codec, container, media, tier, protocol, fullLength, ipBound } = value
  if (
    typeof codec !== 'string' ||
    !CODECS.has(codec) ||
    typeof container !== 'string' ||
    !CONTAINERS.has(container) ||
    typeof media !== 'string' ||
    !MEDIA.has(media) ||
    typeof tier !== 'string' ||
    !TIERS.has(tier) ||
    protocol !== 'progressive' ||
    typeof fullLength !== 'string' ||
    !FULL_LENGTH.has(fullLength) ||
    typeof ipBound !== 'boolean'
  ) {
    return undefined
  }
  const url =
    entry.source.kind === 'file'
      ? (webViewFileUrl(entry.source.url, origin) ?? entry.source.url)
      : entry.source.url
  const stream: StreamOption = {
    url,
    codec: codec as Codec,
    container: container as Container,
    media: media as StreamOption['media'],
    tier: tier as StreamOption['tier'],
    protocol: 'progressive',
    ipBound,
    fullLength: fullLength as StreamOption['fullLength'],
  }
  for (const key of ['bitrateKbps', 'sampleRateHz', 'bitDepth', 'expiresAt'] as const) {
    const field = value[key]
    if (isFiniteNumber(field) && field >= 0) stream[key] = field
  }
  if (isStringRecord(value.requestHeaders)) stream.requestHeaders = { ...value.requestHeaders }
  const loudness = sanitizeStreamLoudness(value.loudness)
  if (loudness !== undefined) stream.loudness = loudness
  return nativeSupport(stream, origin) === 'no' ? undefined : stream
}
