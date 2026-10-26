/**
 * M3U and M3U8 playlist files. Each entry is a path or URL line, optionally after an `#EXTINF`
 * line with the length in seconds and a display title ("Artist - Title"); `#PLAYLIST` names the
 * playlist, and `#EXTALB` and `#EXTART` give an entry's album and artist. Spotify and YouTube
 * links name their catalog track; for files, the title and artist come from `#EXTINF`, else from
 * the file name ("01 - Artist - Title.mp3") and its folders ("Artist/Album/…").
 *
 * The text must be decoded already: `.m3u8` files are UTF-8, and plain `.m3u` files are often
 * Windows-1252 (see `decodeText`).
 *
 * @module
 */

import { nameFromFileName } from './csv'
import { ImportInputError } from './errors'
import { catalogTrackId } from './links'
import { cleanArtists, cleanDuration, cleanText, dedupeCollection } from './rows'
import { type ImportRow, noSkips, type ParsedImport } from './types'

/** The largest M3U file an import reads, in characters. */
export const MAX_M3U_LENGTH = 16 * 1024 * 1024

/** Audio and video file extensions, dropped from a file name before it is read as a title. */
const MEDIA_EXTENSION =
  /\.(?:mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wma|aiff?|alac|ape|wv|mp4|webm|mka|mkv|mpc)$/iu

/**
 * Folder names that say where music is kept, not who made it: a file right inside one of them
 * names no artist by its folders.
 */
const GENERIC_FOLDERS = new Set([
  'music',
  'my music',
  'musik',
  'musique',
  'música',
  'audio',
  'songs',
  'media',
  'downloads',
  'download',
  'documents',
  'desktop',
  'home',
  'users',
  'user',
  'storage',
  'emulated',
  'sdcard',
  'volumes',
  'mnt',
  'itunes',
  'itunes media',
  'playlists',
])

/** Splits "Artist - Title" (or "Artist – Title") at its first separator. */
function splitDisplay(display: string): { artist?: string; title: string } {
  const match = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(display)
  if (!match) return { title: display }
  const [, artist = '', title = ''] = match
  return { artist: artist.trim(), title: title.trim() }
}

/**
 * The folders and file name of a local path or file URL, without empty segments and drive
 * letters. The `.` and `..` of a relative path are resolved, never read as folder names: `..`
 * drops the folder before it, and one above the path's start is left out.
 */
function pathSegments(location: string): string[] {
  let path = location
  if (/^file:/iu.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      path = path.replace(/^file:\/*/iu, '/')
    }
  }
  const segments: string[] = []
  for (const segment of path.split(/[\\/]/u)) {
    if (segment === '' || segment === '.' || /^[A-Za-z]:$/u.test(segment)) continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments
}

/**
 * A leading track number, which a file name's title does not include: a zero-padded one ("01 ",
 * "007 "), a disc and track pair ("1-02 ", "2.07 "), or any number followed by a separator ("7. ",
 * "12 - ", "3) ", "05_"). A bare number and a space stays, since it is usually part of the title
 * ("99 Problems", "7 Rings").
 */
const TRACK_NUMBER =
  /^(?:\d{1,2}[-.]\d{1,3}(?:\s*[-.)_]\s*|\s+)|0\d{1,2}(?:\s*[-.)_]\s*|\s+)|\d{1,3}\s*[-.)_]\s*)/u

/**
 * What a file name says: its title, and its artist when written "Artist - Title". A leading
 * track number (see {@link TRACK_NUMBER}) is dropped, and so is the extension.
 */
export function describeFileName(name: string): { artist?: string; title: string } | undefined {
  const base = name.replace(MEDIA_EXTENSION, '')
  const numbered = base.replace(TRACK_NUMBER, '')
  // A name that is only a number ("1999.mp3") is its own title.
  const clean = cleanText((cleanText(numbered) === undefined ? base : numbered).replace(/_/gu, ' '))
  return clean === undefined ? undefined : splitDisplay(clean)
}

/** The `#EXTINF` line's length (seconds; `-1` for unknown) and display text. */
function parseExtinf(line: string): { durationMs?: number; display?: string } {
  const body = line.slice('#EXTINF:'.length)
  const comma = indexOfDisplayComma(body)
  const head = comma < 0 ? body : body.slice(0, comma)
  const display = comma < 0 ? undefined : cleanText(body.slice(comma + 1))
  const seconds = Number.parseFloat(head.trim().split(/\s+/u)[0] ?? '')
  const durationMs = seconds > 0 ? cleanDuration(seconds * 1000) : undefined
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(display === undefined ? {} : { display }),
  }
}

