/**
 * Internet Archive items: the metadata API's JSON (`/metadata/<identifier>`) as FXM reads it,
 * and the audio files in it, grouped into one track per recording.
 *
 * An audio item holds the files its uploader sent ("original") and the ones the Archive made from
 * them ("derivative", which name their source in `original`): typically a FLAC per song, plus a
 * VBR MP3, an Ogg Vorbis and a 64 kbps MP3 made from it, plus spectrograms and thumbnails. Some
 * uploaders also send a second original per song, such as a 320 kbps MP3 next to the FLAC.
 * {@link audioGroups} puts all of a recording's audio files into one group, and the group's
 * original names the track: `archive:track:<identifier>/<file path>`.
 *
 * @module
 */

import {
  type Codec,
  type Container,
  compareStreams,
  FxmError,
  normalizeIsrc,
  normalizeText,
  tierOf,
} from '@fxm/core'
import { asObject, releaseDate, text } from '../shared/json'

/** Where the Archive serves its files. */
export const ARCHIVE_ORIGIN = 'https://archive.org'

/** One file of an item, with the fields FXM uses. */
export interface ArchiveFile {
  /** The path within the item, e.g. `01_Ghosts_I.flac` or `disc1/track01.flac`. */
  name: string
  /** The Archive's format name, e.g. `Flac`, `24bit Flac`, `VBR MP3`, `Ogg Vorbis`, `PNG`. */
  format: string
  /** Whether the uploader sent it (`original`) or the Archive made it (`derivative`, `metadata`). */
  source: string
  /** For a derivative: the file it was made from. */
  original?: string
  /** Size in bytes. */
  size?: number
  /** Duration in milliseconds. */
  lengthMs?: number
  /** The average bitrate the Archive states, in kbps (MP3s only). */
  bitrateKbps?: number
  /** The title tag. */
  title?: string
  /** The artist (or creator) tag. */
  artist?: string
  /** The album tag. */
  album?: string
  /** The track number, from tags such as `01` or `1/12`. */
  track?: number
  /** The disc number. */
  disc?: number
  /** Width in pixels, for images. */
  width?: number
  /** Height in pixels, for images. */
  height?: number
  /** An ISRC from the file's external identifiers (`urn:isrc:…`), canonical. */
  isrc?: string
  /** Whether the file is private: listed, but not downloadable without permission. */
  private: boolean
}

/** An item, with the fields FXM uses. */
export interface ArchiveItem {
  /** The item's identifier, e.g. `nineinchnails_ghosts_I_IV`. */
  identifier: string
  /** The item's title. */
  title?: string
  /** The creators, main one first. */
  creators: string[]
  /** The item's date, as `Track.releaseDate` holds it (`2008` or `2008-03-02`). */
  date?: string
  /** The licence URL, e.g. a Creative Commons licence. */
  licenseUrl?: string
  /** The media type: `audio`, or `etree` for the Live Music Archive. */
  mediatype?: string
  /**
   * Whether the Archive restricts access (`access-restricted-item`): lending-library and
   * stream-only items, such as the Grateful Dead's soundboard recordings. FXM uses only freely
   * accessible items.
   */
  restricted: boolean
  /** Every file. */
  files: ArchiveFile[]
}

/** A file format FXM can play or download. */
export interface AudioFormat {
  /** The audio codec. */
  codec: Codec
  /** The container. */
  container: Container
  /** Bits per sample, when the format name says (`24bit Flac`). */
  bitDepth?: number
  /** The bitrate the format name states (`320Kbps MP3`). */
  bitrateKbps?: number
}

/** The Archive's names for the audio formats FXM plays, lower-cased. */
const FORMATS: Readonly<Record<string, AudioFormat>> = {
  flac: { codec: 'flac', container: 'flac' },
  '24bit flac': { codec: 'flac', container: 'flac', bitDepth: 24 },
  'vbr mp3': { codec: 'mp3', container: 'mp3' },
  mp3: { codec: 'mp3', container: 'mp3' },
  'ogg vorbis': { codec: 'vorbis', container: 'ogg' },
  opus: { codec: 'opus', container: 'ogg' },
  'ogg opus': { codec: 'opus', container: 'ogg' },
  'apple lossless audio': { codec: 'alac', container: 'm4a' },
  wave: { codec: 'pcm', container: 'wav' },
  aac: { codec: 'aac', container: 'm4a' },
}

/**
 * Audio formats FXM does not play, and other formats whose files are not tracks. Files in these
 * formats never fall back to their extension.
 */
const NOT_PLAYABLE = new Set([
  'shorten',
  'aiff',
  'windows media audio',
  'real audio',
  "monkey's audio",
  'midi',
  'flac fingerprint',
  'checksums',
  'metadata',
])

