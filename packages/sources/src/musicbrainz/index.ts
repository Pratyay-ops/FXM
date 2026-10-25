/**
 * MusicBrainz: ISRCs and recordings for the matching engine. A helper, not a playback source.
 * See the README for the request policy (one request per second, User-Agent per platform).
 *
 * @module
 */

import { MusicBrainzClient, type MusicBrainzLookups, type MusicBrainzOptions } from './api'

export {
  MUSICBRAINZ_API,
  MUSICBRAINZ_USER_AGENT,
  type MusicBrainzCallOptions,
  type MusicBrainzCredit,
  type MusicBrainzLookups,
  type MusicBrainzOptions,
  type MusicBrainzRecording,
  type MusicBrainzRecordingRef,
  type MusicBrainzReleaseSummary,
  type MusicBrainzSearchHit,
  type RecordingQuery,
} from './api'
export {
  findExactIsrc,
  findExactIsrcs,
  findIsrcHint,
  type IsrcFinding,
  type IsrcHintQuery,
  spotifyTrackUrl,
} from './isrc'
export { QueuePausedError, type RequestPriority, RequestQueue, type RunOptions } from './queue'

/**
 * A MusicBrainz client. Keep one per app: each client keeps its own cache. Every client waits in
 * the app's one shared queue, at most one request per second, unless `options.queue` names
 * another.
 */
export function createMusicBrainzClient(options: MusicBrainzOptions = {}): MusicBrainzLookups {
  return new MusicBrainzClient(options)
}
