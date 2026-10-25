/**
 * The Internet Archive source (`archive`): free audio items, FLAC first, as tracks, albums and
 * streams. See the README for what it requests and why.
 *
 * @module
 */

export {
  type ArchiveSearch,
  type ArchiveSearchDoc,
  type ArchiveSearchPage,
  searchQuery,
} from './api'
export { type FlacStreamInfo, parseFlacStreamInfo, probeFlac } from './flac'
export {
  ARCHIVE_ORIGIN,
  type ArchiveFile,
  type ArchiveItem,
  type AudioFormat,
  type AudioGroup,
  audioFormat,
  audioGroups,
  downloadUrl,
  itemPageUrl,
  parseItem,
} from './item'
export {
  type ArchiveSource,
  type ArchiveSourceOptions,
  type ArchiveTrackRef,
  createArchiveSource,
  parseTrackRef,
  trackOf,
} from './provider'
