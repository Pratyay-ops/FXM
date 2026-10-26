/**
 * CSV playlist files: Exportify's columns first (see `CLEAN-ROOM.md`), and the usual names other
 * exporters give the same columns. The header row decides which column is what; a file needs at
 * least a column of titles. A column naming the playlist splits the rows into one playlist each.
 *
 * @module
 */

import { ImportInputError } from './errors'
import { catalogTrackId } from './links'
import {
  cleanArtists,
  cleanIsrc,
  cleanReleaseDate,
  cleanText,
  dedupeCollection,
  parseBoolean,
  parseDurationText,
  parseTime,
  spotifyTrackIdFromBareId,
} from './rows'
import { type ImportCollection, type ImportRow, noSkips, type ParsedImport } from './types'

/** The largest CSV file an import reads, in characters. */
export const MAX_CSV_LENGTH = 32 * 1024 * 1024

/** The column separators a CSV file may use, tried in this order. */
const SEPARATORS = [',', ';', '\t', '|'] as const

/**
 * The separator of a CSV file: the one that appears most often, outside quotes, in its first
 * line. A comma when there is none.
 */
export function detectSeparator(text: string): string {
  const counts = new Map<string, number>(SEPARATORS.map((separator) => [separator, 0]))
  let quoted = false
  for (const char of text) {
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === '\n' || char === '\r')) break
    else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1)
  }
  let best: string = ','
  let bestCount = 0
  for (const [separator, count] of counts) {
    if (count > bestCount) {
      best = separator
      bestCount = count
    }
  }
  return best
}

/**
 * Splits CSV text into records of fields, as RFC 4180 describes: fields in double quotes may
 * hold the separator, line breaks and doubled quotes (`""`). Lines may end with CRLF, LF or CR. A
 * leading byte-order mark is dropped, and so are empty lines.
 */
export function parseCsv(text: string, separator = detectSeparator(text)): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let fieldStarted = false
  const endField = () => {
    record.push(field)
    field = ''
    fieldStarted = false
  }
  const endRecord = () => {
    endField()
    if (record.length > 1 || record[0] !== '') records.push(record)
    record = []
  }
  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string
    if (quoted) {
      if (char !== '"') field += char
      else if (source[index + 1] === '"') {
        field += '"'
        index++
      } else quoted = false
    } else if (char === '"' && !fieldStarted) {
      quoted = true
      fieldStarted = true
    } else if (char === separator) endField()
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index++
      endRecord()
    } else {
      field += char
      fieldStarted = true
    }
  }
  if (field !== '' || fieldStarted || record.length > 0) endRecord()
  return records
}

/** What a column holds. */
type Field =
  | 'uri'
  | 'spotifyId'
  | 'title'
  | 'artistList'
  | 'artist'
  | 'album'
  | 'durationMs'
  | 'duration'
  | 'isrc'
  | 'releaseDate'
  | 'label'
  | 'explicit'
  | 'addedAt'
  | 'playlist'

/**
 * Column names, normalized (lower case, single spaces), and what they hold. Exportify writes
 * "Track URI", "Track Name", "Artist Name(s)" (names joined by ", ", with commas inside a name
 * escaped as `\,`), "Album Name", "Album Release Date", "Track Duration (ms)", "Explicit",
 * "ISRC", "Added At" and, with album data, "Label".
 */
const COLUMNS: Readonly<Record<string, Field>> = {
  'track uri': 'uri',
  'spotify uri': 'uri',
  'spotify track uri': 'uri',
  uri: 'uri',
  url: 'uri',
  link: 'uri',
  'track url': 'uri',
  'spotify url': 'uri',
  'youtube url': 'uri',
  'spotify id': 'spotifyId',
  'spotify - id': 'spotifyId',
  'track id': 'spotifyId',
  'track name': 'title',
  'track title': 'title',
  'song name': 'title',
  'song title': 'title',
  name: 'title',
  title: 'title',
  track: 'title',
  song: 'title',
  'artist name(s)': 'artistList',
  'artist names': 'artistList',
  artists: 'artistList',
  'artist name': 'artist',
  artist: 'artist',
  performer: 'artist',
  'album name': 'album',
  'album title': 'album',
  album: 'album',
  'track duration (ms)': 'durationMs',
  'duration (ms)': 'durationMs',
  duration_ms: 'durationMs',
  'duration ms': 'durationMs',
  'length (ms)': 'durationMs',
  duration: 'duration',
  length: 'duration',
  time: 'duration',
  isrc: 'isrc',
  'album release date': 'releaseDate',
  'release date': 'releaseDate',
  release_date: 'releaseDate',
  year: 'releaseDate',
  label: 'label',
  'record label': 'label',
  explicit: 'explicit',
  'explicit?': 'explicit',
  'added at': 'addedAt',
  added_at: 'addedAt',
  'date added': 'addedAt',
  'playlist name': 'playlist',
  playlist: 'playlist',
}

/** A header cell, normalized: lower case, single spaces, without a byte-order mark. */
function normalizeHeader(cell: string): string {
  return cell.replace(/^﻿/u, '').trim().replace(/\s+/gu, ' ').toLowerCase()
}

