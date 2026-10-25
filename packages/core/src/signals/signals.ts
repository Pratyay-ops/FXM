/**
 * Listening signals: what the user did with a track, as plain data. A play (how long it played,
 * whether it reached the end or was skipped, where it started and what played), a like and its
 * removal, and a track joining or leaving a playlist. The affinity (`affinity.ts`) turns them
 * into time-decayed scores for tracks, artists and tags.
 *
 * Every signal says when it happened (`at`, epoch milliseconds) and which track it is about.
 * Taking something back (`unlike`, `playlist-remove`) names the time of what it takes back
 * (`likedAt`, `addedAt`), so it cancels that contribution exactly, however long ago it was made.
 *
 * Signals come from the player (plays), the library (likes and playlist changes) and imports
 * such as a listening history from another service (stage 3.6). They survive
 * `JSON.stringify`.
 *
 * ## Times
 *
 * A signal's times must never be later than the clock of whatever keeps the affinity. The
 * affinity decays every contribution to the latest time it holds, so a contribution dated in
 * the future would make every later one count next to nothing until the clock caught up. The
 * in-memory `AffinityIndex` refuses signals dated after its clock; the web library never stores
 * such a time (see its README).
 *
 * @module
 */

import type { EntityId, SourceId } from '../ids'
import type { Track } from '../model'
import type { Codec, Container, QualityTier, StreamMedia } from '../quality'

/** Every {@link ListeningSignalType}. */
export const LISTENING_SIGNAL_TYPES = [
  'play',
  'like',
  'unlike',
  'playlist-add',
  'playlist-remove',
] as const

/** What a {@link ListeningSignal} records. */
export type ListeningSignalType = (typeof LISTENING_SIGNAL_TYPES)[number]

/** Latest time a signal may carry: the largest valid `Date`, as epoch milliseconds. */
export const MAX_SIGNAL_TIME = 8.64e15

/**
 * Whether `value` can be a signal's time: epoch milliseconds from 0 to the largest valid `Date`
 * ({@link MAX_SIGNAL_TIME}). Whether it lies in the future is for the caller's clock to say.
 */
export function isSignalTime(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SIGNAL_TIME
  )
}

/**
 * What a signal needs to know about its track: the ID, the title (shown with the track's
 * affinity), the credited artists and the tags, and when known its kind and, for a music video,
 * the song it links. The artists, tags and kind decide which artist and tag entries a signal
 * credits (see `affinityCredits`). A whole {@link Track} has all of them.
 */
export type ListeningSignalTrack = Pick<Track, 'id' | 'title' | 'artists' | 'tags'> &
  Partial<Pick<Track, 'kind' | 'songId'>>

/**
 * Where a play started, as it is stored: the type of the queue's context and what it links back
 * to (`playContextOf` builds one from a `QueueContext`). The type is an open string, so a context
 * that a later version adds survives in older ones, in backups and in imports.
 */
export interface PlayContext {
  /** The kind of list: `album`, `playlist`, `artist`, `radio`, `search` or `library` today. */
  type: string
  /**
   * What it links back to: the entity ID of an album, playlist or artist, the track or artist a
   * radio started from, the query of a search, or the library's own key for a list.
   */
  id: string
  /** What to show, e.g. the album name. */
  title?: string
}

/** What actually played (`playStreamOf` builds it from a queue item and its stream). */
export interface PlayStream {
  /** The audio source that delivered it, e.g. `ytm` or `archive`. */
  source: SourceId
  /** The audio's own track ID when it differs from the played track, e.g. a matched song. */
  audioId?: EntityId<'track'>
  /** Audio codec. */
  codec?: Codec
  /** Container. */
  container?: Container
  /** Bitrate in kbps. */
  bitrateKbps?: number
  /** Quality tier. */
  tier?: QualityTier
  /** Audio only, or a muxed video. */
  media?: StreamMedia
  /** Whether it played from a downloaded copy. */
  offline?: boolean
}

/** What every signal has. */
interface SignalBase {
  /**
   * When it happened, as epoch milliseconds: never later than the clock of whatever keeps the
   * affinity (see the module documentation). A play happens when it starts.
   */
  at: number
  /** The track it is about. */
  track: ListeningSignalTrack
}

/**
 * One play of a track: from the moment it started to the moment it stopped, ended or gave way
 * to another track.
 *
 * - `completed`: it played to the end, and most of it was heard
 * - `skipped`: the user moved on before the end (next, or another queue item), or sought to it
 * - neither: it stopped earlier for another reason, e.g. the user went back, started something
 *   else, closed the app, or the track failed
 */
export interface PlaySignal extends SignalBase {
  type: 'play'
  /** How long it played, in milliseconds: listening time, without pauses and skipped parts. */
  playedMs: number
  /** The track's length in milliseconds, when known. */
  durationMs?: number
  /** Whether it played to the end. */
  completed: boolean
  /** Whether the user skipped the rest of it. */
  skipped: boolean
  /** Where it started from. */
  context?: PlayContext
  /** What actually played. */
  stream?: PlayStream
}

/** The user liked the track. */
export interface LikeSignal extends SignalBase {
  type: 'like'
}

/**
 * The user took a like back. It cancels exactly what the like added when its track carries the
 * artists, tags and kind the like was scored with: a store scores every signal of a track with
 * the track's current metadata, and moves what the track holds when that metadata changes
 * (`reattributeAffinity`), so its take-backs always do.
 */
export interface UnlikeSignal extends SignalBase {
  type: 'unlike'
  /** When the like was made: the unlike cancels exactly what that like added. */
  likedAt: number
}

/** The track joined a playlist of the library (Downloads included). */
export interface PlaylistAddSignal extends SignalBase {
  type: 'playlist-add'
  /** The playlist. */
  playlistId: EntityId<'playlist'>
}

/**
 * The track left a playlist, or the playlist was deleted. Like an {@link UnlikeSignal}, it
 * cancels exactly what the add contributed when its track carries the artists, tags and kind
 * the add was scored with.
 */
export interface PlaylistRemoveSignal extends SignalBase {
  type: 'playlist-remove'
  /** The playlist. */
  playlistId: EntityId<'playlist'>
  /** When the track was added: the removal cancels exactly what that add contributed. */
  addedAt: number
}

/** Something the user did with a track, which the affinity scores. */
export type ListeningSignal =
  | PlaySignal
  | LikeSignal
  | UnlikeSignal
  | PlaylistAddSignal
  | PlaylistRemoveSignal