/** The audio formats FXM knows only by extension, for format names it has not seen. */
const EXTENSIONS: Readonly<Record<string, AudioFormat>> = {
  flac: { codec: 'flac', container: 'flac' },
  mp3: { codec: 'mp3', container: 'mp3' },
  ogg: { codec: 'vorbis', container: 'ogg' },
  oga: { codec: 'vorbis', container: 'ogg' },
  opus: { codec: 'opus', container: 'ogg' },
  wav: { codec: 'pcm', container: 'wav' },
  m4a: { codec: 'aac', container: 'm4a' },
}

/** Audio formats FXM groups but cannot play, so their derivatives still find their group. */
const UNPLAYABLE_AUDIO = new Set(['shorten', 'aiff', 'windows media audio', "monkey's audio"])

/**
 * The audio format of a file, or `undefined` for anything FXM cannot play: images, text, zips,
 * playlists, and audio such as Shorten or AIFF. Known format names decide; for a name FXM does not
 * know, the extension does (`.flac`, `.mp3`, `.ogg`, `.opus`, `.wav`, `.m4a`).
 */
export function audioFormat(file: Pick<ArchiveFile, 'name' | 'format'>): AudioFormat | undefined {
  const format = file.format.trim().toLowerCase()
  const known = FORMATS[format]
  if (known !== undefined && Object.hasOwn(FORMATS, format)) return known
  const kbps = format.match(/^(\d{2,3})kbps mp3$/u)
  if (kbps) return { codec: 'mp3', container: 'mp3', bitrateKbps: Number(kbps[1]) }
  if (NOT_PLAYABLE.has(format) || format.includes('zip') || format.includes('m3u')) return undefined
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? ''
  if (!Object.hasOwn(EXTENSIONS, extension)) return undefined
  const byExtension = EXTENSIONS[extension]
  if (byExtension?.container === 'm4a' && /lossless|alac/u.test(format)) {
    return { codec: 'alac', container: 'm4a' }
  }
  return byExtension
}

/** Whether a file is audio of any kind, playable or not. */
function isAudio(file: ArchiveFile): boolean {
  return audioFormat(file) !== undefined || UNPLAYABLE_AUDIO.has(file.format.trim().toLowerCase())
}

/**
 * Milliseconds from the Archive's `length`: seconds (`168.83`), or `mm:ss` / `h:mm:ss` with
 * optional fractions (`02:48`, `1:02:03.5`). `undefined` when unreadable or not positive.
 */
export function parseLength(value: unknown): number | undefined {
  let seconds = Number.NaN
  if (typeof value === 'number') seconds = value
  else if (typeof value === 'string') {
    const parts = value.trim().split(':')
    if (parts.length <= 3 && parts.every((part) => /^\d+(?:\.\d+)?$/u.test(part))) {
      seconds = parts.reduce((total, part) => total * 60 + Number(part), 0)
    }
  }
  return Number.isFinite(seconds) && seconds > 0 && seconds < 172_800
    ? Math.round(seconds * 1000)
    : undefined
}

/** A positive whole number from a string such as `01`, `1/12` or `12`, else `undefined`. */
function leadingNumber(value: unknown): number | undefined {
  const digits = (typeof value === 'number' ? String(value) : text(value))?.match(/^\d+/u)?.[0]
  const number = digits === undefined ? Number.NaN : Number(digits)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/** A positive number from a numeric string, else `undefined`. */
function positive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(text(value) ?? Number.NaN)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** The strings of a metadata field that may be a string or a list of strings. */
function strings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list.map(text).filter((item) => item !== undefined)
}

/** One file from the metadata API's `files` list, or `null` without a name. */
export function toFile(value: unknown): ArchiveFile | null {
  const object = asObject(value)
  const name = text(object?.name)
  if (object === undefined || name === undefined) return null
  const file: ArchiveFile = {
    name,
    format: text(object.format) ?? '',
    source: text(object.source) ?? '',
    private: object.private === 'true' || object.private === true,
  }
  const original = text(object.original)
  if (original !== undefined) file.original = original
  const size = positive(object.size)
  if (size !== undefined) file.size = size
  const lengthMs = parseLength(object.length)
  if (lengthMs !== undefined) file.lengthMs = lengthMs
  const bitrateKbps = positive(object.bitrate)
  if (bitrateKbps !== undefined) file.bitrateKbps = bitrateKbps
  const title = text(object.title)
  if (title !== undefined) file.title = title
  const artist = text(object.artist) ?? text(object.creator)
  if (artist !== undefined) file.artist = artist
  const album = text(object.album)
  if (album !== undefined) file.album = album
  const track = leadingNumber(object.track)
  if (track !== undefined) file.track = track
  const disc = leadingNumber(object.disc)
  if (disc !== undefined) file.disc = disc
  const width = leadingNumber(object.width)
  if (width !== undefined) file.width = width
  const height = leadingNumber(object.height)
  if (height !== undefined) file.height = height
  for (const id of strings(object['external-identifier'])) {
    const isrc = id.toLowerCase().startsWith('urn:isrc:') ? normalizeIsrc(id.slice(9)) : null
    if (isrc !== null) {
      file.isrc = isrc
      break
    }
  }
  return file
}

