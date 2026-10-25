/**
 * How the download manager finds what to download for a track: the {@link DownloadResolver}
 * interface, and {@link createPolicyDownloadResolver}, which builds one from the playback
 * policy's pieces (stage 2.3) so that downloads and playback agree on which audio a track has.
 *
 * **The touch-point with stage 1.4** (the YouTube stream resolver, not merged when 4.1 was
 * built) is the `ytm` {@link StreamSource} handed to {@link createPolicyDownloadResolver}: the
 * same object the stream lifecycle gets. Where bytes are readable it probes the end of the file
 * (`fullLength` `verified`), and every call resolves afresh, which is what a download needs
 * after a googlevideo redirect made the bytes unreadable. Until then the app passes the sources
 * it has, and tests pass `FakeStreamSource` from `@fxm/player/testing` or a
 * `FakeDownloadResolver` from `@fxm/downloads/testing`.
 *
 * @module
 */

import {
  type AudioCandidate,
  candidateKey,
  canReachAudio,
  choosePlaybackStream,
  DEFAULT_PLAYBACK_SETTINGS,
  FxmError,
  type FxmErrorCode,
  isFxmError,
  isPlayable,
  isYouTubeCandidate,
  type LadderRung,
  type MatchTarget,
  mayPlayMatch,
  type PlaybackProblem,
  type PlaybackSettings,
  type ProviderContext,
  planPlayback,
  playabilityVerdictOf,
  playbackProblemError,
  type QualityPrefs,
  type StreamOption,
  type StreamSupport,
  type Track,
  type UnavailableReason,
} from '@fxm/core'
import {
  isStoredMatch,
  type MatchKey,
  type MatchStore,
  type StoredMatch,
  type StreamSource,
  type TrackMatcher,
} from '@fxm/player'
import { isDownloadableStream } from './availability'
import { type DownloadFileFormat, fileFormatOf, sameFileFormat } from './types'

/**
 * Why the manager asks for a resolution:
 *
 * - `start`: the download starts
 * - `resume`: a paused, failed or interrupted download continues; `candidate` and `format` say
 *   what the stored part of the file holds
 * - `refresh`: the URL stopped working (expired, refused, unreadable after a redirect, or not
 *   verified): resolve afresh
 */
export type DownloadResolveReason = 'start' | 'resume' | 'refresh'

/** The details of one call to {@link DownloadResolver.resolve}. */
export interface DownloadResolveRequest {
  /** The provider context, carrying {@link DownloadResolveRequest.signal}. */
  ctx: ProviderContext
  /** The quality preferences: a hint for ordering options of equal quality. */
  prefs: QualityPrefs
  /** Why the manager asks. */
  reason: DownloadResolveReason
  /** How many fresh resolutions this run of the download needed so far. */
  attempt: number
  /** The audio the stored part of the file came from, if any: resolve it again when it can. */
  candidate?: AudioCandidate
  /** The format of the stored part of the file, if any: prefer a stream of that format. */
  format?: DownloadFileFormat
  /** URLs that failed for this download: never return one of them. */
  exclude: ReadonlySet<string>
  /** Cancels the resolution. */
  signal: AbortSignal
}

/** What to download for a track: its audio, and the stream of it to fetch. */
export interface ResolvedDownload {
  /** The audio: the track's own, its linked song or its match. */
  candidate: AudioCandidate
  /**
   * The stream to fetch: progressive, not capped, and for YouTube verified by the end-of-file
   * probe (see `isDownloadableStream`).
   */
  stream: StreamOption
}

/**
 * Finds what to download for a track. Rejects with an `FxmError` like a stream resolver does:
 * `Unsupported`, `AuthRequired` or `BotCheck` when nothing can be downloaded until the user
 * acts, `Unavailable` with a `PlaybackProblem` (`playbackProblemOf`) when there is nothing to
 * download (`needs-review` for a match that is only a best guess), `Network`, `RateLimited` or
 * `Parse` for passing trouble, and a {@link NoDownloadableStreamError} when the sources answered
 * but no stream may be downloaded.
 */
export interface DownloadResolver {
  /** What to download for `track`. */
  resolve(track: Track, request: DownloadResolveRequest): Promise<ResolvedDownload>
}

/**
 * The sources answered, but no stream may be downloaded:
 *
 * - `unverified`: YouTube streams that did not pass the end-of-file probe, e.g. because a
 *   googlevideo redirect made the probe's bytes unreadable. A fresh resolution may do better
 * - `no-stream`: nothing progressive, or nothing this device can play
 */
