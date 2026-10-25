/**
 * What a `/player` response says about the video: whether it can be streamed, whether YouTube
 * wants a bot check, or why the video itself cannot play.
 *
 * Stream requests ask for English (`hl=en`), so YouTube's reasons can be read reliably: an age
 * gate and a bot check share the `LOGIN_REQUIRED` status and differ only in their reason and
 * fields. The facts behind each rule, and the responses they were measured on, are in
 * `CLEAN-ROOM.md`.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { botCheckIn } from '../errors'
import { arrayAt, at, type JsonRecord, recordAt, stringAt } from '../json'

/** Every {@link UnavailableState}. */
export const UNAVAILABLE_STATES = ['age-restricted', 'made-for-kids', 'live', 'premiere'] as const

/**
 * Why a video cannot play on the default rungs, for a labelled state instead of a silent
 * failure. Only rungs that opt in (`tries` in the stream config) may still try such a video.
 *
 * - `age-restricted`: YouTube wants a signed-in adult (`LOGIN_REQUIRED` with an age gate)
 * - `made-for-kids`: VISIONOS answers videos made for kids with `UNPLAYABLE`, "This video is not
 *   available"; the ANDROID client's itag 18 plays them (measured 2026-10-26)
 * - `live`: a live stream, a scheduled one that has not started, one that has just ended and
 *   still plays from the live DVR, or a past one whose recording is not available: there is no
 *   fixed file to play
 * - `premiere`: a premiere that has not started yet, or is airing as a live stream
 */
export type UnavailableState = (typeof UNAVAILABLE_STATES)[number]

/** What one `/player` response means for the ladder. */
export type Playability =
  /** Streams may be read from the response. */
  | { readonly kind: 'ok' }
  /** YouTube asks for proof of a real user: refresh the visitorData, try the next rung. */
  | { readonly kind: 'bot-check'; readonly reason: string }
  /** The video is in a labelled state that only opt-in rungs may try. */
  | {
      readonly kind: 'unavailable'
      readonly state: UnavailableState
      readonly status: string
      readonly reason: string
    }
  /** This client cannot play the video, for a reason without a label; another client may. */
  | { readonly kind: 'unplayable'; readonly status: string; readonly reason: string }
  /** The video cannot play in the user's region: no client changes that. */
  | { readonly kind: 'geo-blocked'; readonly status: string; readonly reason: string }
  /** The video does not exist, was removed or is private. */
  | { readonly kind: 'gone'; readonly status: string; readonly reason: string }
  /** The response is about another video, or names none: it must not be used. */
  | { readonly kind: 'mismatch'; readonly videoId: string | undefined }

/** The reasons and fields of an age gate. */
const AGE_REASON = /confirm your age|inappropriate for some users|age-restricted/iu
const AGE_STATUSES = new Set(['AGE_CHECK_REQUIRED', 'AGE_VERIFICATION_REQUIRED'])

/** VISIONOS's whole answer for a video made for kids. */
const KIDS_REASON = /^This video is not available\.?$/u

/** A private video's reason. */
const PRIVATE_REASON = /\bprivate\b/iu

/** A region restriction's reason. */
const GEO_REASON = /\b(?:country|countries|region)\b/iu

/** A past live stream's reason when its recording is not available. */
const RECORDING_REASON = /\brecording\b/iu

/** A text in YouTube's `simpleText` or `runs` form. */
function textOf(value: unknown): string | undefined {
  const simple = stringAt(value, 'simpleText')
  if (simple !== undefined) return simple
  const runs = arrayAt(value, 'runs')
    .map((run) => stringAt(run, 'text') ?? '')
    .join('')
  return runs === '' ? undefined : runs
}

/** The reason YouTube gives, and the error screen's subreason, if any. */
function reasonsOf(json: unknown): { reason: string; subreason: string } {
  const status = recordAt(json, 'playabilityStatus')
  const screen = recordAt(status, 'errorScreen', 'playerErrorMessageRenderer')
  return {
    reason: stringAt(status, 'reason') ?? textOf(at(screen, 'reason')) ?? '',
    subreason: textOf(at(screen, 'subreason')) ?? '',
  }
}

function isAgeGated(json: unknown, status: string, reason: string): boolean {
  const gate = at(json, 'playabilityStatus', 'desktopLegacyAgeGateReason')
  return (
    (typeof gate === 'number' && gate > 0) ||
    AGE_STATUSES.has(status) ||
    (status === 'LOGIN_REQUIRED' && AGE_REASON.test(reason))
  )
}

/**
 * Whether an upcoming or airing video is a premiere rather than a live stream: a premiere is
 * uploaded content, not live content, and YouTube's texts call it one ("Premieres in 3 days"),
 * where a scheduled stream says "Live in 3 days".
 */
function premiereOrLive(json: unknown, details: JsonRecord | undefined, reason: string) {
  const slate = textOf(
    at(
      json,
      'playabilityStatus',
      'liveStreamability',
      'liveStreamabilityRenderer',
      'offlineSlate',
      'liveStreamOfflineSlateRenderer',
      'mainText',
    ),
  )
  const premiere = details?.isLiveContent === false || /premiere/iu.test(`${reason} ${slate}`)
  return premiere ? 'premiere' : 'live'
}

/**
 * Classifies a `/player` response for `videoId`. A response about another video is a
 * `mismatch`, and so is a playable one that names no video, since it cannot be checked.
 */