/**
 * An item from the metadata API's answer for `identifier`. Rejects with `NotFound` for the
 * empty object the API sends for an unknown item and for a "dark" (withdrawn) one, and with
 * `Parse` for anything that is not an item.
 */
export function parseItem(identifier: string, value: unknown): ArchiveItem {
  const object = asObject(value)
  if (object === undefined) {
    throw new FxmError('Parse', 'The Internet Archive sent item metadata FXM does not understand')
  }
  if (Object.keys(object).length === 0 || object.is_dark === true) {
    throw new FxmError('NotFound', `The Internet Archive has no item ${identifier}`)
  }
  const metadata = asObject(object.metadata)
  if (metadata === undefined || (object.files !== undefined && !Array.isArray(object.files))) {
    throw new FxmError('Parse', 'The Internet Archive sent item metadata FXM does not understand')
  }
  const item: ArchiveItem = {
    identifier: text(metadata.identifier) ?? identifier,
    creators: strings(metadata.creator),
    restricted: metadata['access-restricted-item'] === 'true',
    files: (Array.isArray(object.files) ? object.files : [])
      .map(toFile)
      .filter((file) => file !== null),
  }
  const title = strings(metadata.title)[0]
  if (title !== undefined) item.title = title
  const date = releaseDate(strings(metadata.date)[0]) ?? releaseDate(strings(metadata.year)[0])
  if (date !== undefined) item.date = date
  const licenseUrl = text(metadata.licenseurl)
  if (licenseUrl !== undefined) item.licenseUrl = licenseUrl
  const mediatype = text(metadata.mediatype)
  if (mediatype !== undefined) item.mediatype = mediatype
  return item
}

/** The URL that downloads (or streams) a file of an item. */
export function downloadUrl(identifier: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `${ARCHIVE_ORIGIN}/download/${encodeURIComponent(identifier)}/${encodedPath}`
}

/** The item's page on the Archive, which shows its licence: the link to credit the item with. */
export function itemPageUrl(identifier: string): string {
  return `${ARCHIVE_ORIGIN}/details/${encodeURIComponent(identifier)}`
}

/** A playable file with its format. */
export interface PlayableFile {
  /** The file. */
  file: ArchiveFile
  /** Its format. */
  format: AudioFormat
  /** Its average bitrate in kbps: as stated, from the format name, or from size and length. */
  bitrateKbps?: number
}

/** The audio files of one recording. */
export interface AudioGroup {
  /**
   * The file whose path names the track: the group's original, or the best one when the
   * uploader sent several originals of the recording.
   */
  root: ArchiveFile
  /** The files FXM can play, private ones left out, best first. */
  playable: PlayableFile[]
  /** Every audio file of the group, root first, to read tags from and find the track by. */
  files: ArchiveFile[]
}

/** The bitrate of a playable file, in kbps. */
function bitrateOf(file: ArchiveFile, format: AudioFormat): number | undefined {
  if (file.bitrateKbps !== undefined) return Math.round(file.bitrateKbps)
  if (format.bitrateKbps !== undefined) return format.bitrateKbps
  if (file.size === undefined || file.lengthMs === undefined) return undefined
  return Math.round((file.size * 8) / file.lengthMs)
}

/** The file a derivative was made from, following chains, or the file itself. */
function rootName(file: ArchiveFile, byName: ReadonlyMap<string, ArchiveFile>): string {
  let current = file
  for (let hop = 0; hop < 10 && current.original !== undefined; hop++) {
    const next = byName.get(current.original)
    if (next === undefined) return current.original
    if (next === current) break
    current = next
  }
  return current.name
}

/** Orders playable files best first: by `compareStreams`, then originals, then by name. */
function comparePlayable(a: PlayableFile, b: PlayableFile): number {
  const quality = (entry: PlayableFile) => ({
    tier: tierOf({
      codec: entry.format.codec,
      ...(entry.bitrateKbps === undefined ? {} : { bitrateKbps: entry.bitrateKbps }),
    }),
    ...(entry.bitrateKbps === undefined ? {} : { bitrateKbps: entry.bitrateKbps }),
  })
  return (
    compareStreams(quality(a), quality(b)) ||
    Number(b.file.source === 'original') - Number(a.file.source === 'original') ||
    a.file.name.localeCompare(b.file.name)
  )
}

