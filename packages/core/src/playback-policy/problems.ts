/**
 * How the playback policy reports what it could not play, and when Smart Replace swaps a match.
 *
 * - **Playability verdicts.** A source's own verdict that one item cannot play, such as
 *   YouTube's `playabilityStatus` `UNPLAYABLE` or `ERROR` for a video. It is the only signal
 *   Smart Replace acts on. A resolver reports one with {@link unplayableError}.
 * - **Playback problems.** Why the policy gave up on a queue item: it needs the user's review
 *   (a Suggest-band guess), or it is unavailable. They travel as the `cause` of the `FxmError`
 *   the resolver rejects with, so the player skips the item and the app reads them back with
 *   {@link playbackProblemOf}.
 *
 * @module
 */

import { FxmError, isFxmError } from '../errors'
import { type EntityId, isEntityId, isSourceId, type SourceId } from '../ids'
import type { AudioCandidate } from '../providers'
import { sameCandidate } from './order'

/** The playability statuses that are a verdict on the item itself. */
export const UNPLAYABLE_STATUSES = ['UNPLAYABLE', 'ERROR'] as const

/**
 * A source's verdict on one item, as YouTube's `playabilityStatus.status` says it:
 *
 * - `UNPLAYABLE`: the video exists but cannot play, e.g. it was blocked in the user's region
 * - `ERROR`: the video does not exist, or no longer does
 *
 * Bot checks (`LOGIN_REQUIRED`), rate limits, network errors and capped URLs are no verdict on
 * the video: they say something about the device's IP address or the resolution ladder.
 */
export type UnplayableStatus = (typeof UNPLAYABLE_STATUSES)[number]

/** A source's verdict that one item cannot play (see {@link UnplayableStatus}). */
export interface PlayabilityVerdict {
  /** Always `playability`. */
  readonly type: 'playability'
  /** The audio source of the item, e.g. `ytm`. */
  readonly source: SourceId
  /** The item's native ID, e.g. the videoId. */
  readonly ref: string
  /** The source's status for the item. */
  readonly status: UnplayableStatus
  /** The source's reason, for logs, e.g. "Video unavailable". */
  readonly reason?: string
}

/**
 * The error a resolver rejects with when the source gives a verdict on the item itself (see
 * {@link UnplayableStatus}): an `FxmError` with the verdict as its `cause`, coded `NotFound` for
 * `ERROR` and `Unavailable` for `UNPLAYABLE`, so the player skips the item if nothing replaces
 * it. Read the verdict back with {@link playabilityVerdictOf}.
 */
