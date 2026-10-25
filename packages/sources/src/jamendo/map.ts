/**
 * Jamendo's JSON as FXM's model: tracks, albums, artists and stream options.
 *
 * FXM asks for `audioformat=flac` and `audiodlformat=flac`. The `audio` URL Jamendo returns then
 * streams FLAC (`https://prod-1.storage.jamendo.com/?trackid=<id>&format=flac&from=…`), and the
 * same URL with another `format` streams its MP3 and Ogg Vorbis versions, which play under a
 * lower quality ceiling such as mobile data. Every option of a track whose artist turned
 * downloads off (`audiodownload_allowed: false`) says so with `downloadAllowed: false`.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type Codec,
  type Container,
  formatId,
  type StreamOption,
  type Track,
  tierOf,
} from '@fxm/core'
import { asObject, releaseDate, text } from '../shared/json'

/** The size of the images FXM asks for (`imagesize`), in pixels. */
export const JAMENDO_IMAGE_SIZE = 300

/** One Jamendo track, with the fields FXM uses. */
export interface JamendoTrackRecord {
  /** Jamendo's numeric ID, in decimal. */
  id: string
  /** The title. */
  name: string
  /** Duration in milliseconds. */
  durationMs?: number
  /** The artist's ID. */
  artistId?: string
  /** The artist's name. */
  artistName?: string
  /** The album's ID; absent for singles. */
  albumId?: string
  /** The album's name; absent for singles. */
  albumName?: string
  /** The position on the album. */
  position?: number
  /** The release date (`2021-04-11`). */
  releaseDate?: string
  /** The cover image, {@link JAMENDO_IMAGE_SIZE} pixels square. */
  image?: string
  /** The stream URL, in the format FXM asked for (FLAC). */
  audio?: string
  /** Whether the artist allows downloads (`audiodownload_allowed`). */
  downloadAllowed: boolean
  /** The Creative Commons licence URL. */
  licenseUrl?: string
}

/** What a nested track inherits from the album or artist it was listed under. */
export type JamendoParent = Partial<
  Pick<
    JamendoTrackRecord,
    'artistId' | 'artistName' | 'albumId' | 'albumName' | 'image' | 'releaseDate'
  >
>

/** A Jamendo ID in canonical form, decimal without leading zeros, or `undefined`. */
export function jamendoId(value: unknown): string | undefined {
  const raw = typeof value === 'number' ? String(value) : text(value)
  if (raw === undefined || !/^\d+$/u.test(raw)) return undefined
  const number = Number(raw)
  return Number.isSafeInteger(number) && number > 0 ? String(number) : undefined
}

/** An `https:` URL, or `undefined`. */
function httpsUrl(value: unknown): string | undefined {
  const candidate = text(value)
  if (candidate === undefined) return undefined
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : undefined
  } catch {
    return undefined
  }
}

/** A track from Jamendo's JSON, or `null` without an ID and a name. */
export function toTrackRecord(
  value: unknown,
  parent: JamendoParent = {},
): JamendoTrackRecord | null {
  const object = asObject(value)
  const id = jamendoId(object?.id)
  const name = text(object?.name)
  if (object === undefined || id === undefined || name === undefined) return null
  const allowed = object.audiodownload_allowed
  const record: JamendoTrackRecord = {
    id,
    name,
    // Older answers lack the flag; then only a download URL says downloads are allowed.
    downloadAllowed:
      allowed === true || (allowed === undefined && text(object.audiodownload) !== undefined),
  }
  const seconds = typeof object.duration === 'number' ? object.duration : Number(object.duration)
  if (Number.isFinite(seconds) && seconds > 0) record.durationMs = Math.round(seconds * 1000)
  const artistId = jamendoId(object.artist_id) ?? parent.artistId
  if (artistId !== undefined) record.artistId = artistId
  const artistName = text(object.artist_name) ?? parent.artistName
  if (artistName !== undefined) record.artistName = artistName
  const albumId = jamendoId(object.album_id) ?? parent.albumId
  const albumName = text(object.album_name) ?? parent.albumName
  if (albumId !== undefined && albumName !== undefined) {
    record.albumId = albumId
    record.albumName = albumName
  }
  const position = Number(object.position)
  if (record.albumId !== undefined && Number.isSafeInteger(position) && position > 0) {
    record.position = position
  }
  const date = releaseDate(object.releasedate) ?? parent.releaseDate
  if (date !== undefined) record.releaseDate = date
  const image = httpsUrl(object.image) ?? httpsUrl(object.album_image) ?? parent.image
  if (image !== undefined) record.image = image
  const audio = httpsUrl(object.audio)
  if (audio !== undefined) record.audio = audio
  const licenseUrl = text(object.license_ccurl)
  if (licenseUrl !== undefined) record.licenseUrl = licenseUrl
  return record
}

/** The track of a record. In Music mode it is a song, which plays. */
export function trackOf(record: JamendoTrackRecord): Track {
  const track: Track = {
    id: formatId('jamendo', 'track', record.id),
    source: 'jamendo',
    title: record.name,
    artists:
      record.artistName === undefined
        ? []
        : [
            {
              name: record.artistName,
              ...(record.artistId === undefined
                ? {}
                : { id: formatId('jamendo', 'artist', record.artistId) }),
            },
          ],
    artwork:
      record.image === undefined
        ? []
        : [{ url: record.image, width: JAMENDO_IMAGE_SIZE, height: JAMENDO_IMAGE_SIZE }],
    kind: 'song',
  }
  if (record.albumId !== undefined && record.albumName !== undefined) {
    track.album = { id: formatId('jamendo', 'album', record.albumId), name: record.albumName }
  }
  if (record.durationMs !== undefined) track.durationMs = record.durationMs
  if (record.position !== undefined) track.trackNumber = record.position
  if (record.releaseDate !== undefined) track.releaseDate = record.releaseDate
  return track
}

