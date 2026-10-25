/**
 * Scrobbling to ListenBrainz and Last.fm, opt-in, with an offline queue: the plays the
 * listening signals report become listens on the user's own profiles.
 *
 * ```ts
 * import {
 *   createMemoryScrobbleStore,
 *   ListenBrainzScrobbleClient,
 *   listenBrainzTarget,
 *   Scrobbler,
 * } from '@fxm/sources/scrobble'
 *
 * const listenbrainz = new ListenBrainzScrobbleClient(token)
 * const scrobbler = new Scrobbler({
 *   store: createMemoryScrobbleStore(),
 *   targets: () => [listenBrainzTarget(listenbrainz)],
 *   context: () => ({ fetch }),
 * })
 * scrobbler.playStarted({ track })                                  // now playing
 * await scrobbler.playEnded({ track, at, playedMs, durationMs })    // queued, then sent
 * ```
 *
 * @module
 */

export { ScrobbleError, type ScrobbleFailure, scrobbleFailureOf } from './errors'
export {
  isLastfmKey,
  LASTFM_API_ACCOUNT_URL,
  LASTFM_API_URL,
  LASTFM_APPLICATIONS_URL,
  LASTFM_AUTHORIZE_URL,
  LASTFM_BATCH_SIZE,
  LASTFM_ERRORS,
  type LastfmClientOptions,
  type LastfmCredentials,
  LastfmScrobbleClient,
  type LastfmSession,
  lastfmFailureOf,
  lastfmSignature,
  lastfmTarget,
} from './lastfm'
export {
  isListenBrainzToken,
  LISTENBRAINZ_API_URL,
  LISTENBRAINZ_BATCH_SIZE,
  LISTENBRAINZ_SETTINGS_URL,
  type ListenBrainzClientOptions,
  ListenBrainzScrobbleClient,
  type ListenPayload,
  listenBrainzTarget,
  listenOf,
  type TokenCheck,
} from './listenbrainz'
export {
  LASTFM_RULES,
  LISTENBRAINZ_RULES,
  qualifiesForScrobble,
  SCROBBLE_LISTEN_CAP_MS,
  type ScrobbleRules,
  scrobbleThresholdMs,
} from './rules'
export {
  MAX_QUEUED_SCROBBLES,
  type PlayStart,
  Scrobbler,
  type ScrobblerOptions,
  type ScrobbleServiceStatus,
} from './scrobbler'
export { createMemoryScrobbleStore, type ScrobbleStore, type StoredScrobble } from './store'
export type { ScrobbleTarget, SubmitReport } from './target'
export { sanitizeScrobble, scrobbleOf, scrobbleTrackOf } from './track'
export {
  SCROBBLE_SERVICE_NAMES,
  SCROBBLE_SERVICES,
  type Scrobble,
  type ScrobbleContext,
  type ScrobblePlay,
  type ScrobbleServiceId,
  type ScrobbleTrack,
} from './types'
