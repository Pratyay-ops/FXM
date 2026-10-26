/**
 * Scans the device's own music in the Android app (a `device` root, stage 6.4): the songs
 * MediaStore lists, as the `FxmDeviceMusic` plugin hands them out in pages. It reads MediaStore's
 * tags, never the files, so a phone's whole library is listed in seconds; the covers come from
 * MediaStore's thumbnails, once per album.
 *
 * Like a folder's scan (`scanner.ts`), it keeps what didn't change, writes in batches, keeps a
 * moved file's ID, and on a complete scan forgets the songs that are gone; a cancelled scan
 * removes nothing.
 *
 * **IDs** follow the folder scan's rule: a hash of the file's place. A song's place is its path on
 * its volume (`Music/Artist/Album/01 Song.flac`), so a song in the phone's Music folder gets the
 * ID the web app gives it in a `Music` folder added there: a library backup moves between them.
 *
 * @module
 */

import { type Codec, type Container, tierOf } from '@fxm/core'
import { imageKey } from './artwork'
import {
  FXM_DEVICE_MUSIC_MAX_ALBUMS,
  FXM_DEVICE_MUSIC_MAX_PAGE,
  type FxmDeviceAlbum,
  type FxmDeviceAudio,
  type FxmDeviceMusicPlugin,
} from './device-music'
import { AUDIO_EXTENSIONS, extensionOf } from './format'
import { newTrackNativeId } from './ids'
import type { LocalFilesRepo } from './repo'
import type { ScanOutcome, ScanProgress } from './scanner'
import { cleanDate, cleanText, titleFromFileName } from './tags'
import {
  fileKey,
  type LocalAudioFormat,
  type LocalFileRecord,
  type LocalRootRecord,
  type LocalTags,
  type SkippedCounts,
} from './types'

/**
 * The version of the device reader: records an older one wrote are read again, so what it learns
 * reaches songs already listed.
 */
export const DEVICE_READER_VERSION = 1

/** The volume of the phone's own shared storage, whose paths name songs as they are. */
export const PRIMARY_VOLUME = 'external_primary'

/** The size of the covers, in pixels: the lists' thumbnails, like a folder scan's. */
const COVER_PX = 128

/** What a scan works with; tests pass fakes. */
export interface DeviceScanDeps {
  repo: LocalFilesRepo
  now: () => number
}

/** What to scan, and how. */
export interface DeviceScanOptions {
  root: LocalRootRecord
  plugin: FxmDeviceMusicPlugin
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
  /** Songs per page. Default: the plugin's most, 500. */
  pageSize?: number
}

/** MIME types MediaStore gives, as the codec and container FXM knows. */
const MIME_FORMATS: Readonly<Record<string, readonly [Codec, Container]>> = {
  'audio/mpeg': ['mp3', 'mp3'],
  'audio/mp3': ['mp3', 'mp3'],
  'audio/flac': ['flac', 'flac'],
  'audio/x-flac': ['flac', 'flac'],
  'audio/mp4': ['aac', 'm4a'],
  'audio/m4a': ['aac', 'm4a'],
  'audio/x-m4a': ['aac', 'm4a'],
  'audio/opus': ['opus', 'ogg'],
  'audio/wav': ['pcm', 'wav'],
  'audio/x-wav': ['pcm', 'wav'],
  'audio/vnd.wave': ['pcm', 'wav'],
  'audio/webm': ['opus', 'webm'],
  // Matroska audio: how FXM saves Opus (and Vorbis) downloads to Music/FXM, as `.mka`. WebM is
  // Matroska, and the app's player (Media3) reads both; MediaStore doesn't say the codec.
  'audio/x-matroska': ['opus', 'webm'],
}

/** Ogg's MIME types: Opus, Vorbis or FLAC inside, which only the extension tells apart. */
const OGG_TYPES: ReadonlySet<string> = new Set(['audio/ogg', 'application/ogg'])

/** The extensions of the device's songs: the web's, plus Matroska audio, which Media3 plays. */
const DEVICE_EXTENSIONS: Readonly<Record<string, string>> = {
  ...AUDIO_EXTENSIONS,
  mka: 'audio/x-matroska',
}

