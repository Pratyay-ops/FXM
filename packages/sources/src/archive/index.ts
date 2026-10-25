/**
 * The Internet Archive source (`archive`): free audio items, FLAC first, as tracks, albums and
 * streams. See the README for what it requests and why.
 *
 * @module
 */

export type { Attribution } from '../shared/audio-source'
export { itemPageUrl } from './item'
export {
  type ArchiveSource,
  type ArchiveSourceOptions,
  type ArchiveTrackRef,
  createArchiveSource,
  parseTrackRef,
} from './provider'
