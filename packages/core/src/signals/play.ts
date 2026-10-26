/**
 * Helpers for building and reading play signals: the share of a track a play played, and the
 * stored shapes of its context and stream, built from what the queue and the player know.
 *
 * @module
 */

import { formatId, sameEntity } from '../ids'
import type { StreamOption } from '../providers'
import type { QueueContext, QueueItem } from '../queue/queue'
import type { PlayContext, PlaySignal, PlayStream } from './signals'

/**
 * The length a play's share is measured against when the track's duration is unknown, as in an
 * imported listening history: about the length of a typical song.
 */
export const ASSUMED_TRACK_MS = 210_000

/**
 * The share of a track's known length a play that reached the end must have played to count as
 * a full listen. Less means it was sought towards the end: Last.fm's rule for a scrobble.
 */
export const COMPLETED_PLAY_SHARE = 0.5

/**
 * The share of the track that a play played, from 0 to 1: `playedMs` over the track's length,
 * or over `assumedDurationMs` when the length is unknown. A completed play counts as all of it
 * (it may have skipped an outro or a gap), unless the track's known length shows it played less
 * than half ({@link COMPLETED_PLAY_SHARE}): seeking to the end is no listen. Bad numbers count
 * as nothing.
 */
export function playedShare(
  play: Pick<PlaySignal, 'playedMs' | 'durationMs' | 'completed'>,
  assumedDurationMs: number = ASSUMED_TRACK_MS,
): number {
  const playedMs = typeof play.playedMs === 'number' && play.playedMs > 0 ? play.playedMs : 0
  const durationMs = play.durationMs
  const known = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
  if (play.completed === true && (!known || playedMs >= durationMs * COMPLETED_PLAY_SHARE)) {
    return 1
  }
  const length = known ? durationMs : assumedDurationMs
  if (!(length > 0)) return 0
  return Math.min(1, playedMs / length)
}

/**
 * The stored form of a queue's context: its type, what it links back to (a radio's seed, a
 * search's query, or the entity or library ID) and its title. `undefined` without a context.
 */
export function playContextOf(context: QueueContext | undefined): PlayContext | undefined {
  if (context === undefined) return undefined
  const { type, title } = context
  switch (context.type) {
    case 'radio':
      return { type, id: context.seed, title }
    case 'search':
      return { type, id: context.query, title }
    default:
      return { type, id: context.id, title }
  }
}

/**
 * What played for a queue item: its audio source and, when the audio is another track (a song
 * matched to a Spotify track, or the song a music video links), that track's ID, plus the
 * stream's codec, container, bitrate, tier and media when the stream is known. The source is the
 * candidate's when the item has one, else the track's own.
 */
export function playStreamOf(
  item: Pick<QueueItem, 'track' | 'candidate'>,
  stream?: StreamOption,
): PlayStream {
  const { track, candidate } = item
  const played: PlayStream = { source: candidate?.source ?? track.source }
  if (candidate !== undefined) {
    try {
      const audioId = formatId(candidate.source, 'track', candidate.ref)
      if (!sameEntity(audioId, track.id)) played.audioId = audioId
    } catch {
      // A candidate without a usable ref names no audio track.
    }
  }
  if (stream === undefined) return played
  played.codec = stream.codec
  played.container = stream.container
  played.tier = stream.tier
  played.media = stream.media
  const { bitrateKbps } = stream
  if (bitrateKbps !== undefined && Number.isFinite(bitrateKbps) && bitrateKbps >= 0) {
    played.bitrateKbps = bitrateKbps
  }
  return played
}
