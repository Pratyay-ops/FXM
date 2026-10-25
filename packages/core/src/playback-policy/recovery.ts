/**
 * What to do after a stream fails: the probing and re-resolution rules of ARCHITECTURE.md §10
 * ("Playback and URL lifecycle"), as one pure decision.
 *
 * - **Where the bytes are readable** (FXM Connect, desktop, Android), the resolver probes the end
 *   of the file before it hands a URL out, and a failure's HTTP status may be readable too.
 * - **In the Lite tier**, nothing can read googlevideo's responses, so the media element's first
 *   request is the probe: a media error or a stall before the first `play` event is a failed
 *   probe. The same goes for a probe that failed CORS after a googlevideo redirect: such URLs
 *   are `unverified`.
 * - Either way the policy falls back to the source's last-resort rung (YouTube's itag 18), then
 *   resolves again from the top.
 *
 * @module
 */

import type { FullLengthCheck } from '../quality'

/** The deepest `cause` chain {@link httpStatusOf} follows. */
const MAX_CAUSE_DEPTH = 4

/**
 * The HTTP status a failure carries, where one was readable, or `undefined`. It reads a `status`
 * that is an integer from 100 to 599 on the error itself, else on its `cause`, following the
 * chain a few levels deep. So an engine or a resolver that can read the status (a native player,
 * a byte fetch) reports it as `new EngineError('network', 'HTTP 403', { cause: { status: 403 } })`
 * or with the `Response` as the cause. A browser's media element never can.
 */
export function httpStatusOf(error: unknown): number | undefined {
  let value: unknown = error
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof value !== 'object' || value === null) return undefined
    const status = (value as { status?: unknown }).status
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status
    }
    value = (value as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * The rung of a source's resolution ladder a stream came from:
 *
 * - `top`: the whole ladder, best rung first (for YouTube: VISIONOS, any enabled experimental
 *   rungs, then itag 18)
 * - `fallback`: only the last-resort rung, YouTube's muxed itag 18
 */
export type LadderRung = 'top' | 'fallback'

/**
 * What failed, as the player reported it:
 *
 * - `expired`: the URL is past its expiry, or the player refreshes it before it plays again
 * - `decode`: the bytes arrived but could not be decoded
 * - `media`: any other playback failure: a media error (a refused request looks like one in a
 *   browser), or a stall in which no audio played for too long
 */
export type StreamFailureKind = 'expired' | 'decode' | 'media'

/** The facts {@link planStreamRecovery} decides on. */
export interface StreamFailureFacts {
  /** What failed. */
  kind: StreamFailureKind
  /** The HTTP status of the failure, where it was readable (see {@link httpStatusOf}). */
  status?: number
  /**
   * Whether the stream had started playing before it failed. A failure before the first `play`
   * event is a failure of the first request, which is the probe when the stream is `unverified`.
   */
  started: boolean
  /** Whether the end-of-file probe passed when the stream was resolved. */
  fullLength: FullLengthCheck
  /** The rung the stream came from. */
  rung: LadderRung
  /** Whether the stream was handed out from the URL cache rather than freshly resolved. */
  cached: boolean
  /** Whether the stream's source has a fallback rung (YouTube's itag 18). */
  hasFallback: boolean
  /**
   * How many 403s this rung already returned for the same audio on this network. A 403 is
   * resolved again once before the policy changes rung.
   */
  forbiddenCount: number
}

/**
 * Where to resolve next:
 *
 * - `same`: the same rung again, for a fresh URL
 * - `fallback`: the source's fallback rung (YouTube's itag 18)
 * - `top`: the whole ladder again, with fresh URLs
 */
export type RecoveryTarget = 'same' | 'fallback' | 'top'

/**
 * Why {@link planStreamRecovery} decided what it did:
 *
 * - `expired`: the URL expired, or answered 410 Gone
 * - `unauthorized`: 401
 * - `ip-changed`: a cached URL answered 403, most likely because the device's IP address changed
 * - `forbidden`: a fresh URL answered 403 for the first time on this rung
 * - `forbidden-again`: the rung answered 403 again with a fresh URL
 * - `probe-failed`: an unverified URL failed its first request, so it is probably capped. A
 *   source without a fallback rung is resolved again from the top
 * - `fallback-failed`: an unverified URL of the fallback rung failed its first request too
 * - `first-request`: a verified URL failed before it played, so it is not capped
 * - `mid-play`: the stream failed or stalled after it had played
 * - `decode`: the bytes could not be decoded
 */
export type RecoveryReason =
  | 'expired'
  | 'unauthorized'
  | 'ip-changed'
  | 'forbidden'
  | 'forbidden-again'
  | 'probe-failed'
  | 'fallback-failed'
  | 'first-request'
  | 'mid-play'
  | 'decode'

/** What to do after a stream failed (see {@link planStreamRecovery}). */
export interface StreamRecovery {
  /** Where to resolve next. */
  target: RecoveryTarget
  /** Drop every cached URL first: a 403 on a cached URL is probably an IP change. */
  flushAll: boolean
  /**
   * Avoid the failed stream's codec and container for this audio, and choose another format
   * from the same resolution: the bytes arrived but could not be decoded.
   */
  avoidFormat: boolean
  /** Why. */
  reason: RecoveryReason
}

/** The status codes that mean "resolve again" where the status is readable. */
const STATUS_REASONS: Readonly<Record<number, RecoveryReason>> = {
  401: 'unauthorized',
  410: 'expired',
}

/**
 * What to do after a stream failed. The failed URL is never used again on this network; on top
 * of that:
 *
 * | Failure | Next |
 * |---|---|
 * | expired, or 410 | the same rung, fresh |
 * | 401 | the same rung, fresh |
 * | 403 on a cached URL | flush every cached URL (a probable IP change), then the same rung |
 * | 403 on a fresh URL, the first on this rung | the same rung, fresh (once, before changing rung) |
 * | 403 again on a fresh URL | the fallback rung; from the fallback rung, the top again |
 * | could not decode | another format of the same resolution |
 * | an `unverified` URL fails before it plays | the fallback rung (a failed probe); from the fallback rung, the top again |
 * | a `verified` URL fails before it plays | the same rung, fresh: the probe proved it is not capped |
 * | a failure or a stall after playing | the same rung, fresh |
 *
 * A source without a fallback rung goes back to the top instead. The player resumes at the
 * position where the stream failed, and its retry limit bounds the rounds.
 */
export function planStreamRecovery(facts: StreamFailureFacts): StreamRecovery {
  const plan = (
    target: RecoveryTarget,
    reason: RecoveryReason,
    extra: Partial<StreamRecovery> = {},
  ): StreamRecovery => ({ target, flushAll: false, avoidFormat: false, reason, ...extra })
  const changeRung = facts.rung === 'top' && facts.hasFallback ? 'fallback' : 'top'
  if (facts.kind === 'expired') return plan('same', 'expired')
  const { status } = facts
  if (status === 403) {
    if (facts.cached) return plan('same', 'ip-changed', { flushAll: true })
    if (facts.forbiddenCount < 1) return plan('same', 'forbidden')
    return plan(changeRung, 'forbidden-again')
  }
  const statusReason = status === undefined ? undefined : STATUS_REASONS[status]
  if (statusReason !== undefined) return plan('same', statusReason)
  if (facts.kind === 'decode') return plan('same', 'decode', { avoidFormat: true })
  if (facts.started) return plan('same', 'mid-play')
  if (facts.fullLength === 'verified') return plan('same', 'first-request')
  if (facts.rung === 'fallback') return plan('top', 'fallback-failed')
  return plan(changeRung, 'probe-failed')
}
