/**
 * Reading what the user picked: the files of a Spotify data export, a playlist file or a link,
 * into a parsed import, and saying why when that fails.
 *
 * @module
 */

import { isFxmError } from '@fxm/core'
import {
  ImportInputError,
  type ImportInputErrorCode,
  type ImportLink,
  isImportInputError,
  MAX_IMPORT_FILE_BYTES,
  type ParsedImport,
  parseExportFiles,
  parsePlaylistFile,
} from '@fxm/sources/import'

/** What an import reads from. */
export type ImportSource = 'export' | 'file' | 'link'

/** A file's bytes. */
async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

/** Thrown for a file too large to read into memory. */
function tooLarge(): ImportInputError {
  return new ImportInputError('too-large', 'The file is too large to import')
}

/**
 * Reads the files of a Spotify data export (its ZIP archive, or the JSON files inside it).
 *
 * @throws ImportInputError, e.g. `not-spotify-export`.
 */
export async function readExportFiles(files: readonly File[]): Promise<ParsedImport> {
  if (files.some((file) => file.size > MAX_IMPORT_FILE_BYTES)) throw tooLarge()
  const inputs = await Promise.all(
    files.map(async (file) => ({ name: file.name, bytes: await bytesOf(file) })),
  )
  return parseExportFiles(inputs)
}

/**
 * Reads one playlist file (CSV, M3U or M3U8).
 *
 * @throws ImportInputError, e.g. `no-title-column`.
 */
export async function readPlaylistFile(file: File): Promise<ParsedImport> {
  if (file.size > MAX_IMPORT_FILE_BYTES) throw tooLarge()
  return parsePlaylistFile({ name: file.name, bytes: await bytesOf(file) })
}

const INPUT_ERRORS: Readonly<Record<ImportInputErrorCode, string>> = {
  empty: 'That file is empty.',
  'too-large': 'That file is too large to import.',
  'no-title-column':
    'That CSV file has no column of song titles. FXM reads Exportify’s columns, and columns named Title, Artist and Album.',
  'no-tracks': 'There are no songs to import there.',
  'not-spotify-export':
    'Those files aren’t from Spotify’s data download. Choose the ZIP file Spotify sent you, or the JSON files inside it.',
  'bad-zip': 'That ZIP file can’t be read. Unpack it, then choose the JSON files inside it.',
  'zip-unsupported':
    'This browser can’t unpack ZIP files. Unpack it, then choose the JSON files inside it.',
  'bad-link':
    'That isn’t a link FXM can import. Paste a link to a Spotify playlist, album or song, or to a YouTube or YouTube Music playlist.',
}

/** Why reading an input failed, for people. */
export function importErrorText(error: unknown, link?: ImportLink): string {
  if (isImportInputError(error)) return INPUT_ERRORS[error.code]
  const service = link?.source === 'youtube' ? 'YouTube' : 'Spotify'
  if (isFxmError(error, 'Unsupported')) {
    return link?.source === 'youtube'
      ? 'YouTube playlists can’t be read in this version of FXM yet, or YouTube can’t be reached from this browser.'
      : 'Spotify can’t be reached right now: it is switched off, or needs FXM Connect in this browser.'
  }
  if (isFxmError(error, 'NotFound')) {
    return 'Nothing is there: the playlist may be private or deleted.'
  }
  if (isFxmError(error, 'RateLimited')) {
    return `${service} asked FXM to slow down. Try again in a few minutes.`
  }
  if (isFxmError(error, 'Network')) {
    return 'That couldn’t be loaded. Check your connection, then try again.'
  }
  return 'That couldn’t be read.'
}
