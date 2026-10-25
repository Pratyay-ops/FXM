/**
 * The Jamendo source (`jamendo`): Creative Commons music with FLAC streams, behind a public or
 * user `client_id` and a shared monthly quota. See the README for the request policy and the API
 * terms.
 *
 * @module
 */

export { JAMENDO_API, type JamendoAccess, type JamendoClientKind } from './api'
export {
  IMAGE_SIZE,
  type JamendoTrackRecord,
  jamendoAlbumUrl,
  jamendoArtistUrl,
  jamendoTrackUrl,
  streamOptions,
  toTrackRecord,
} from './map'
export { createJamendoSource, type JamendoSource, type JamendoSourceOptions } from './provider'
export {
  type JamendoBlock,
  type JamendoOutcome,
  JamendoQuota,
  type JamendoQuotaOptions,
  type JamendoQuotaSnapshot,
} from './quota'