/** Where FXM saves downloads on the phone's own storage ("Save to Music folder", fxm-downloads). */
const FXM_MUSIC_FOLDER = 'Music/FXM/'

/**
 * The codec in an Ogg file: Opus for `.opus`; FLAC for an `.oga` FXM saved itself (it saves FLAC
 * in Ogg under that extension, and nothing else); Vorbis otherwise, since an `.oga` from elsewhere
 * may hold Vorbis, and a song is never called lossless when it might not be.
 */
function oggFormat(item: FxmDeviceAudio, extension: string): readonly [Codec, Container] {
  if (extension === 'opus') return ['opus', 'ogg']
  const fxmCopy = item.volume === PRIMARY_VOLUME && item.path.startsWith(FXM_MUSIC_FOLDER)
  return extension === 'oga' && fxmCopy ? ['flac', 'ogg'] : ['vorbis', 'ogg']
}

/**
 * The MIME type to read a song's format from: MediaStore's when FXM knows it, else (no type, or
 * one FXM doesn't know) its extension's, which is what MediaStore types most files by anyway.
 */
function typeOf(item: FxmDeviceAudio, extension: string): string | undefined {
  const { mimeType } = item
  if (mimeType !== undefined && (Object.hasOwn(MIME_FORMATS, mimeType) || OGG_TYPES.has(mimeType)))
    return mimeType
  return Object.hasOwn(DEVICE_EXTENSIONS, extension) ? DEVICE_EXTENSIONS[extension] : undefined
}

/**
 * The format of a song from what MediaStore says (see `typeOf`), or `undefined` for a song FXM
 * doesn't list (AMR, MIDI, WMA, raw AAC and the like). MediaStore can't tell AAC from ALAC in an
 * M4A file, so an M4A is AAC: never called lossless when it might not be. FLAC and WAV are
 * lossless.
 */
export function deviceFormat(item: FxmDeviceAudio): LocalAudioFormat | undefined {
  const extension = extensionOf(item.path)
  const type = typeOf(item, extension)
  let pair: readonly [Codec, Container] | undefined
  if (type !== undefined && OGG_TYPES.has(type)) pair = oggFormat(item, extension)
  else if (type !== undefined && Object.hasOwn(MIME_FORMATS, type)) pair = MIME_FORMATS[type]
  if (pair === undefined) return undefined
  const [codec, container] = pair
  const bitrateKbps = bitrateOf(item)
  const format: LocalAudioFormat = {
    codec,
    container: container === 'm4a' && extension === 'mp4' ? 'mp4' : container,
    tier: tierOf(bitrateKbps === undefined ? { codec } : { codec, bitrateKbps }),
  }
  if (bitrateKbps !== undefined) format.bitrateKbps = bitrateKbps
  if (item.sampleRate !== undefined && item.sampleRate > 0) format.sampleRateHz = item.sampleRate
  if (format.tier === 'lossless' && item.bitsPerSample !== undefined && item.bitsPerSample > 0) {
    format.bitDepth = item.bitsPerSample
  }
  return format
}

/** The average bitrate in kbps: MediaStore's, else the file's size over its length. */
function bitrateOf(item: FxmDeviceAudio): number | undefined {
  if (item.bitrate !== undefined && item.bitrate > 0) return Math.round(item.bitrate / 1000)
  if (item.durationMs === undefined || item.durationMs <= 0 || item.size <= 0) return undefined
  return Math.round((item.size * 8) / item.durationMs)
}

/** A song's tags from MediaStore's, cleaned like a file's, with the file name as the fallback title. */
export function deviceTags(item: FxmDeviceAudio): LocalTags {
  const name = item.path.slice(item.path.lastIndexOf('/') + 1)
  const fromName = titleFromFileName(name)
  const artist = cleanText(item.artist)
  const tags: LocalTags = {
    title: cleanText(item.title) ?? fromName.title,
    artists: artist === undefined ? [] : [artist],
  }
  const albumArtist = cleanText(item.albumArtist)
  if (albumArtist !== undefined) tags.albumArtist = albumArtist
  const album = cleanText(item.album)
  if (album !== undefined) tags.album = album
  const trackNumber = whole(item.track, 9999) ?? fromName.trackNumber
  if (trackNumber !== undefined) tags.trackNumber = trackNumber
  const discNumber = whole(item.disc, 999)
  if (discNumber !== undefined) tags.discNumber = discNumber
  const releaseDate = cleanDate(undefined, item.year)
  if (releaseDate !== undefined) tags.releaseDate = releaseDate
  if (item.compilation === true) tags.compilation = true
  if (item.durationMs !== undefined && item.durationMs > 0) tags.durationMs = item.durationMs
  return tags
}

