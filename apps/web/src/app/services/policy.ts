/**
 * The playback policy as the app's player and Now playing use it: the `PlaybackPolicy` that
 * stage 2.5 defines in `features/now-playing/playback-policy.ts`, built from the real pieces:
 *
 * - `resolver`: the stream lifecycle of stage 2.3, which waits for the platform first;
 * - `onNeedsReview`: the lifecycle's Suggest-band reports (`reviewchange`), one call per track
 *   and guess;
 * - `alternatives`: the matching engine's ranked candidates, from the match cache when it has
 *   them, else from a new match;
 * - `pin`: the lifecycle's `pinMatch`, which files the pin in the match cache (stage 2.6);
 * - `setPlayBestGuesses`: the lifecycle's "Play best guesses" setting.
 *
 * The interface is declared here too, with the same members, so that 2.5's
 * `createAppPolicy()` can return {@link AppPlaybackPolicy} as it is once both are on `develop`.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  candidateKey,
  entityKey,
  isPlayable,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import type {
  MatchStore,
  ReviewItem,
  StreamLifecycle,
  StreamResolver,
  TrackMatcher,
} from '@fxm/player'

/** What the web app needs from the playback policy (stage 2.5's `PlaybackPolicy`). */
export interface AppPlaybackPolicy {
  /** Finds the stream for each queue item: the stream lifecycle of stage 2.3. */
  readonly resolver: StreamResolver
  /**
   * Calls `listener` when the policy finds that a track's audio is only a Suggest-band match,
   * with that best guess: once per track and guess, the ones known when it starts listening
   * included. Returns a function that stops listening.
   */
  onNeedsReview(listener: (track: Track, bestGuess: AudioCandidate) => void): () => void
  /**
   * Other versions of `track`'s audio, best first, for "Not the right version?": the matching
   * engine's ranked candidates, each playable in the current catalog mode. Rejects with an
   * `FxmError` when they can't be found, or with the signal's reason when it aborts.
   */
  alternatives(track: Track, signal: AbortSignal): Promise<AudioCandidate[]>
  /** The user chose `candidate` as the audio of `track`: pins it in the match cache. */
  pin(track: Track, candidate: AudioCandidate): void
  /** Turns "Play best guesses" on or off. */
  setPlayBestGuesses(on: boolean): void
}

/** What {@link createAppPlaybackPolicy} is built from. */
export interface AppPlaybackPolicyOptions {
  /** The stream lifecycle (stage 2.3). */
  readonly lifecycle: Pick<StreamLifecycle, 'on' | 'reviews' | 'pinMatch'>
  /** The resolver the player uses: the lifecycle, behind the wait for the platform. */
  readonly resolver: StreamResolver
  /** The matching engine with its searches. */
  readonly matcher: TrackMatcher
  /** The match cache. */
  readonly matches: MatchStore
  /** The current catalog mode. */
  readonly mode: () => CatalogMode
  /** A provider context for the user's own request, once the platform is ready. */
  readonly context: (signal: AbortSignal) => Promise<ProviderContext>
  /** Changes "Play best guesses" for the lifecycle. */
  readonly setPlayBestGuesses: (on: boolean) => void
}

/** Creates the app's {@link AppPlaybackPolicy}. */
export function createAppPlaybackPolicy(options: AppPlaybackPolicyOptions): AppPlaybackPolicy {
  const { lifecycle } = options
  return {
    resolver: options.resolver,
    onNeedsReview(listener) {
      // The guess each track was last reported with, so a list that only grew reports the new.
      let reported = new Map<string, string>()
      const report = (items: readonly ReviewItem[]) => {
        const next = new Map<string, string>()
        for (const { track, guess } of items) {
          const key = entityKey(track.id)
          const guessKey = candidateKey(guess)
          next.set(key, guessKey)
          if (reported.get(key) !== guessKey) listener(track, guess)
        }
        reported = next
      }
      report(lifecycle.reviews())
      return lifecycle.on('reviewchange', report)
    },
    async alternatives(track, signal) {
      const mode = options.mode()
      const stored = await options.matches.get({ sourceTrackId: track.id, mode, target: 'song' })
      let found: AudioCandidate[] =
        stored === undefined
          ? []
          : [...(stored.candidate === undefined ? [] : [stored.candidate]), ...stored.alternatives]
      if (found.length === 0) {
        const ctx = await options.context(signal)
        const outcome = await options.matcher.match(track, {
          target: 'song',
          ctx,
          exclude: [],
          priority: 'current-track',
          signal,
        })
        found = [...(outcome.best === undefined ? [] : [outcome.best]), ...outcome.alternatives]
      }
      signal.throwIfAborted()
      const seen = new Set<string>()
      return found.filter((candidate) => {
        const key = candidateKey(candidate)
        if (seen.has(key) || !isPlayable(candidate, mode)) return false
        seen.add(key)
        return true
      })
    },
    pin(track, candidate) {
      lifecycle.pinMatch(track, candidate).catch((error: unknown) => {
        console.error('FXM: could not pin the version', error)
      })
    },
    setPlayBestGuesses: options.setPlayBestGuesses,
  }
}
