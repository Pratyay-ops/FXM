/**
 * The stream resolver contract: how the player turns a queue item into a stream it can play.
 * The real resolver is the playback policy and stream lifecycle (stage 2.3): offline copies,
 * on-device resolution, matching, URL caching and Smart Replace. The player only asks.
 *
 * @module
 */

import type { AudioCandidate, QueueItem, StreamOption } from '@fxm/core'
import type { PlaySupport } from './engine'

/**
 * Why the player needs a stream:
 *
 * - `play`: the item is about to play
 * - `preload`: the item plays next, so its stream can be prepared ahead
 * - `retry`: the previous stream failed; see {@link ResolveRequest.failure}. Also used when the
 *   user plays an item again after it failed, so a cache does not hand back the failed URL
 * - `refresh`: the stream loaded earlier expires soon (it waited while paused, or a repeat
 *   replays it); nothing failed yet
 * - `replace`: the user picked another version for the item (`Player.setCandidate`), now in
 *   `item.candidate`
 */
export type ResolveReason = 'play' | 'preload' | 'retry' | 'refresh' | 'replace'

/** What went wrong with the previous attempt to play an item. */
export interface StreamFailure {
  /** The failure: an `EngineError` from playback, or the error a resolution rejected with. */
  error: Error
  /** The stream that failed. Absent when the resolution itself failed. */
  stream?: StreamOption
  /** Where playback was, in milliseconds; the player resumes there. */
  positionMs: number
  /**
   * Whether the failed stream had started playing: the engine reported `play` for it. `false`
   * for a failure before the first `play` event, which in the Lite tier, where the bytes cannot
   * be read, is how a capped URL shows: the media element's first request is the probe. Present
   * whenever `stream` is.
   */
  started?: boolean
}

/** The details of one resolution. */
export interface ResolveRequest {
  /** Why the stream is needed. */
  reason: ResolveReason
  /**
   * How many attempts to play this item have failed so far: 0 at first, then 1 to 3 on
   * retries. A user who plays a failed item again starts over at 1.
   */
  attempt: number
  /**
   * For `retry` and `refresh`: what went wrong, so the resolver can pick a fresh URL, another
   * format or an alternative candidate.
   */
  failure?: StreamFailure
  /** Aborted when the player no longer needs the stream, e.g. after a skip. */
  signal: AbortSignal
  /**
   * How sure the player's engine is that it can play a stream, for the format choice: prefer
   * `probably`, try `maybe`, never return `no`. It also says `no` to a stream whose
   * `fullLength` is `capped`.
   */
  canPlay(stream: StreamOption): PlaySupport
}

/** A stream to play, and the candidate it was resolved from. */
export interface ResolvedStream {
  /** The stream. */
  stream: StreamOption
  /**
   * The candidate the stream belongs to, e.g. the song a Spotify track was matched to. The
   * player records it on the queue item, so later resolutions (a retry, a repeat, a restored
   * queue) resolve the same audio.
   */
  candidate?: AudioCandidate
}

/**
 * Finds the stream to play for a queue item.
 *
 * **Which audio.** When `item.candidate` is set, it is the audio to resolve: the match recorded
 * earlier, or the version the user picked, which always wins. Only a `retry` may replace it, for
 * example with Smart Replace after the candidate kept failing, and must then return the
 * replacement as `candidate`. Without a candidate the resolver finds one and returns it:
 *
 * - a track whose source has its own audio plays that
 * - a track from a catalog without audio, such as Spotify, is matched to a song first
 * - a music video in Music mode plays its song: the one it links (`songForVideo(item.track)`,
 *   verdict `plays-linked-song`), else the one the matching engine maps it to
 *   (`needs-song-match`)
 *
 * **Which stream.** A stream `canPlay` says `no` to is refused like a failed attempt, and a
 * `capped` stream is never returned.
 *
 * **Rejections.** Reject with an `FxmError` whose code says what went wrong; the player's
 * `classifyFailure` (by default `classifyFailure` from this package) decides what happens:
 *
 * - `NotFound`, `Unavailable`, `GeoBlocked`: the item cannot play anywhere, so the player skips
 *   it at once, without retries
 * - `Unsupported`, `AuthRequired`, `BotCheck`: no item will play until the user acts (install
 *   FXM Connect, log in, prove they are human), so the player stops
 * - `RateLimited`: retried, but not before `retryAfterMs`
 * - anything else, including `Network`, `Expired`, `Parse` and errors that are not `FxmError`s:
 *   retried after a short wait, up to 3 times, then skipped
 */
export interface StreamResolver {
  /** Resolves the stream to play `item`. */
  resolve(item: QueueItem, request: ResolveRequest): Promise<ResolvedStream>
}