function whole(value: number | undefined, max: number): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value
    : undefined
}

/**
 * Where a song is listed inside the device root: its path on the phone's own storage, and on a
 * memory card that path after the card's volume name.
 */
export function devicePath(item: Pick<FxmDeviceAudio, 'volume' | 'path'>): string {
  return item.volume === PRIMARY_VOLUME ? item.path : `${item.volume}/${item.path}`
}

/** The native ID a song at `path` gets when first seen: see the module notes. */
export function deviceNativeId(path: string, taken: ReadonlySet<string>): string {
  const slash = path.indexOf('/')
  return slash < 0
    ? newTrackNativeId('', path, taken)
    : newTrackNativeId(path.slice(0, slash), path.slice(slash + 1), taken)
}

/** What two copies of one song share, wherever they are: a moved song keeps its ID. */
function fingerprint(file: LocalFileRecord): string {
  const { tags } = file
  return [
    file.size,
    tags.durationMs ?? '',
    tags.title,
    tags.artists.join('\u0000'),
    tags.album ?? '',
  ]
    .join('\u0001')
    .toLowerCase()
}

/** The base64 of a JPEG as bytes, for the cover's key. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** An album's key within a scan: its volume and MediaStore id. */
function albumKey(album: Pick<FxmDeviceAlbum, 'volume' | 'id'>): string {
  return `${album.volume}/${album.id}`
}

