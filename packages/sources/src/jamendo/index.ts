/**
 * The Jamendo source (`jamendo`): Creative Commons music with FLAC streams, behind a public or
 * user `client_id` and a shared monthly quota. See the README for the request policy and the API
 * terms.
 *
 * @module
 */

export type { Attribution } from '../shared/audio-source'
export type { JamendoAccess, JamendoClientKind } from './api'
export { jamendoAlbumUrl, jamendoArtistUrl, jamendoTrackUrl } from './map'
export { createJamendoSource, type JamendoSource, type JamendoSourceOptions } from './provider'
export {
  type JamendoBlock,
  type JamendoBlockReason,
  JamendoQuota,
  type JamendoQuotaOptions,
  type JamendoQuotaSnapshot,
} from './quota'