/** Which column holds each field; the first column of a field wins. */
function mapColumns(header: readonly string[]): Map<Field, number> {
  const columns = new Map<Field, number>()
  header.forEach((cell, index) => {
    const name = normalizeHeader(cell)
    const field = Object.hasOwn(COLUMNS, name) ? COLUMNS[name] : undefined
    if (field !== undefined && !columns.has(field)) columns.set(field, index)
  })
  return columns
}

/**
 * Exportify's list of artist names: joined by commas, with commas inside a name escaped as
 * `\,` ("Tyler\, The Creator, Kali Uchis"). Semicolons separate names too, as other exporters
 * write them.
 */
export function splitArtistList(text: string): string[] {
  const names: string[] = []
  let current = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (char === '\\' && (text[index + 1] === ',' || text[index + 1] === ';')) {
      current += text[index + 1]
      index++
    } else if (char === ',' || char === ';') {
      names.push(current)
      current = ''
    } else current += char
  }
  names.push(current)
  return cleanArtists(names)
}

/** One artist column that is not a list: one name, or several only when split by semicolons. */
function splitArtistCell(text: string): string[] {
  return cleanArtists(text.includes(';') ? text.split(';') : [text])
}

/** The playlist name a file name suggests: "road_trip.csv" → "road trip". */
export function nameFromFileName(fileName: string, fallback: string): string {
  const base = fileName.replace(/^.*[\\/]/u, '').replace(/\.[^.]+$/u, '')
  return cleanText(base.replace(/[_]+/gu, ' '), 100) ?? fallback
}

/**
 * Reads a CSV playlist file into an import: one playlist named after the file (or one per value
 * of a playlist column), with each track once. Rows without a title are skipped and counted.
 *
 * @throws ImportInputError `empty`, `too-large`, `no-title-column` or `no-tracks`.
 */
export function parseCsvImport(text: string, fileName = 'playlist.csv'): ParsedImport {
  if (text.length > MAX_CSV_LENGTH) {
    throw new ImportInputError('too-large', 'The CSV file is too large to import')
  }
  const records = parseCsv(text)
  const [header, ...body] = records
  if (header === undefined) throw new ImportInputError('empty', 'The CSV file is empty')
  const columns = mapColumns(header)
  const titleColumn = columns.get('title')
  if (titleColumn === undefined) {
    throw new ImportInputError('no-title-column', 'The CSV file has no column of song titles')
  }
  const cell = (record: readonly string[], field: Field): string | undefined => {
    const index = columns.get(field)
    return index === undefined ? undefined : record[index]
  }
  const skipped = noSkips()
  const defaultName = nameFromFileName(fileName, 'Imported playlist')
  const groups = new Map<string, ImportRow[]>()
  for (const record of body) {
    const title = cleanText(record[titleColumn])
    if (title === undefined) {
      skipped.unreadable++
      continue
    }
    const row: ImportRow = { title, artists: artistsOf(record, cell) }
    const reference = cell(record, 'uri')
    if (reference !== undefined && /^spotify:local:/u.test(reference.trim())) {
      skipped.localFiles++
      continue
    }
    if (reference !== undefined && /^spotify:(?:episode|show):/u.test(reference.trim())) {
      skipped.episodes++
      continue
    }
    const trackId =
      (reference === undefined ? null : catalogTrackId(reference)) ??
      spotifyTrackIdFromBareId(cell(record, 'spotifyId'))
    if (trackId) row.trackId = trackId
    const album = cleanText(cell(record, 'album'))
    if (album !== undefined) row.album = album
    const durationMs =
      parseDurationText(cell(record, 'durationMs'), 'ms') ??
      parseDurationText(cell(record, 'duration'))
    if (durationMs !== undefined) row.durationMs = durationMs
    const isrc = cleanIsrc(cell(record, 'isrc'))
    if (isrc !== undefined) row.isrc = isrc
    const explicit = parseBoolean(cell(record, 'explicit'))
    if (explicit !== undefined) row.explicit = explicit
    const releaseDate = cleanReleaseDate(cell(record, 'releaseDate'))
    if (releaseDate !== undefined) row.releaseDate = releaseDate
    const label = cleanText(cell(record, 'label'))
    if (label !== undefined) row.label = label
    const addedAt = parseTime(cell(record, 'addedAt'))
    if (addedAt !== undefined) row.addedAt = addedAt
    const playlist = cleanText(cell(record, 'playlist'), 100) ?? defaultName
    const group = groups.get(playlist)
    if (group) group.push(row)
    else groups.set(playlist, [row])
  }
  const collections: ImportCollection[] = [...groups].map(([name, rows]) =>
    dedupeCollection({ name, rows }, skipped),
  )
  if (collections.every((collection) => collection.rows.length === 0)) {
    throw new ImportInputError('no-tracks', 'The CSV file lists no songs')
  }
  return {
    kind: 'csv',
    label: fileName.replace(/^.*[\\/]/u, ''),
    collections,
    plays: [],
    follows: [],
    skipped,
  }
}

/** A row's artists: Exportify's list column, else a plain artist column. */
function artistsOf(
  record: readonly string[],
  cell: (record: readonly string[], field: Field) => string | undefined,
): string[] {
  const list = cell(record, 'artistList')
  if (list !== undefined && list.trim() !== '') return splitArtistList(list)
  const single = cell(record, 'artist')
  return single === undefined ? [] : splitArtistCell(single)
}