export function unplayableError(
  verdict: Omit<PlayabilityVerdict, 'type'>,
  message = `${verdict.source} item ${verdict.ref} is ${verdict.status}${
    verdict.reason === undefined ? '' : `: ${verdict.reason}`
  }`,
): FxmError {
  const cause: PlayabilityVerdict = { type: 'playability', ...verdict }
  return new FxmError(verdict.status === 'ERROR' ? 'NotFound' : 'Unavailable', message, { cause })
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

/**
 * The verdict an error carries (see {@link unplayableError}), or `undefined` when it carries
 * none: any other error, or a malformed verdict.
 */
export function playabilityVerdictOf(error: unknown): PlayabilityVerdict | undefined {
  if (!isFxmError(error)) return undefined
  const cause = asRecord(error.cause)
  if (cause?.type !== 'playability' || !isSourceId(cause.source)) return undefined
  const { ref, status, reason } = cause
  if (typeof ref !== 'string' || ref === '') return undefined
  if (typeof status !== 'string' || !(UNPLAYABLE_STATUSES as readonly string[]).includes(status)) {
    return undefined
  }
  return {
    type: 'playability',
    source: cause.source,
    ref,
    status: status as UnplayableStatus,
    ...(typeof reason === 'string' ? { reason } : {}),
  }
}

/**
 * Why an item is unavailable:
 *
 * - `no-match`: the matching engine found nothing close enough
 * - `unplayable`: the source says the audio is gone (removed, blocked in the region), and
 *   nothing replaced it
 * - `pinned-unplayable`: the version the user pinned is gone. FXM never swaps a pin by itself
 * - `no-stream`: the sources returned no stream the player can play
 * - `no-source`: nothing on this platform can play the track's audio
 */
export type UnavailableReason =
  | 'no-match'
  | 'unplayable'
  | 'pinned-unplayable'
  | 'no-stream'
  | 'no-source'

/** Every {@link UnavailableReason}. */
export const UNAVAILABLE_REASONS: readonly UnavailableReason[] = Object.freeze([
  'no-match',
  'unplayable',
  'pinned-unplayable',
  'no-stream',
  'no-source',
])

/**
 * Why the playback policy gave up on a queue item:
 *
 * - `needs-review`: its match is a Suggest-band guess, and nothing allowed it to play (an
 *   explicit user action, or "Play best guesses"). A queue skips it; the queue panel marks it
 *   "needs review" and offers the guess and the alternatives
 * - `unavailable`: nothing can play it (see {@link UnavailableReason}). The app shows the
 *   alternatives, if any, and a manual search
 */
export type PlaybackProblem =
  | {
      readonly type: 'needs-review'
      /** The track to review. */
      readonly trackId: EntityId<'track'>
      /** The best guess. */
      readonly guess: AudioCandidate
      /** The other candidates, best first. */
      readonly alternatives: readonly AudioCandidate[]
    }
  | {
      readonly type: 'unavailable'
      /** The track that cannot play. */
      readonly trackId: EntityId<'track'>
      /** Why. */
      readonly reason: UnavailableReason
      /** Other candidates the user may pick, best first. Often empty. */
      readonly alternatives: readonly AudioCandidate[]
    }

/**
 * The error a resolver rejects with for a {@link PlaybackProblem}: an `FxmError` coded
 * `Unavailable`, which the player skips at once, with the problem as its `cause`. Read it back
 * with {@link playbackProblemOf}.
 */
export function playbackProblemError(problem: PlaybackProblem): FxmError {
  const message =
    problem.type === 'needs-review'
      ? `${problem.trackId} needs review: its best match is a guess`
      : `${problem.trackId} is unavailable (${problem.reason})`
  return new FxmError('Unavailable', message, { cause: problem })
}

function isCandidateLike(value: unknown): value is AudioCandidate {
  const candidate = asRecord(value)
  return (
    candidate !== undefined && isSourceId(candidate.source) && typeof candidate.ref === 'string'
  )
}

/**
 * The {@link PlaybackProblem} an error carries (see {@link playbackProblemError}), or
 * `undefined` for any other error or a malformed problem. Use it on the error of the player's
 * `trackfailed` event to tell "needs review" and "unavailable" from other failures.
 */
export function playbackProblemOf(error: unknown): PlaybackProblem | undefined {
  if (!isFxmError(error)) return undefined
  const cause = asRecord(error.cause)
  if (cause === undefined || !isEntityId(cause.trackId, 'track')) return undefined
  const alternatives = Array.isArray(cause.alternatives)
    ? (cause.alternatives as unknown[]).filter(isCandidateLike)
    : []
  if (cause.type === 'needs-review' && isCandidateLike(cause.guess)) {
    return { type: 'needs-review', trackId: cause.trackId, guess: cause.guess, alternatives }
  }
  const { reason } = cause
  if (cause.type === 'unavailable' && UNAVAILABLE_REASONS.includes(reason as UnavailableReason)) {
    return {
      type: 'unavailable',
      trackId: cause.trackId,
      reason: reason as UnavailableReason,
      alternatives,
    }
  }
  return undefined
}

/**
 * The role a failing candidate plays for its track:
 *
 * - `own`: the track's own audio, e.g. a YouTube Music song's video. No match to replace
 * - `linked-song`: the song a music video's source links it to
 * - `match`: a match: found by the matching engine, recorded on the queue item, or pinned
 */
export type CandidateRole = 'own' | 'linked-song' | 'match'

/** The facts {@link smartReplaceAction} decides on. */
export interface SmartReplaceFacts {
  /** The candidate that failed. */
  candidate: Pick<AudioCandidate, 'source' | 'ref'>
  /** Its role for the track. */
  role: CandidateRole
  /** Whether the user pinned it. */
  pinned: boolean
  /** The source's verdict, when the failure carried one (see {@link playabilityVerdictOf}). */
  verdict: PlayabilityVerdict | undefined
  /**
   * Whether other items of the same source resolve: another item resolved recently on the same
   * network. Without that, a verdict may come from a flagged IP address rather than the item.
   */
  othersResolve: boolean
}

/**
 * What Smart Replace does about a failing candidate:
 *
 * - `replace`: find a new match without it, because the source gave a verdict on that very
 *   item while other items still resolve
 * - `keep-pin`: leave the user's pin alone: pins are never swapped or deleted by FXM
 * - `keep-match`: keep the match: ladder failures, bot checks, network errors, offline periods
 *   and 403s after an IP change say nothing about it, and re-matching on them would pile
 *   requests onto an address that may already be flagged
 * - `not-a-match`: the track's own audio failed; there is no match to replace
 */
export type SmartReplaceAction = 'replace' | 'keep-pin' | 'keep-match' | 'not-a-match'

/**
 * Whether Smart Replace swaps a failing match (see {@link SmartReplaceAction}). It fires only on
 * a verdict on that very item (`UNPLAYABLE` or `ERROR`) while other items of the source still
 * resolve, and never for a pin or the track's own audio.
 */
export function smartReplaceAction(facts: SmartReplaceFacts): SmartReplaceAction {
  if (facts.role === 'own') return 'not-a-match'
  if (facts.pinned) return 'keep-pin'
  const { verdict } = facts
  if (verdict === undefined || !sameCandidate(verdict, facts.candidate)) return 'keep-match'
  return facts.othersResolve ? 'replace' : 'keep-match'
}
