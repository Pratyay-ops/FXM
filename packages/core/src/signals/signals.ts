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

/**
 * What a signal needs to know about its track: the ID, the title (shown with the track's
 * affinity), the credited artists and the tags. A whole {@link Track} has all of them.
 */
export type SignalTrack = Pick<Track, 'id' | 'title' | 'artists' | 'tags'>

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
  /** When it happened, as epoch milliseconds. A play happens when it starts. */
  at: number
  /** The track it is about. */
  track: SignalTrack
}

/**
 * One play of a track: from the moment it started to the moment it stopped, ended or gave way
 * to another track.
 *
 * - `completed`: it played to the end
 * - `skipped`: the user moved on before the end (next, or another queue item)
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

/** The user took a like back. */
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

/** The track left a playlist, or the playlist was deleted. */
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
