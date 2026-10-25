/**
 * MusicBrainz: ISRCs and recordings for the matching engine. A helper, not a playback source.
 * See the README for the request policy (one request per second, User-Agent per platform).
 *
 * @module
 */

import { MusicBrainzClient, type MusicBrainzOptions } from './api'

export {
  MUSICBRAINZ_API,
  MUSICBRAINZ_USER_AGENT,
  MusicBrainzClient,
  type MusicBrainzCredit,
  type MusicBrainzOptions,
  type MusicBrainzRecording,
  type MusicBrainzReleaseSummary,
  type MusicBrainzSearchHit,
  musicBrainzQueue,
  type RecordingQuery,
} from './api'
export {
  findExactIsrc,
  findExactIsrcs,
  findIsrcHint,
  type IsrcFinding,
  spotifyTrackUrl,
} from './isrc'
export { RequestQueue } from './queue'

/** A MusicBrainz client that waits in the app's shared queue unless `options.queue` says not. */
export function createMusicBrainzClient(options: MusicBrainzOptions = {}): MusicBrainzClient {
  return new MusicBrainzClient(options)
}
