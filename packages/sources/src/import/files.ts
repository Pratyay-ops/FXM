/**
 * Turning the files a user picked into an import: a Spotify data export (its ZIP archive as
 * downloaded, or the JSON files inside it), or one playlist file (CSV, M3U or M3U8). Takes bytes,
 * so it runs wherever the files come from (a file picker, a test).
 *
 * @module
 */

import { MAX_CSV_LENGTH, parseCsvImport } from './csv'
import { ImportInputError } from './errors'
import { decodeText, parseM3uImport } from './m3u'
import { type ExportFile, isWantedExportFile, parseSpotifyExport } from './spotify-export'
import type { ParsedImport } from './types'
import { isZip, readZip } from './zip'

/** A file the user picked. */
export interface ImportFileInput {
  /** Its name, e.g. `my_spotify_data.zip` or `road_trip.csv`. */
  name: string
  /** Its bytes. */
  bytes: Uint8Array
}

/** The largest file an import reads, in bytes: a ZIP of the extended streaming history fits. */
export const MAX_IMPORT_FILE_BYTES = 512 * 1024 * 1024

/** The largest playlist file an import reads, in bytes. */
export const MAX_PLAYLIST_FILE_BYTES = MAX_CSV_LENGTH

function checkSize(file: ImportFileInput, max: number): void {
  if (file.bytes.length > max) {
    throw new ImportInputError('too-large', `${file.name} is too large to import`)
  }
}

/**
 * Reads the files of a Spotify data export: ZIP archives as Spotify sends them (only the files
 * an import uses are unpacked), and JSON files from inside them, in any mix.
 *
 * @throws ImportInputError, e.g. `not-spotify-export`, `bad-zip`, `zip-unsupported`.
 */
export async function parseExportFiles(files: readonly ImportFileInput[]): Promise<ParsedImport> {
  const exportFiles: ExportFile[] = []
  for (const file of files) {
    checkSize(file, MAX_IMPORT_FILE_BYTES)
    if (isZip(file.bytes) || /\.zip$/iu.test(file.name)) {
      const unpacked = await readZip(file.bytes, { want: isWantedExportFile })
      for (const entry of unpacked) {
        exportFiles.push({ name: entry.name, text: new TextDecoder().decode(entry.bytes) })
      }
    } else if (isWantedExportFile(file.name)) {
      exportFiles.push({ name: file.name, text: new TextDecoder().decode(file.bytes) })
    }
  }
  return parseSpotifyExport(exportFiles)
}

/**
 * Reads one playlist file: M3U and M3U8 by their extension (or an `#EXTM3U` header), CSV
 * otherwise.
 *
 * @throws ImportInputError, e.g. `no-title-column`, `no-tracks`, `too-large`.
 */
export function parsePlaylistFile(file: ImportFileInput): ParsedImport {
  checkSize(file, MAX_PLAYLIST_FILE_BYTES)
  const text = decodeText(file.bytes)
  const isM3u = /\.m3u8?$/iu.test(file.name) || /^﻿?#EXTM3U/u.test(text)
  return isM3u ? parseM3uImport(text, file.name) : parseCsvImport(text, file.name)
}
