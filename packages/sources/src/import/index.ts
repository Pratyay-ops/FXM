/**
 * Imports: Spotify's "Download your data" export, CSV (Exportify's columns) and M3U playlist
 * files, Spotify playlist, album and track links, and YouTube and YouTube Music playlists. Each
 * becomes playlists of the library; the matching engine of `@fxm/core` finds every row's song in
 * the user's catalog mode, paced by the shared request budget, and an import resumes where it
 * stopped. A data export's listening history becomes listening signals.
 *
 * ```ts
 * import { parseExportFiles, parsePlaylistFile } from '@fxm/sources/import'
 *
 * const parsed = await parseExportFiles([{ name: file.name, bytes }])
 * ```
 *
 * See `CLEAN-ROOM.md` for the file formats.
 *
 * @module
 */

export { detectSeparator, MAX_CSV_LENGTH, parseCsv, parseCsvImport, splitArtistList } from './csv'
export { ImportInputError, type ImportInputErrorCode, isImportInputError } from './errors'
export {
  type ImportFileInput,
  MAX_IMPORT_FILE_BYTES,
  MAX_PLAYLIST_FILE_BYTES,
  parseExportFiles,
  parsePlaylistFile,
} from './files'
export {
  catalogTrackId,
  type ImportLink,
  parseImportLink,
  youtubePlaylistId,
  youtubeTrackId,
} from './links'
export { decodeText, describeFileName, MAX_M3U_LENGTH, parseM3uImport } from './m3u'
export { catalogTrackOf, MAX_IMPORT_ROWS } from './rows'
export {
  type ExportFile,
  type ExportFileKind,
  exportFileKind,
  isWantedExportFile,
  LIKED_SONGS_NAME,
  MAX_EXPORT_FILE_LENGTH,
  parseEndTime,
  parseSpotifyExport,
} from './spotify-export'
export {
  type CandidateExtras,
  IMPORT_KINDS,
  IMPORT_STATE_VERSION,
  type ImportCollection,
  type ImportKind,
  type ImportPlay,
  type ImportRow,
  type ImportSkips,
  type ImportState,
  MIN_PLAY_MS,
  noSkips,
  type ParsedImport,
  ROW_OUTCOMES,
  type RowLookup,
  type RowOutcome,
  type RowResult,
  type RowReview,
  type StoredRow,
} from './types'
export { isZip, type ReadZipOptions, readZip, type ZipFile } from './zip'