export function classifyPlayability(json: unknown, videoId: string): Playability {
  const status = stringAt(json, 'playabilityStatus', 'status') ?? ''
  const { reason, subreason } = reasonsOf(json)
  const details = recordAt(json, 'videoDetails')
  const answered = stringAt(details, 'videoId')
  if (answered !== undefined && answered !== videoId) return { kind: 'mismatch', videoId: answered }
  const unavailable = (state: UnavailableState): Playability => ({
    kind: 'unavailable',
    state,
    status,
    reason,
  })

  if (isAgeGated(json, status, reason)) return unavailable('age-restricted')
  if (status === 'LOGIN_REQUIRED' && PRIVATE_REASON.test(reason)) {
    return { kind: 'gone', status, reason }
  }
  const botCheck = botCheckIn(json)
  if (botCheck !== undefined) return { kind: 'bot-check', reason: botCheck }
  // Live now or scheduled: there is no fixed file, whatever else the answer says.
  if (
    details?.isUpcoming === true ||
    details?.isLive === true ||
    status === 'LIVE_STREAM_OFFLINE'
  ) {
    return unavailable(premiereOrLive(json, details, reason))
  }
  if (status === 'OK') {
    if (answered === undefined) return { kind: 'mismatch', videoId: undefined }
    // A stream that has just ended, while YouTube still serves it from the live DVR.
    return details?.isPostLiveDvr === true
      ? unavailable(premiereOrLive(json, details, reason))
      : { kind: 'ok' }
  }
  if (status === 'ERROR') return { kind: 'gone', status, reason }
  // The video's own reasons come before the live-content fallback: a recording of a past stream
  // may be blocked in the region, or made for kids, which itag 18 can play.
  if (GEO_REASON.test(`${reason} ${subreason}`)) return { kind: 'geo-blocked', status, reason }
  if (status === 'UNPLAYABLE' && answered !== undefined && KIDS_REASON.test(reason)) {
    return unavailable('made-for-kids')
  }
  if (
    status === 'UNPLAYABLE' &&
    (details?.isPostLiveDvr === true ||
      (details?.isLiveContent === true && RECORDING_REASON.test(reason)))
  ) {
    return unavailable('live')
  }
  return { kind: 'unplayable', status, reason }
}

/** Details of a {@link YouTubeUnplayableError}. */
export interface UnplayableDetails {
  /** The video that cannot play. */
  readonly videoId: string
  /** The labelled state, when there is one. */
  readonly state?: UnavailableState
  /** YouTube's playability status, e.g. `UNPLAYABLE`, `ERROR` or `LOGIN_REQUIRED`. */
  readonly status: string
  /** YouTube's reason, in English, e.g. "Sign in to confirm your age". */
  readonly reason: string
}

/**
 * A verdict on one video, in the shape of the playback policy's `PlayabilityVerdict` (stage
 * 2.3, `@fxm/core`), which reads it from an error's `cause` with `playabilityVerdictOf`: the
 * only signal Smart Replace acts on. YouTube's statuses map to its two: `ERROR` (the video
 * does not exist, or no longer does) stays `ERROR`, and every other one (`UNPLAYABLE`,
 * `LOGIN_REQUIRED` for an age gate or a private video, `OK` or `LIVE_STREAM_OFFLINE` for a live
 * stream) is `UNPLAYABLE`: the video exists but cannot play here.
 */
export interface YouTubePlayabilityVerdict {
  /** Always `playability`. */
  readonly type: 'playability'
  /** Always `ytm`, the source of every YouTube audio candidate. */
  readonly source: 'ytm'
  /** The videoId. */
  readonly ref: string
  /** The verdict. */
  readonly status: 'UNPLAYABLE' | 'ERROR'
  /** YouTube's reason, for logs, when it gave one. */
  readonly reason?: string
}

/** The verdict a {@link YouTubeUnplayableError} carries as its `cause`. */
export function verdictOf(details: UnplayableDetails): YouTubePlayabilityVerdict {
  return {
    type: 'playability',
    source: 'ytm',
    ref: details.videoId,
    status: details.status === 'ERROR' ? 'ERROR' : 'UNPLAYABLE',
    ...(details.reason === '' ? {} : { reason: details.reason }),
  }
}

/**
 * The error for a video the ladder cannot play because of the video itself, not because of a
 * rung: an `FxmError` whose code is `NotFound` (YouTube's `ERROR`: removed, or never there),
 * `GeoBlocked`, or `Unavailable` (a labelled {@link UnavailableState}, a private video, or a
 * reason without a label). Its `cause` is the {@link YouTubePlayabilityVerdict} that the
 * playback policy's Smart Replace acts on; `state` is for labels, such as "Age-restricted", and
 * `status` and `reason` are YouTube's own, for logs. Bot checks, rate limits, network failures
 * and capped URLs never end in this error: they say nothing about the video.
 */
export class YouTubeUnplayableError extends FxmError {
  /** The video that cannot play. */
  readonly videoId: string
  /** The labelled state, when there is one. */
  readonly state: UnavailableState | undefined
  /** YouTube's playability status. */
  readonly status: string
  /** YouTube's reason, in English. */
  readonly reason: string

  constructor(
    code: 'Unavailable' | 'GeoBlocked' | 'NotFound',
    message: string,
    details: UnplayableDetails,
  ) {
    super(code, message, { cause: verdictOf(details) })
    this.videoId = details.videoId
    this.state = details.state
    this.status = details.status
    this.reason = details.reason
  }
}

/**
 * The {@link UnavailableState} an error carries, e.g. to label a track "Age-restricted", or
 * `undefined`. It also reads errors from another copy of this module.
 */
export function unavailableStateOf(error: unknown): UnavailableState | undefined {
  if (!(error instanceof Error) || error.name !== 'FxmError') return undefined
  const state = (error as { state?: unknown }).state
  return (UNAVAILABLE_STATES as readonly unknown[]).includes(state)
    ? (state as UnavailableState)
    : undefined
}
