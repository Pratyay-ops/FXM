/**
 * Test helpers for the now-playing and queue features: a scriptable playback policy, the app's
 * playback with fakes, and test data. Nothing here touches the network or real audio.
 *
 * @module
 */

import { type AudioCandidate, formatId, type Track } from '@fxm/core'
import { FakeEngine, FakeResolver, testTrack } from '@fxm/player/testing'
import { type AppPlayback, configurePlayback, type PlaybackOptions } from './playback'
import type { PlaybackPolicy } from './playback-policy'

type ReviewListener = (track: Track, bestGuess: AudioCandidate) => void

/** A {@link PlaybackPolicy} for tests: a `FakeResolver`, and alternatives and reports on cue. */
export class FakePolicy implements PlaybackPolicy {
  readonly resolver: FakeResolver
  /** The alternatives of each track, by track ID. */
  readonly alternativesOf = new Map<string, AudioCandidate[]>()
  /** When set, `alternatives` rejects with it. */
  alternativesError: Error | undefined
  /** Every pin, in order. */
  readonly pins: { track: Track; candidate: AudioCandidate }[] = []
  /** The last value of `setPlayBestGuesses`. */
  playBestGuesses: boolean | undefined
  readonly #listeners = new Set<ReviewListener>()

  constructor(resolver = new FakeResolver()) {
    this.resolver = resolver
  }

  onNeedsReview(listener: ReviewListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Reports, as the real policy would, that `track` only has a Suggest-band match. */
  reportNeedsReview(track: Track, bestGuess: AudioCandidate): void {
    for (const listener of [...this.#listeners]) listener(track, bestGuess)
  }

  async alternatives(track: Track, signal: AbortSignal): Promise<AudioCandidate[]> {
    signal.throwIfAborted()
    if (this.alternativesError !== undefined) throw this.alternativesError
    return this.alternativesOf.get(track.id) ?? []
  }

  pin(track: Track, candidate: AudioCandidate): void {
    this.pins.push({ track, candidate })
  }

  setPlayBestGuesses(on: boolean): void {
    this.playBestGuesses = on
  }
}

/** The app's playback with fakes, as {@link setupTestPlayback} returns it. */
export interface TestPlayback extends AppPlayback {
  readonly engine: FakeEngine
  readonly resolver: FakeResolver
  readonly policy: FakePolicy
}

/**
 * Makes the app play through a `FakeEngine` and a {@link FakePolicy}, without the system media
 * controls, and with retries that don't wait. The test setup resets it after each test.
 */
export function setupTestPlayback(
  options: Pick<PlaybackOptions, 'storage' | 'persist' | 'player'> = {},
): TestPlayback {
  const engine = new FakeEngine()
  const policy = new FakePolicy()
  const playback = configurePlayback({
    createEngine: () => engine,
    policy,
    mediaSession: false,
    ...options,
    player: { retryDelaysMs: [0], stallTimeoutMs: 0, ...options.player },
  })
  return { player: playback.player, policy, engine, resolver: policy.resolver }
}

/** A Spotify track titled `name`: metadata only, so it plays through a match. */
export function spotifyTrack(name: string, overrides: Partial<Track> = {}): Track {
  return testTrack(name, {
    id: formatId('spotify', 'track', `sp-${name.replace(/\W/g, '')}`),
    source: 'spotify',
    ...overrides,
  })
}

/** A YouTube Music song as an audio candidate, with `ref` as its videoId. */
export function testCandidate(
  ref: string,
  overrides: Partial<AudioCandidate> = {},
): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind: 'song',
    title: `${ref} title`,
    artists: [`${ref} artist`],
    durationMs: 181_000,
    confidence: 0.93,
    evidence: ['title 0.98', 'duration +1.0s'],
    ...overrides,
  }
}
