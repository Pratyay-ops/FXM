/**
 * The stream resolver contract: how the player turns a queue item into a stream it can play.
 * The real resolver is the playback policy and stream lifecycle (stage 2.3): offline copies,
 * on-device resolution, matching, URL caching and Smart Replace. The player only asks.
 *
 * @module
 */

import type { AudioCandidate, QueueItem, StreamOption } from '@fxm/core'

/**
 * Why the player needs a stream:
 *
 * - `play`: the item is about to play
 * - `preload`: the item plays next, so its stream can be prepared ahead
 * - `retry`: the previous stream failed; see {@link ResolveRequest.failure}
 * - `refresh`: the stream loaded earlier expired while paused; nothing failed yet
 */
export type ResolveReason = 'play' | 'preload' | 'retry' | 'refresh'

/** What went wrong with the previous attempt to play an item. */
export interface StreamFailure {
  /** The failure: an `EngineError` from playback, or the error a resolution rejected with. */
  error: Error
  /** The stream that failed. Absent when the resolution itself failed. */
  stream?: StreamOption
  /** Where playback was, in milliseconds; the player resumes there. */
  positionMs: number
}

/** The details of one resolution. */
export interface ResolveRequest {
  /** Why the stream is needed. */
  reason: ResolveReason
  /** How many attempts to play this item have failed so far: 0 at first, up to 3 on retries. */
  attempt: number
  /**
   * For `retry` and `refresh`: what went wrong, so the resolver can pick a fresh URL, another
   * format or an alternative candidate.
   */
  failure?: StreamFailure
  /** Aborted when the player no longer needs the stream, e.g. after a skip. */
  signal: AbortSignal
}

/** A stream to play, and the candidate it was resolved from. */
export interface ResolvedStream {
  /** The stream. */
  stream: StreamOption
  /**
   * The candidate the stream belongs to, e.g. the song a Spotify track was matched to. The
   * player records it on the queue item.
   */
  candidate?: AudioCandidate
}

/**
 * Finds the stream to play for a queue item. It rejects (with an `FxmError` where possible)
 * when it has nothing to offer; the player counts that as a failed attempt.
 */
export interface StreamResolver {
  /** Resolves the stream to play `item`. */
  resolve(item: QueueItem, request: ResolveRequest): Promise<ResolvedStream>
}
