/**
 * Which queue items SponsorBlock may skip parts of (ARCHITECTURE.md §4): videos, played as
 * themselves, in Music + Video mode. Never songs, never in Music mode.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  modePolicy,
  ownCandidate,
  parseId,
  sameCandidate,
  type Track,
} from '@fxm/core'
import { isVideoId } from './hash'

/** What {@link skippableVideoId} reads of a queue item. A `QueueItem` from `@fxm/core` fits. */
export interface SkippableItem {
  /** The track. */
  readonly track: Track
  /** The audio recorded for it, when it differs from the track's own or was resolved already. */
  readonly candidate?: AudioCandidate
}

/**
 * The YouTube videoId whose non-music parts may be skipped while `item` plays in `mode`, or
 * `undefined` when SponsorBlock must not be asked. That takes all of these:
 *
 * - the mode is Music + Video (`all`);
 * - the track is a video (`video` or `music-video`) from YouTube Music or YouTube, which that
 *   mode plays as itself (`modePolicy` says `playable`);
 * - the audio is the video's own: no candidate, or one for that same video. A song matched to
 *   the track plays instead of it, and the video's segments don't fit that song.
 */
export function skippableVideoId(item: SkippableItem, mode: CatalogMode): string | undefined {
  const { track, candidate } = item
  if (mode !== 'all' || (track.kind !== 'video' && track.kind !== 'music-video')) return undefined
  if (modePolicy(track, mode) !== 'playable') return undefined
  const parts = parseId(track.id)
  if (parts === null || parts.kind !== 'track') return undefined
  if (parts.source !== 'ytm' && parts.source !== 'yt') return undefined
  if (!isVideoId(parts.nativeId)) return undefined
  const own = ownCandidate(track)
  if (candidate !== undefined && (own === undefined || !sameCandidate(candidate, own))) {
    return undefined
  }
  return parts.nativeId
}