/** The first value of `field` among the group's files, root first. */
export function groupField<K extends keyof ArchiveFile>(
  group: AudioGroup,
  field: K,
): ArchiveFile[K] | undefined {
  for (const file of group.files) {
    if (file[field] !== undefined) return file[field]
  }
  return undefined
}

/** Whether two groups hold the same recording, sent twice by the uploader in two formats. */
function sameRecording(a: AudioGroup, b: AudioGroup): boolean {
  const titleA = groupField(a, 'title')
  const titleB = groupField(b, 'title')
  const lengthA = groupField(a, 'lengthMs')
  const lengthB = groupField(b, 'lengthMs')
  const trackA = groupField(a, 'track')
  const trackB = groupField(b, 'track')
  return (
    titleA !== undefined &&
    titleB !== undefined &&
    normalizeText(titleA) === normalizeText(titleB) &&
    lengthA !== undefined &&
    lengthB !== undefined &&
    Math.abs(lengthA - lengthB) <= 2000 &&
    (trackA === undefined || trackB === undefined || trackA === trackB) &&
    groupField(a, 'disc') === groupField(b, 'disc')
  )
}

/**
 * The item's recordings, one group each, in album order (disc, then track number, then path).
 * A derivative joins the group of the original it was made from. An uploader's second original
 * of the same recording, such as a 320 kbps MP3 next to the FLAC (same title, track number and
 * disc, lengths within 2 s), joins the better one's group. Groups without a playable public file
 * are left out.
 */
export function audioGroups(item: ArchiveItem): AudioGroup[] {
  const byName = new Map(item.files.map((file) => [file.name, file]))
  const members = new Map<string, ArchiveFile[]>()
  for (const file of item.files) {
    if (!isAudio(file)) continue
    const root = rootName(file, byName)
    const list = members.get(root) ?? []
    list.push(file)
    members.set(root, list)
  }
  const groups: AudioGroup[] = []
  for (const [name, files] of members) {
    const playable = files
      .filter((file) => !file.private)
      .flatMap((file): PlayableFile[] => {
        const format = audioFormat(file)
        if (format === undefined) return []
        const bitrateKbps = bitrateOf(file, format)
        return [{ file, format, ...(bitrateKbps === undefined ? {} : { bitrateKbps }) }]
      })
      .sort(comparePlayable)
    const [best] = playable
    if (best === undefined) continue
    const root = byName.get(name) ?? best.file
    groups.push({ root, playable, files: [root, ...files.filter((file) => file !== root)] })
  }
  // Better groups first, so a duplicate original joins the best one.
  groups.sort((a, b) =>
    comparePlayable(a.playable[0] as PlayableFile, b.playable[0] as PlayableFile),
  )
  const kept: AudioGroup[] = []
  for (const group of groups) {
    const twin = kept.find((other) => sameRecording(other, group))
    if (twin === undefined) {
      kept.push(group)
      continue
    }
    twin.playable = [...twin.playable, ...group.playable].sort(comparePlayable)
    twin.files = [...twin.files, ...group.files]
  }
  const position = (group: AudioGroup) => [
    groupField(group, 'disc') ?? 0,
    groupField(group, 'track') ?? Number.MAX_SAFE_INTEGER,
  ]
  return kept.sort((a, b) => {
    const [discA = 0, trackA = 0] = position(a)
    const [discB = 0, trackB = 0] = position(b)
    return (
      discA - discB ||
      trackA - trackB ||
      a.root.name.localeCompare(b.root.name, undefined, { numeric: true })
    )
  })
}

/** The group that holds the file at `path`, whichever of its files that is. */
export function groupWithFile(groups: readonly AudioGroup[], path: string): AudioGroup | undefined {
  return groups.find((group) => group.files.some((file) => file.name === path))
}

/** A track title from a file path: the file name without extension, `_` read as spaces. */
export function titleFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  return stem.replaceAll('_', ' ').replace(/\s+/gu, ' ').trim() || name
}

/** The item's cover images, largest known first: an uploaded cover, then the item tile. */
export function coverFiles(item: ArchiveItem): ArchiveFile[] {
  return item.files
    .filter(
      (file) =>
        !file.private &&
        file.source === 'original' &&
        /(?:^|\/)(?:cover|folder|front)[^/]*\.(?:jpe?g|png)$/iu.test(file.name),
    )
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || a.name.localeCompare(b.name))
}