/** The formats Jamendo streams, best first: its `format` value, codec, container and bitrate. */
const FORMATS: ReadonlyArray<{
  format: string
  codec: Codec
  container: Container
  bitrateKbps?: number
}> = [
  { format: 'flac', codec: 'flac', container: 'flac' },
  // "mp32 (VBR, good quality)": no stated bitrate, so tierOf counts it as normal.
  { format: 'mp32', codec: 'mp3', container: 'mp3' },
  { format: 'ogg', codec: 'vorbis', container: 'ogg' },
  // "mp31 (96kbs)"
  { format: 'mp31', codec: 'mp3', container: 'mp3', bitrateKbps: 96 },
]

/**
 * A track's stream options: FLAC (`lossless`), VBR MP3, Ogg Vorbis and 96 kbps MP3, all from its
 * `audio` URL with the `format` set, best first. They never expire, work from any IP and are
 * `unverified` (nothing probed their end). Empty when the track has no stream URL.
 */
export function streamOptions(record: JamendoTrackRecord): StreamOption[] {
  if (record.audio === undefined) return []
  const audio = new URL(record.audio)
  // The URL Jamendo returns streams the format FXM asked for; without a format to swap, it is the
  // only option.
  const formats = audio.searchParams.has('format') ? FORMATS : FORMATS.slice(0, 1)
  return formats.map(({ format, codec, container, bitrateKbps }) => {
    const url = new URL(audio)
    if (url.searchParams.has('format')) url.searchParams.set('format', format)
    const option: StreamOption = {
      url: url.href,
      codec,
      container,
      media: 'audio',
      tier: tierOf({ codec, ...(bitrateKbps === undefined ? {} : { bitrateKbps }) }),
      protocol: 'progressive',
      ipBound: false,
      fullLength: 'unverified',
    }
    if (bitrateKbps !== undefined) option.bitrateKbps = bitrateKbps
    if (!record.downloadAllowed) option.downloadAllowed = false
    return option
  })
}

/** An album from Jamendo's JSON (`/albums` or `/albums/tracks`), or `null` without an ID. */
export function toAlbum(value: unknown): { album: Album; records: JamendoTrackRecord[] } | null {
  const object = asObject(value)
  const id = jamendoId(object?.id)
  if (object === undefined || id === undefined) return null
  const name = text(object.name) ?? id
  const artistId = jamendoId(object.artist_id)
  const artistName = text(object.artist_name)
  const image = httpsUrl(object.image)
  const date = releaseDate(object.releasedate)
  const album: Album = {
    id: formatId('jamendo', 'album', id),
    source: 'jamendo',
    name,
    artists:
      artistName === undefined
        ? []
        : [
            {
              name: artistName,
              ...(artistId === undefined ? {} : { id: formatId('jamendo', 'artist', artistId) }),
            },
          ],
    artwork:
      image === undefined
        ? []
        : [{ url: image, width: JAMENDO_IMAGE_SIZE, height: JAMENDO_IMAGE_SIZE }],
  }
  if (date !== undefined) album.releaseDate = date
  let records: JamendoTrackRecord[] = []
  if (Array.isArray(object.tracks)) {
    const parent: JamendoParent = { albumId: id, albumName: name }
    if (artistId !== undefined) parent.artistId = artistId
    if (artistName !== undefined) parent.artistName = artistName
    if (image !== undefined) parent.image = image
    if (date !== undefined) parent.releaseDate = date
    records = object.tracks
      .map((track) => toTrackRecord(track, parent))
      .filter((record) => record !== null)
    album.tracks = records.map(trackOf)
    album.trackCount = records.length
  }
  return { album, records }
}

/** An artist from Jamendo's JSON (`/artists` or `/artists/tracks`), or `null` without an ID. */
export function toArtist(value: unknown): { artist: Artist; records: JamendoTrackRecord[] } | null {
  const object = asObject(value)
  const id = jamendoId(object?.id)
  const name = text(object?.name)
  if (object === undefined || id === undefined || name === undefined) return null
  const image = httpsUrl(object.image)
  const artist: Artist = {
    id: formatId('jamendo', 'artist', id),
    source: 'jamendo',
    name,
    artwork: image === undefined ? [] : [{ url: image }],
  }
  let records: JamendoTrackRecord[] = []
  if (Array.isArray(object.tracks)) {
    records = object.tracks
      .map((track) => toTrackRecord(track, { artistId: id, artistName: name }))
      .filter((record) => record !== null)
    artist.topTracks = records.map(trackOf)
  }
  return { artist, records }
}

/** A track's page on Jamendo: the backlink Jamendo's API terms ask apps to show (§4.1). */
export function jamendoTrackUrl(id: string): string {
  return `https://www.jamendo.com/track/${encodeURIComponent(id)}`
}

/** An album's page on Jamendo. */
export function jamendoAlbumUrl(id: string): string {
  return `https://www.jamendo.com/album/${encodeURIComponent(id)}`
}

/** An artist's page on Jamendo. */
export function jamendoArtistUrl(id: string): string {
  return `https://www.jamendo.com/artist/${encodeURIComponent(id)}`
}