export class NoDownloadableStreamError extends Error {
  /** Always `NoDownloadableStreamError`. */
  override readonly name = 'NoDownloadableStreamError'
  /** Why. */
  readonly reason: 'unverified' | 'no-stream'

  constructor(reason: 'unverified' | 'no-stream', message: string) {
    super(message)
    this.reason = reason
  }
}

/** Options for {@link createPolicyDownloadResolver}. */
export interface PolicyDownloadResolverOptions {
  /**
   * The stream sources, one per audio source: the YouTube ladder for `ytm` (stage 1.4), and
   * Internet Archive and Jamendo through `fromAudioSource` (stage 1.6). The same ones the stream
   * lifecycle uses.
   */
  sources: readonly StreamSource[]
  /** The matching engine (stage 1.7), for tracks without audio of their own. */
  matcher?: TrackMatcher
  /** The match cache (stage 2.6), shared with the stream lifecycle. */
  matches?: MatchStore
  /** The user's playback settings ("prefer lossless", "Play best guesses"). */
  settings?: () => PlaybackSettings
  /**
   * How sure the player is that it can play a stream, so a download plays offline on this
   * device: `canPlayType` in a browser. Default: `maybe` for everything.
   */
  canPlay?: (stream: StreamOption) => StreamSupport
  /** The clock, in epoch milliseconds. Default: `Date.now`. */
  now?: () => number
  /** How long an unpinned stored match counts. Default: 30 days, as in the stream lifecycle. */
  maxMatchAgeMs?: number
}

/** `FxmError` codes after which nothing can be downloaded until the user acts. */
const STOP_CODES: ReadonlySet<FxmErrorCode> = new Set(['Unsupported', 'AuthRequired', 'BotCheck'])

/** `FxmError` codes that say this audio can't play from its source. */
const UNPLAYABLE_CODES: ReadonlySet<FxmErrorCode> = new Set([
  'NotFound',
  'Unavailable',
  'GeoBlocked',
])

/** Which unavailable reason wins when several steps failed, most telling first. */
const UNAVAILABLE_ORDER: readonly UnavailableReason[] = [
  'pinned-unplayable',
  'unplayable',
  'no-stream',
  'no-match',
  'no-source',
]

const DEFAULT_MAX_MATCH_AGE_MS = 30 * 24 * 60 * 60_000

/** What one resolution collected while it went through the steps. */
interface RunState {
  readonly tried: Set<string>
  readonly stops: FxmError[]
  readonly problems: PlaybackProblem[]
  /** Whether a YouTube candidate resolved only to streams the probe didn't verify. */
  unverified: boolean
}

function aborted(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && (error === signal.reason || !isFxmError(error))
}

/**
 * A {@link DownloadResolver} that follows the playback policy's order of preference
 * (`planPlayback`): the user's pin, the track's own audio, its linked song or its match, with
 * "prefer lossless" a lossless match first. It differs from playback where a download must:
 *
 * - **Only downloadable streams:** progressive, not capped, and for YouTube verified by the
 *   end-of-file probe; on the web that also rules out URLs whose bytes a googlevideo redirect
 *   made unreadable. When the top rung has none, the fallback rung (itag 18) is asked.
 * - **The best quality,** not the connection's ceiling: `lossless` as the ceiling, audio only
 *   before a muxed video, and streams this device can play first (`canPlay`), so the copy plays
 *   offline here.
 * - **No best guesses:** a Suggest-band match is never downloaded, because an offline copy would
 *   then play without review from then on. Only a pin, an Auto match or "Play best guesses" let
 *   it through; otherwise it rejects with a `needs-review` problem.
 * - **Fresh every time:** nothing is cached, so each call is a fresh resolution.
 * - No Invidious: downloads read bytes from the source itself.
 *
 * New matches go to the match cache, as the stream lifecycle stores them.
 */
