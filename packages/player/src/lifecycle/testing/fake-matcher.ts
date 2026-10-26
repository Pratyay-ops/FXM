/**
 * A matching engine that searches nothing: it answers from rankings a test sets, and records
 * every call.
 *
 * @module
 */

import {
  type AudioCandidate,
  candidateKey,
  entityKey,
  type MatchBand,
  type MatchTarget,
  type Track,
} from '@fxm/core'
import type { MatchOutcome, TrackMatcher, TrackMatchRequest } from '../adapters'

/** One ranked candidate with the band the matching engine would give it. */
export interface RankedCandidate {
  /** The candidate. */
  candidate: AudioCandidate
  /** Its band. */
  band: MatchBand
}

/** One call to {@link FakeMatcher.match}. */
export interface FakeMatcherCall {
  /** The track. */
  track: Track
  /** The request. */
  request: TrackMatchRequest
}

/**
 * A scriptable {@link TrackMatcher}. {@link FakeMatcher.rank} sets what it finds for a track:
 * the best candidate that the request does not exclude, with its band, and the rest as
 * alternatives. A track without a ranking gets `none`. {@link FakeMatcher.fail} makes it reject.
 */
export class FakeMatcher implements TrackMatcher {
  /** Every call, in order. */
  readonly calls: FakeMatcherCall[] = []
  readonly #rankings = new Map<string, readonly RankedCandidate[]>()
  readonly #errors = new Map<string, Error>()

  /** Sets the ranking for `track` and `target`, best first. */
  rank(track: Track, target: MatchTarget, ranking: readonly RankedCandidate[]): void {
    this.#rankings.set(this.#key(track, target), ranking)
  }

  /** Makes matching `track` for `target` reject with `error`. */
  fail(track: Track, target: MatchTarget, error: Error): void {
    this.#errors.set(this.#key(track, target), error)
  }

  async match(track: Track, request: TrackMatchRequest): Promise<MatchOutcome> {
    this.calls.push({ track, request })
    const key = this.#key(track, request.target)
    const error = this.#errors.get(key)
    if (error !== undefined) throw error
    const excluded = new Set(request.exclude.map(candidateKey))
    const ranking = (this.#rankings.get(key) ?? []).filter(
      ({ candidate }) => !excluded.has(candidateKey(candidate)),
    )
    const [best, ...rest] = ranking
    const alternatives = rest.map(({ candidate }) => candidate)
    if (best === undefined || best.band === 'none') return { band: 'none', alternatives }
    return { band: best.band, best: best.candidate, alternatives }
  }

  /** How many calls matched `track`, for any target or one. */
  callsFor(track: Track, target?: MatchTarget): number {
    return this.calls.filter(
      (call) =>
        entityKey(call.track.id) === entityKey(track.id) &&
        (target === undefined || call.request.target === target),
    ).length
  }

  #key(track: Track, target: MatchTarget): string {
    return `${entityKey(track.id)}\u0000${target}`
  }
}
