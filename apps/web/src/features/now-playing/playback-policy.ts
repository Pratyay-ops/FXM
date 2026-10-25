/**
 * Every place where the web app's player meets stage 2.3 (playback policy and stream lifecycle),
 * which is not merged yet: one interface, {@link PlaybackPolicy}, and the stand-in the app uses
 * until then, {@link createPendingPolicy}. Tests use the fake in `testing.tsx`.
 *
 * When 2.3 merges, {@link createAppPolicy} builds the real policy: its stream lifecycle becomes
 * the resolver, and its Suggest-band handling, alternatives and pins back the other members.
 * Nothing else in the web app changes.
 *
 * @module
 */

import { type AudioCandidate, FxmError, type Track } from '@fxm/core'
import type { StreamResolver } from '@fxm/player'

/** What the web app needs from the playback policy (stage 2.3). */
export interface PlaybackPolicy {
  /**
   * Finds the stream for each queue item: offline copies, the item's own source, matching, the
   * URL cache and Smart Replace (stage 2.3's stream lifecycle). The app's player uses it.
   */
  readonly resolver: StreamResolver
  /**
   * Calls `listener` when the policy finds that a track's audio is only a Suggest-band match
   * (ARCHITECTURE.md §12): FXM isn't sure it found the right recording, so unless "Play best
   * guesses" is on, queues skip the track until the user reviews it. `bestGuess` is the match
   * that would play. Returns a function that stops listening.
   */
  onNeedsReview(listener: (track: Track, bestGuess: AudioCandidate) => void): () => void
  /**
   * Other versions of `track`'s audio, best first, for "Not the right version?": the matching
   * engine's ranked candidates. Every one is playable in the current catalog mode. Rejects with
   * an `FxmError` when they can't be found, or with the signal's reason when it aborts.
   */
  alternatives(track: Track, signal: AbortSignal): Promise<AudioCandidate[]>
  /**
   * The user chose `candidate` as the audio of `track`: approved a best guess, or picked another
   * version. Remember it, so it plays without asking from now on (stage 2.6's match cache stores
   * it as a pin, `userPinned`). The player records the choice on the queue items itself.
   */
  pin(track: Track, candidate: AudioCandidate): void
  /**
   * Turns "Play best guesses" on or off: whether Suggest-band matches play without a review.
   * The setting is stored with the queue review (`features/queue/review-store.ts`), which calls
   * this at start and on every change.
   */
  setPlayBestGuesses(on: boolean): void
}

/** The message of the pending resolver's error, for logs. */
export const PENDING_RESOLVER_MESSAGE =
  'No stream resolver is connected yet: the playback policy (stage 2.3) provides it'

/**
 * The stand-in until stage 2.3 merges. It resolves nothing: every resolution rejects with an
 * `Unsupported` `FxmError`, so the player stops with `action-required` and says so. It finds no
 * alternatives, never reports a best guess, and forgets pins.
 */
export function createPendingPolicy(): PlaybackPolicy {
  return {
    resolver: {
      resolve: () => Promise.reject(new FxmError('Unsupported', PENDING_RESOLVER_MESSAGE)),
    },
    onNeedsReview: () => () => {},
    alternatives: async () => [],
    pin: () => {},
    setPlayBestGuesses: () => {},
  }
}

/**
 * The policy the app plays with. Integration with stage 2.3: return its policy here (its stream
 * lifecycle as `resolver`, the Suggest-band reports, the matching engine's alternatives and the
 * match cache's pins).
 */
export function createAppPolicy(): PlaybackPolicy {
  return createPendingPolicy()
}
