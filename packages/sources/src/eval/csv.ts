/**
 * Inputs from an Exportify-style CSV, the owner's own export of a Spotify playlist: one group
 * per row, with the `csv` input as the row gives it (title with Spotify's suffixes, artists,
 * album, duration, ISRC, label, release date, explicit mark), so the evaluation can run on the
 * owner's own music as well as on the public charts.
 *
 * Exportify's columns changed over the years; the parser accepts the names of each version it
 * knows (`Track URI` or `Spotify ID`, `Artist Name(s)` or `Artist Name`, `Track Duration (ms)`
 * or `Duration (ms)`, …) in any order, and leaves out what a version lacks.
 *
 * @module
 */

import { type MatchSource, matchingEval, normalizeIsrc } from '@fxm/core'
import { parseCsv } from './review'
import type { PoolTrack } from './store'

type EvalGroup = matchingEval.EvalGroup

/** The column names each field may have, lower case. */
const COLUMNS = {
  uri: ['track uri', 'spotify uri', 'uri'],
  id: ['spotify id', 'track id', 'id'],
  title: ['track name', 'name', 'title'],
  artists: ['artist name(s)', 'artist name', 'artists', 'artist'],
  album: ['album name', 'album'],
  releaseDate: ['album release date', 'release date'],
  durationMs: ['track duration (ms)', 'duration (ms)', 'duration_ms'],
  explicit: ['explicit'],
  popularity: ['popularity'],
  isrc: ['isrc'],
  label: ['record label', 'label'],
} as const

type Field = keyof typeof COLUMNS

/** One row of the CSV, read. */
export interface CsvRow {
  /** The row's number, from 1 after the header. */
  row: number
  /** The base62 Spotify ID, when the row has a track URI or ID. */
  spotifyId?: string
  /** What the matcher is given. */
  source: MatchSource
  /** Spotify's popularity, when the export has it. */
  popularity?: number
}

/**
 * Splits Exportify's artist cell. Exportify joins names with a bare comma, so a comma followed
 * by a space stays inside a name ("Tyler, The Creator").
 */
export function splitArtists(cell: string): string[] {
  return cell
    .split(/,(?! )/u)
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/** A base62 Spotify ID from a URI, URL or bare ID. */
function spotifyIdOf(value: string | undefined): string | undefined {
  const match = /(?:^|[:/])([0-9A-Za-z]{22})(?:$|[?#])/u.exec(value?.trim() ?? '')
  return match?.[1]
}

/**
 * Reads an Exportify-style CSV. Rows without a title or an artist are skipped; a cell that does
 * not parse (a duration that is not a number, an ISRC that is not one) is left out.
 */
export function parseExportifyCsv(text: string): CsvRow[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/u, ''))
  if (header === undefined) return []
  const names = header.map((name) => name.trim().toLowerCase())
  const index = Object.fromEntries(
    (Object.keys(COLUMNS) as Field[]).map((field) => [
      field,
      names.findIndex((name) => (COLUMNS[field] as readonly string[]).includes(name)),
    ]),
  ) as Record<Field, number>
  const cell = (fields: readonly string[], field: Field): string | undefined => {
    const at = index[field]
    const value = at < 0 ? undefined : fields[at]?.trim()
    return value === '' ? undefined : value
  }
  const result: CsvRow[] = []
  rows.forEach((fields, rowIndex) => {
    const title = cell(fields, 'title')
    const artists = splitArtists(cell(fields, 'artists') ?? '')
    if (title === undefined || artists.length === 0) return
    const source: MatchSource = { title, artists: artists.map((name) => ({ name })) }
    const album = cell(fields, 'album')
    if (album !== undefined) source.album = { name: album }
    const duration = Number(cell(fields, 'durationMs'))
    if (Number.isFinite(duration) && duration > 0) source.durationMs = Math.round(duration)
    const isrc = normalizeIsrc(cell(fields, 'isrc'))
    if (isrc !== null) {
      source.isrc = isrc
      source.isrcOrigin = 'catalog'
    }
    const explicit = cell(fields, 'explicit')?.toLowerCase()
    if (explicit === 'true' || explicit === 'false') source.explicit = explicit === 'true'
    const releaseDate = cell(fields, 'releaseDate')
    if (releaseDate !== undefined && /^\d{4}(?:-\d{2}){0,2}$/u.test(releaseDate)) {
      source.releaseDate = releaseDate
    }
    const label = cell(fields, 'label')
    if (label !== undefined) source.label = label
    const row: CsvRow = { row: rowIndex + 1, source }
    const spotifyId = spotifyIdOf(cell(fields, 'uri')) ?? spotifyIdOf(cell(fields, 'id'))
    if (spotifyId !== undefined) row.spotifyId = spotifyId
    const popularity = Number(cell(fields, 'popularity'))
    if (cell(fields, 'popularity') !== undefined && Number.isInteger(popularity)) {
      row.popularity = popularity
    }
    result.push(row)
  })
  return result
}

/** A CSV row's group ID: `csv:<Spotify ID>`, or `csv:row-<n>` without one. */
export function csvGroupId(row: CsvRow): string {
  return row.spotifyId === undefined ? `csv:row-${row.row}` : `csv:${row.spotifyId}`
}

/** A CSV row as a pool track, for the data-export and MusicBrainz inputs. */
export function poolTrackOfRow(row: CsvRow): PoolTrack | undefined {
  if (row.spotifyId === undefined) return undefined
  const { source } = row
  const track: PoolTrack = {
    id: row.spotifyId,
    title: source.title,
    artists: source.artists.map((artist) => artist.name),
  }
  if (source.album !== undefined) track.album = source.album.name
  if (source.durationMs !== undefined) track.durationMs = source.durationMs
  if (source.explicit !== undefined) track.explicit = source.explicit
  if (source.releaseDate !== undefined) track.releaseDate = source.releaseDate
  return track
}

/**
 * A group for a CSV row: the `csv` input, its categories, its split, and the Spotify ID for
 * MusicBrainz's exact path. The data-export and MusicBrainz inputs follow once MusicBrainz has
 * answered (as for Spotify's tracks).
 *
 * @param file The CSV's name, for the provenance.
 */
export function csvGroup(row: CsvRow, file: string, today: string): EvalGroup {
  const id = csvGroupId(row)
  const group: EvalGroup = {
    id,
    split: matchingEval.splitOf(id),
    categories: matchingEval.categoriesOfInput({
      title: row.source.title,
      artists: row.source.artists.map((artist) => artist.name),
      ...(row.source.album === undefined ? {} : { album: row.source.album.name }),
      ...(row.popularity === undefined ? {} : { popularity: row.popularity }),
    }),
    provenance: [`${file} row ${row.row}, read ${today}`],
    variants: [{ slice: 'csv', source: row.source }],
  }
  if (row.spotifyId !== undefined) {
    group.spotify = {
      id: row.spotifyId,
      ...(row.popularity === undefined ? {} : { popularity: row.popularity }),
    }
  }
  return group
}