/** Scans `options.root`: see the module documentation. */
export async function scanDeviceRoot(
  deps: DeviceScanDeps,
  options: DeviceScanOptions,
): Promise<ScanOutcome> {
  const { repo, now } = deps
  const { root, plugin, signal, onProgress } = options
  const pageSize = Math.min(
    options.pageSize ?? FXM_DEVICE_MUSIC_MAX_PAGE,
    FXM_DEVICE_MUSIC_MAX_PAGE,
  )
  const existing = new Map((await repo.filesOfRoot(root.id)).map((file) => [file.path, file]))
  const taken = await repo.nativeIds()
  const stored = await repo.pictureKeys()
  /** Each album's cover key, `null` when it has none, as this scan found it. */
  const covers = new Map<string, string | null>()
  const seen = new Set<string>()
  const fresh: LocalFileRecord[] = []
  const changed: LocalFileRecord[] = []
  const skipped: SkippedCounts = {}
  const counts = { added: 0, updated: 0, unchanged: 0 }
  const progress: ScanProgress = { found: 0, read: 0, walked: false }

  /** Makes the covers of these albums that this scan hasn't asked for yet. */
  const makeCovers = async (albums: readonly FxmDeviceAlbum[]) => {
    // One request per album, with the first of its songs.
    const byAlbum = new Map<string, FxmDeviceAlbum>()
    for (const album of albums) {
      const key = albumKey(album)
      if (!covers.has(key) && !byAlbum.has(key)) byAlbum.set(key, album)
    }
    const wanted = [...byAlbum.values()]
    for (let start = 0; start < wanted.length; start += FXM_DEVICE_MUSIC_MAX_ALBUMS) {
      const batch = wanted.slice(start, start + FXM_DEVICE_MUSIC_MAX_ALBUMS)
      for (const album of batch) covers.set(albumKey(album), null)
      let pictures: Awaited<ReturnType<FxmDeviceMusicPlugin['artwork']>>['pictures']
      try {
        pictures = (await plugin.artwork({ albums: batch, size: COVER_PX })).pictures
      } catch {
        // No covers this time: the songs show without one, and the next scan asks again.
        for (const album of batch) covers.delete(albumKey(album))
        continue
      }
      for (const picture of pictures) {
        const key = imageKey(decodeBase64(picture.data))
        if (!stored.has(key)) {
          await repo.putPicture({
            key,
            url: `data:image/jpeg;base64,${picture.data}`,
            width: picture.width,
            height: picture.height,
          })
          stored.add(key)
        }
        covers.set(albumKey(picture), key)
      }
    }
  }

  let after: string | undefined
  let complete = false
  for (;;) {
    if (signal?.aborted) break
    const page = await plugin.scan(
      after === undefined ? { limit: pageSize } : { after, limit: pageSize },
    )
    // Stopped while the page was on its way: nothing of it is written.
    if (signal?.aborted) break
    if (page.total !== undefined) progress.found = page.total
    const read: {
      item: FxmDeviceAudio
      old: LocalFileRecord | undefined
      format: LocalAudioFormat
    }[] = []
    for (const item of page.items) {
      const path = devicePath(item)
      if (seen.has(path)) continue
      seen.add(path)
      const old = existing.get(path)
      const format = deviceFormat(item)
      if (format === undefined) {
        skipped.unsupported = (skipped.unsupported ?? 0) + 1
        continue
      }
      const coverGone = old?.pictureKey !== undefined && !stored.has(old.pictureKey)
      if (
        old !== undefined &&
        old.size === item.size &&
        old.lastModified === item.modifiedMs &&
        old.readerVersion === DEVICE_READER_VERSION &&
        old.uri === item.uri &&
        !coverGone
      ) {
        counts.unchanged += 1
        continue
      }
      read.push({ item, old, format })
    }
    await makeCovers(
      read.flatMap(({ item }) =>
        item.albumId === undefined
          ? []
          : [{ volume: item.volume, id: item.albumId, track: item.id }],
      ),
    )
    const at = now()
    const put: LocalFileRecord[] = []
    for (const { item, old, format } of read) {
      const path = devicePath(item)
      const id = old?.id ?? deviceNativeId(path, taken)
      taken.add(id)
      const record: LocalFileRecord = {
        key: fileKey(root.id, path),
        rootId: root.id,
        path,
        id,
        size: item.size,
        lastModified: item.modifiedMs,
        tags: deviceTags(item),
        format,
        readerVersion: DEVICE_READER_VERSION,
        addedAt: old?.addedAt ?? at,
        updatedAt: at,
        uri: item.uri,
      }
      const cover =
        item.albumId === undefined
          ? undefined
          : covers.get(albumKey({ volume: item.volume, id: item.albumId }))
      if (cover !== undefined && cover !== null) record.pictureKey = cover
      if (old === undefined) {
        counts.added += 1
        fresh.push(record)
      } else {
        counts.updated += 1
      }
      changed.push(record)
      put.push(record)
    }
    await repo.applyFiles({ put })
    progress.read += page.items.length
    progress.walked = page.next === null
    progress.found = Math.max(progress.found, progress.read)
    onProgress?.({ ...progress })
    if (page.next === null) {
      complete = true
      break
    }
    after = page.next
  }

  const outcome = (status: ScanOutcome['status'], removed: number, moved: number): ScanOutcome => ({
    status,
    added: counts.added - moved,
    updated: counts.updated,
    unchanged: counts.unchanged,
    removed,
    moved,
    skipped,
    changed,
  })
  if (!complete) return outcome('cancelled', 0, 0)

  // Songs MediaStore no longer lists are gone, unless one turned up at a new path.
  const gone = [...existing.values()].filter((file) => !seen.has(file.path))
  const goneByPrint = new Map<string, LocalFileRecord[]>()
  for (const file of gone) {
    const print = fingerprint(file)
    goneByPrint.set(print, [...(goneByPrint.get(print) ?? []), file])
  }
  const moved: LocalFileRecord[] = []
  for (const record of fresh) {
    const match = goneByPrint.get(fingerprint(record))?.shift()
    if (match === undefined) continue
    const kept = { ...record, id: match.id, addedAt: match.addedAt }
    moved.push(kept)
    changed[changed.indexOf(record)] = kept
  }
  await repo.applyFiles({ put: moved, remove: gone.map((file) => file.key) })
  return outcome('done', gone.length - moved.length, moved.length)
}
