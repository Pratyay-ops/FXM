/**
 * Imports: Spotify's "Download your data" export, CSV (Exportify's columns) and M3U playlist
 * files, Spotify playlist, album and track links, and YouTube and YouTube Music playlists. Each
 * becomes playlists of the library; the matching engine of `@fxm/core` finds every row's song in
 * the user's catalog mode, paced by the shared request budget, and an import resumes where it
 * stopped. A data export's listening history becomes listening signals.
 *
 * ```ts
 * import { createImportState, parseExportFiles, runImport } from '@fxm/sources/import'
 *
 * const parsed = await parseExportFiles([{ name: file.name, bytes }])
 * const state = createImportState(parsed.kind, 'music', parsed.collections[0])
 * const end = await runImport(state, environment, sink, { signal })
 * ```
 *
 * See the README in this folder for the whole flow, and `CLEAN-ROOM.md` for the file formats.
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
export {
  type ImportSpotify,
  type LoadOptions,
  loadLinkImport,
  loadSpotifyImport,
  loadYouTubeImport,
  PAGE_SPACING_MS,
  rowFromTrack,
} from './load'
export { type ImportMusicBrainz, MUSICBRAINZ_BATCH, wantsLookup } from './lookup'
export { decodeText, describeFileName, MAX_M3U_LENGTH, parseM3uImport } from './m3u'
export {
  candidateTrackId,
  MAX_ALTERNATIVES,
  type MatchRowInput,
  matchRow,
  matchSourceOf,
  needsLoad,
  planRow,
  type RowPlan,
  trackOfCandidate,
} from './match'
export {
  csvField,
  type ImportReport,
  type ImportReportMatch,
  type ImportReportRow,
  type ImportReportTotals,
  importReport,
  reportToCsv,
  reportToJson,
} from './report'
export { catalogTrackOf, MAX_IMPORT_ROWS } from './rows'
export {
  type CachedMatch,
  type ImportEnvironment,
  type ImportMatchDecision,
  type ImportRunEnd,
  type ImportRunStatus,
  type ImportSink,
  type RunImportOptions,
  runImport,
} from './run'
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
  applyReview,
  createImportState,
  firstPendingRow,
  type ImportCounts,
  importCounts,
  initialPlaylistTracks,
  isLikelyMatch,
  needsReview,
  nextPlaylistTrack,
  playlistTrackIdOf,
  type ReviewDecision,
  type ReviewEffect,
  type RowStatus,
  retryFailedRows,
  rowStatus,
  sanitizeImportState,
} from './state'
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
export {
  createYouTubeImport,
  type ImportYouTube,
  MATCH_SEARCH_LIMIT,
  YOUTUBE_IMPORT_UNAVAILABLE,
  YOUTUBE_UNAVAILABLE_MESSAGE,
  type YouTubeImportProvider,
  type YouTubeImportProviders,
} from './youtube'
export { isZip, type ReadZipOptions, readZip, type ZipFile } from './zip'