/** The comma that ends `#EXTINF`'s attributes, outside the quotes of attribute values. */
function indexOfDisplayComma(body: string): number {
  let quoted = false
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) return index
  }
  return -1
}

/**
 * Reads an M3U or M3U8 playlist into an import: one playlist, named by `#PLAYLIST` or after the
 * file, with each track once. Entries with neither a usable title nor a catalog link are
 * skipped and counted.
 *
 * @throws ImportInputError `empty`, `too-large` or `no-tracks`.
 */
export function parseM3uImport(text: string, fileName = 'playlist.m3u'): ParsedImport {
  if (text.length > MAX_M3U_LENGTH) {
    throw new ImportInputError('too-large', 'The playlist file is too large to import')
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = source.split(/\r\n|\r|\n/u).map((line) => line.trim())
  if (lines.every((line) => line === '')) {
    throw new ImportInputError('empty', 'The playlist file is empty')
  }
  const skipped = noSkips()
  const rows: ImportRow[] = []
  let name: string | undefined
  let pending: { durationMs?: number; display?: string; album?: string; artist?: string } = {}
  for (const line of lines) {
    if (line === '') continue
    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) pending = { ...pending, ...parseExtinf(line) }
      else if (line.startsWith('#PLAYLIST:')) name = cleanText(line.slice(10), 100) ?? name
      else if (line.startsWith('#EXTALB:')) {
        const album = cleanText(line.slice(8))
        if (album !== undefined) pending.album = album
      } else if (line.startsWith('#EXTART:')) {
        const artist = cleanText(line.slice(8))
        if (artist !== undefined) pending.artist = artist
      }
      continue
    }
    const row = rowFromEntry(line, pending)
    pending = {}
    if (row === undefined) skipped.unreadable++
    else rows.push(row)
  }
  const collection = dedupeCollection(
    { name: name ?? nameFromFileName(fileName, 'Imported playlist'), rows },
    skipped,
  )
  if (collection.rows.length === 0) {
    throw new ImportInputError('no-tracks', 'The playlist file lists no songs')
  }
  return {
    kind: 'm3u',
    label: fileName.replace(/^.*[\\/]/u, ''),
    collections: [collection],
    plays: [],
    follows: [],
    skipped,
  }
}

/** The row for one entry line, with what the `#EXT…` lines before it said. */
function rowFromEntry(
  location: string,
  info: { durationMs?: number; display?: string; album?: string; artist?: string },
): ImportRow | undefined {
  const trackId = catalogTrackId(location) ?? undefined
  const fromDisplay = info.display === undefined ? undefined : splitDisplay(info.display)
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//iu.test(location) && !/^file:/iu.test(location)
  const segments = isUrl ? [] : pathSegments(location)
  const fromFile = segments.length === 0 ? undefined : describeFileName(segments.at(-1) as string)
  const title = cleanText(fromDisplay?.title ?? fromFile?.title)
  if (title === undefined) {
    // A catalog link needs no title of its own: the import loads the track.
    return trackId === undefined ? undefined : { title: '', artists: [], trackId, location }
  }
  // "Artist/Album/01 Title.mp3": the folders name the artist and the album, unless the title
  // came with an artist or the folders are only the usual places music is kept.
  const named = info.artist ?? fromDisplay?.artist ?? fromFile?.artist
  const folders =
    named === undefined && fromDisplay === undefined && segments.length >= 3
      ? { artist: segments.at(-3) as string, album: segments.at(-2) as string }
      : undefined
  const useFolders =
    folders !== undefined &&
    !GENERIC_FOLDERS.has(folders.artist.toLowerCase()) &&
    !GENERIC_FOLDERS.has(folders.album.toLowerCase())
  const artist = named ?? (useFolders ? folders?.artist : undefined)
  const row: ImportRow = { title, artists: cleanArtists(artist === undefined ? [] : [artist]) }
  const album = info.album ?? (useFolders ? folders?.album : undefined)
  const cleanAlbum = cleanText(album)
  if (cleanAlbum !== undefined) row.album = cleanAlbum
  if (info.durationMs !== undefined) row.durationMs = info.durationMs
  if (trackId !== undefined) row.trackId = trackId
  const shownLocation = cleanText(location, 1000)
  if (shownLocation !== undefined) row.location = shownLocation
  return row
}

/**
 * Decodes the bytes of a text file: UTF-8 when they are valid UTF-8 (a byte-order mark is
 * dropped), else Windows-1252, the usual encoding of plain `.m3u` files written on Windows.
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}
