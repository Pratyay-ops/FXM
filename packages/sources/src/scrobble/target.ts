/**
 * One service the scrobbler sends to, as the clients adapt themselves to it.
 *
 * @module
 */

import type { ScrobbleRules } from './rules'
import type { Scrobble, ScrobbleContext, ScrobbleServiceId, ScrobbleTrack } from './types'

/** What a service did with a batch of scrobbles it took. */
export interface SubmitReport {
  /** How many it added to the user's profile. */
  accepted: number
  /**
   * How many it took but left out, e.g. Last.fm's filters ("ignored"). They are done: sending
   * them again would be ignored again.
   */
  ignored: number
  /** The service's reason for each one it left out, e.g. Last.fm's ignored-message codes. */
  ignoredCodes: number[]
}

/** A connected service, ready to take scrobbles. */
export interface ScrobbleTarget {
  /** Which service it is. */
  readonly service: ScrobbleServiceId
  /** When a play counts as a listen for it. */
  readonly rules: ScrobbleRules
  /** The most scrobbles one request may carry. */
  readonly batchSize: number
  /**
   * Holds its scrobbles without sending them, e.g. while it refuses FXM's credentials: plays
   * still join its queue, so nothing is lost before the user connects again.
   */
  readonly paused?: boolean
  /**
   * Which credentials it sends with, as the app identifies them. The scrobbler only hands it
   * back with a refusal (`onRefused`), so the app can tell whether the refused credentials are
   * still the ones it holds, e.g. after another tab connected again meanwhile.
   */
  readonly account?: string
  /** Tells the service what is playing now. Never retried. */
  nowPlaying(track: ScrobbleTrack, ctx: ScrobbleContext): Promise<void>
  /**
   * Sends up to {@link batchSize} scrobbles, oldest first. Rejects with a `ScrobbleError` whose
   * `failure` says what to do with them.
   */
  submit(scrobbles: readonly Scrobble[], ctx: ScrobbleContext): Promise<SubmitReport>
}
