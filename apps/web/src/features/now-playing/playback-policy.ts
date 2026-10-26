/**
 * Every place where the web app's player meets the playback policy and stream lifecycle of
 * stage 2.3: one interface, {@link PlaybackPolicy}, and the policy the app's player is created
 * with, {@link createAppPolicy}. Tests use the fake in `testing.ts`.
 *
 * The real policy comes from the composition root (`src/app/services`, stage 2.9): its stream
 * lifecycle is the resolver, and its Suggest-band reports, the matching engine's alternatives
 * and the match cache's pins back the other members. The composition root loads beside the
 * first render, in a chunk of its own, so the player is there before it: {@link createAppPolicy}
 * follows whichever policy {@link connectAppPolicy} connected, and what the player asks before
 * one is connected waits for it. Where the composition root doesn't run (the development fake
 * catalog) or could not start, it connects {@link createPendingPolicy} instead.
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
  'No stream resolver is connected: the app’s music services (src/app/services) are not running'

/**
 * The stand-in for where the composition root doesn't run (the development fake catalog) or
 * could not start. It resolves nothing: every resolution rejects with an `Unsupported`
 * `FxmError`, so the player stops with `action-required` and says so. It finds no alternatives,
 * never reports a best guess, and forgets pins.
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

type ReviewListener = (track: Track, bestGuess: AudioCandidate) => void

/** One `onNeedsReview` listener of the app's policy, and its subscription to the connected one. */
interface ReviewRegistration {
  readonly listener: ReviewListener
  stop: () => void
}

const NOTHING = () => {}

/** The policy {@link connectAppPolicy} connected last, until it is disconnected. */
let connected: PlaybackPolicy | undefined
/** Called whenever a policy is connected. */
const onConnect = new Set<() => void>()
const reviewRegistrations = new Set<ReviewRegistration>()
/** "Play best guesses", as the review list last set it, for every policy connected later. */
let playBestGuesses: boolean | undefined

/** The connected policy, or the next one to be connected. Rejects with `signal`'s reason. */
function connectedPolicy(signal?: AbortSignal): Promise<PlaybackPolicy> {
  if (connected !== undefined) return Promise.resolve(connected)
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const done = () => {
      onConnect.delete(take)
      signal?.removeEventListener('abort', abort)
    }
    const take = () => {
      if (connected === undefined) return
      done()
      resolve(connected)
    }
    const abort = () => {
      done()
      reject(signal?.reason)
    }
    onConnect.add(take)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** The app's one policy: it passes everything on to the connected policy. */
const appPolicy: PlaybackPolicy = {
  resolver: {
    async resolve(item, request) {
      return (await connectedPolicy(request.signal)).resolver.resolve(item, request)
    },
  },
  onNeedsReview(listener) {
    const registration: ReviewRegistration = {
      listener,
      stop: connected?.onNeedsReview(listener) ?? NOTHING,
    }
    reviewRegistrations.add(registration)
    return () => {
      reviewRegistrations.delete(registration)
      registration.stop()
    }
  },
  async alternatives(track, signal) {
    return (await connectedPolicy(signal)).alternatives(track, signal)
  },
  pin(track, candidate) {
    if (connected !== undefined) {
      connected.pin(track, candidate)
      return
    }
    void connectedPolicy().then((policy) => policy.pin(track, candidate))
  },
  setPlayBestGuesses(on) {
    playBestGuesses = on
    connected?.setPlayBestGuesses(on)
  },
}

/**
 * The policy the app's player is created with: one for the whole app, which follows the policy
 * {@link connectAppPolicy} connected. Until one is, resolutions and searches for alternatives
 * wait for it (or for their signal), a pin waits to be passed on, and "Play best guesses" and
 * the review listeners are passed on as it connects.
 */
export function createAppPolicy(): PlaybackPolicy {
  return appPolicy
}

/**
 * Makes the app's player play through `policy`: the composition root's (stage 2.9), or the
 * stand-in where it doesn't run. A later call replaces it. Returns a function that disconnects
 * it, which leaves a policy connected after it alone.
 */
export function connectAppPolicy(policy: PlaybackPolicy): () => void {
  for (const registration of reviewRegistrations) registration.stop()
  connected = policy
  if (playBestGuesses !== undefined) policy.setPlayBestGuesses(playBestGuesses)
  for (const registration of reviewRegistrations) {
    registration.stop = policy.onNeedsReview(registration.listener)
  }
  for (const take of [...onConnect]) take()
  return () => {
    if (connected !== policy) return
    for (const registration of reviewRegistrations) {
      registration.stop()
      registration.stop = NOTHING
    }
    connected = undefined
  }
}
