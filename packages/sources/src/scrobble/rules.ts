/**
 * When a play counts as a listen, by the rules Last.fm and ListenBrainz publish: the track was
 * heard for half its length or for 4 minutes, whichever comes first. Last.fm also wants the
 * track to be longer than 30 seconds; ListenBrainz sets no minimum.
 *
 * "Heard" is listening time, as the play recorder measures it: pauses and the parts skipped
 * with a seek never count, so seeking to the end of a song doesn't scrobble it.
 *
 * @module
 */

import type { ScrobblePlay } from './types'

/** The most listening any play needs to count: 4 minutes, however long the track. */
export const SCROBBLE_LISTEN_CAP_MS = 240_000

/** What one service asks of a play before it counts as a listen. */
export interface ScrobbleRules {
  /** The track must be longer than this, in milliseconds; 0 when the service sets no minimum. */
  readonly minTrackMs: number
}

/** Last.fm: "The track must be longer than 30 seconds", then half of it or 4 minutes. */
export const LASTFM_RULES: ScrobbleRules = Object.freeze({ minTrackMs: 30_000 })

/** ListenBrainz: half the track or 4 minutes, whichever is lower, with no minimum length. */
export const LISTENBRAINZ_RULES: ScrobbleRules = Object.freeze({ minTrackMs: 0 })

/** The longest length FXM believes: ListenBrainz's own limit, 24 days. */
const MAX_LENGTH_MS = 2_073_600_000

/** `value` when it is a believable length in milliseconds, else `undefined`. */
export function validLengthMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_LENGTH_MS
    ? value
    : undefined
}

/** The track's length for a play: as the player knew it, else as its metadata says. */
export function playLengthMs(
  play: Pick<ScrobblePlay, 'durationMs'> & { track?: { durationMs?: number } },
): number | undefined {
  return validLengthMs(play.durationMs) ?? validLengthMs(play.track?.durationMs)
}

/**
 * How long a track of `lengthMs` must be heard to count: half of it, at most 4 minutes. With
 * an unknown length, the whole 4 minutes, which every rule accepts whatever the length.
 */
export function scrobbleThresholdMs(lengthMs?: number): number {
  const length = validLengthMs(lengthMs)
  return length === undefined
    ? SCROBBLE_LISTEN_CAP_MS
    : Math.min(length / 2, SCROBBLE_LISTEN_CAP_MS)
}

/**
 * Whether a play counts as a listen under `rules`: the track is longer than the minimum (when
 * its length is known) and was heard for at least {@link scrobbleThresholdMs}. A track of
 * unknown length must be heard for 4 minutes, so it is longer than any minimum.
 */
export function qualifiesForScrobble(
  play: Pick<ScrobblePlay, 'playedMs' | 'durationMs'> & { track?: { durationMs?: number } },
  rules: ScrobbleRules,
): boolean {
  const { playedMs } = play
  if (typeof playedMs !== 'number' || !Number.isFinite(playedMs)) return false
  const length = playLengthMs(play)
  if (length !== undefined && length <= rules.minTrackMs) return false
  return playedMs >= scrobbleThresholdMs(length)
}