export function createPolicyDownloadResolver(
  options: PolicyDownloadResolverOptions,
): DownloadResolver {
  const sources = new Map(options.sources.map((source) => [source.id, source]))
  const settingsOf = options.settings ?? (() => DEFAULT_PLAYBACK_SETTINGS)
  const canPlay = options.canPlay ?? (() => 'maybe')
  const now = options.now ?? Date.now
  const maxMatchAgeMs = options.maxMatchAgeMs ?? DEFAULT_MAX_MATCH_AGE_MS
  const matches = options.matches

  const unavailable = (track: Track, reason: UnavailableReason): PlaybackProblem => ({
    type: 'unavailable',
    trackId: track.id,
    reason,
    alternatives: [],
  })

  /**
   * The stream to download from one resolution; `unverified` when a YouTube resolution had
   * streams, but none that passed the end-of-file probe.
   */
  const choose = (
    candidate: AudioCandidate,
    found: readonly StreamOption[],
    request: DownloadResolveRequest,
  ): StreamOption | 'unverified' | undefined => {
    const usable = found.filter(
      (option) => isDownloadableStream(candidate, option) && !request.exclude.has(option.url),
    )
    if (usable.length === 0) {
      const unverified =
        isYouTubeCandidate(candidate) &&
        found.some(
          (option) =>
            option.protocol === 'progressive' &&
            option.fullLength === 'unverified' &&
            !request.exclude.has(option.url),
        )
      return unverified ? 'unverified' : undefined
    }
    const choice = { support: canPlay, ceiling: 'lossless', preferAudioOnly: true } as const
    const { format } = request
    if (format !== undefined) {
      const same = usable.filter((option) => sameFileFormat(fileFormatOf(option), format))
      const kept = choosePlaybackStream(same, choice)
      if (kept !== undefined) return kept
    }
    return choosePlaybackStream(usable, choice)
  }

  const tryCandidate = async (
    track: Track,
    candidate: AudioCandidate,
    request: DownloadResolveRequest,
    state: RunState,
    pinned: boolean,
  ): Promise<ResolvedDownload | undefined> => {
    const key = candidateKey(candidate)
    if (state.tried.has(key)) return undefined
    state.tried.add(key)
    const { ctx, signal } = request
    const source = sources.get(candidate.source)
    if (source === undefined) {
      state.problems.push(unavailable(track, 'no-source'))
      return undefined
    }
    if (!canReachAudio(candidate.source, ctx.capabilities)) {
      state.stops.push(
        new FxmError('Unsupported', `${candidate.source} audio is not reachable here`),
      )
      return undefined
    }
    if (isYouTubeCandidate(candidate) && !ctx.capabilities.mediaBytes) {
      state.stops.push(
        new FxmError(
          'Unsupported',
          'YouTube audio can only be downloaded where its bytes are readable',
        ),
      )
      return undefined
    }
    const resolveRung = (rung: LadderRung) =>
      source.resolve(candidate, {
        ctx: { ...ctx, signal },
        prefs: request.prefs,
        rung,
        priority: 'prefetch',
        signal,
      })
    try {
      const top = choose(candidate, await resolveRung('top'), request)
      let stream = top
      if (typeof stream !== 'object' && source.hasFallback === true) {
        stream = choose(candidate, await resolveRung('fallback'), request)
      }
      if (typeof stream !== 'object') {
        if (top === 'unverified' || stream === 'unverified') state.unverified = true
        else state.problems.push(unavailable(track, 'no-stream'))
        return undefined
      }
      return { candidate, stream: { ...stream } }
    } catch (error) {
      if (aborted(signal, error)) throw error
      if (
        playabilityVerdictOf(error) !== undefined ||
        (isFxmError(error) && UNPLAYABLE_CODES.has(error.code))
      ) {
        state.problems.push(unavailable(track, pinned ? 'pinned-unplayable' : 'unplayable'))
        return undefined
      }
      if (isFxmError(error) && STOP_CODES.has(error.code)) {
        state.stops.push(error)
        return undefined
      }
      throw error
    }
  }

  const stored = async (key: MatchKey): Promise<StoredMatch | undefined> => {
    if (matches === undefined) return undefined
    try {
      const match = await matches.get(key)
      return isStoredMatch(match) ? match : undefined
    } catch {
      return undefined
    }
  }

  const findMatch = async (
    track: Track,
    target: MatchTarget,
    request: DownloadResolveRequest,
    state: RunState,
  ): Promise<StoredMatch | undefined> => {
    const { ctx, signal } = request
    const key: MatchKey = { trackId: track.id, mode: ctx.mode, target }
    const known = await stored(key)
    if (known !== undefined && (known.pinned || now() - known.matchedAt <= maxMatchAgeMs)) {
      if (isPlayable(known.candidate, ctx.mode)) return known
      state.problems.push(unavailable(track, 'no-match'))
      return undefined
    }
    const matcher = options.matcher
    if (matcher === undefined) {
      state.problems.push(unavailable(track, 'no-match'))
      return undefined
    }
    if (target === 'song' && ctx.capabilities.youtube === 'none') {
      state.stops.push(new FxmError('Unsupported', 'ytm audio is not reachable here'))
      return undefined
    }
    let outcome: Awaited<ReturnType<TrackMatcher['match']>>
    try {
      outcome = await matcher.match(track, {
        target,
        ctx: { ...ctx, signal },
        exclude: [],
        priority: 'prefetch',
        signal,
      })
    } catch (error) {
      if (aborted(signal, error)) throw error
      if (isFxmError(error) && STOP_CODES.has(error.code)) {
        state.stops.push(error)
        return undefined
      }
      throw error
    }
    const usable = (candidate: AudioCandidate) => isPlayable(candidate, ctx.mode)
    const best = outcome.best !== undefined && usable(outcome.best) ? outcome.best : undefined
    if (outcome.band === 'none' || best === undefined) {
      state.problems.push(unavailable(track, 'no-match'))
      return undefined
    }
    const match: StoredMatch = {
      band: outcome.band,
      candidate: best,
      alternatives: outcome.alternatives.filter(usable),
      pinned: false,
      matchedAt: now(),
    }
    await matches?.put(key, match).catch(() => {})
    return match
  }

  const tryMatch = async (
    track: Track,
    target: MatchTarget,
    request: DownloadResolveRequest,
    state: RunState,
  ): Promise<ResolvedDownload | undefined> => {
    try {
      const match = await findMatch(track, target, request, state)
      if (match === undefined) return undefined
      const allowed = mayPlayMatch({
        target,
        band: match.band,
        isrcVerified: match.candidate.signals?.isrcVerified === true,
        pinned: match.pinned,
        // A download is never "this once": the copy would play without review from then on.
        explicit: false,
        playBestGuesses: settingsOf().playBestGuesses,
      })
      if (!allowed) {
        if (target === 'song') {
          state.problems.push({
            type: 'needs-review',
            trackId: track.id,
            guess: match.candidate,
            alternatives: match.alternatives,
          })
        }
        return undefined
      }
      return await tryCandidate(track, match.candidate, request, state, match.pinned)
    } catch (error) {
      // A lossless copy is a bonus: when looking for one fails, the song is downloaded.
      if (target === 'lossless' && !aborted(request.signal, error)) return undefined
      throw error
    }
  }

  const giveUp = (track: Track, state: RunState): Error => {
    const [stop] = state.stops
    if (stop !== undefined) return stop
    const review = state.problems.find((problem) => problem.type === 'needs-review')
    if (review !== undefined) return playbackProblemError(review)
    if (state.unverified) {
      return new NoDownloadableStreamError(
        'unverified',
        'No stream passed the end-of-file probe, or its bytes were unreadable',
      )
    }
    const reasons = new Set(
      state.problems.flatMap((problem) => (problem.type === 'unavailable' ? [problem.reason] : [])),
    )
    const reason = UNAVAILABLE_ORDER.find((candidate) => reasons.has(candidate)) ?? 'no-source'
    if (reason === 'no-stream') {
      return new NoDownloadableStreamError('no-stream', 'No stream of this track can be downloaded')
    }
    return playbackProblemError(unavailable(track, reason))
  }

  return {
    async resolve(track, request) {
      const { ctx, signal } = request
      const state: RunState = { tried: new Set(), stops: [], problems: [], unverified: false }
      // A resume asks for the audio its stored bytes came from first.
      if (request.candidate !== undefined && isPlayable(request.candidate, ctx.mode)) {
        const resumed = await tryCandidate(track, request.candidate, request, state, false)
        if (resumed !== undefined) return resumed
      }
      const settings = settingsOf()
      const pin = await stored({ trackId: track.id, mode: ctx.mode, target: 'song' })
      const steps = planPlayback({
        track,
        mode: ctx.mode,
        ...(pin?.pinned === true ? { pinned: pin.candidate } : {}),
        settings: { ...settings, useInvidious: false },
        skipOffline: true,
      })
      for (const step of steps) {
        signal.throwIfAborted()
        let resolved: ResolvedDownload | undefined
        if (step.type === 'candidate') {
          resolved = await tryCandidate(
            track,
            step.candidate,
            request,
            state,
            step.origin === 'pinned',
          )
        } else if (step.type === 'match') {
          resolved = await tryMatch(track, step.target, request, state)
        }
        if (resolved !== undefined) return resolved
      }
      throw giveUp(track, state)
    },
  }
}
