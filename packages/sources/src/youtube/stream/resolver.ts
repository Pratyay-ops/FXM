/**
 * YouTube's audio source: `resolve` walks the ladder of direct rungs (VISIONOS's Opus and AAC,
 * then the ANDROID client's itag 18) until one yields a playable URL, probing the end of each
 * file where the bytes can be read.
 *
 * @module
 */

import {
  type AudioCandidate,
  type AudioSource,
  compareStreams,
  FxmError,
  isFxmError,
  modePolicy,
  type ProviderContext,
  parseId,
  type QualityPrefs,
  type StreamOption,
  songForVideo,
  type Track,
} from '@fxm/core'
import { VIDEO_ID } from '../ids'
import {
  assertYouTubeReachable,
  createYouTubeSession,
  type YouTubeSession,
  type YouTubeSessionOptions,
} from '../session'
import type { AdvancedPlayerCall, AdvancedRungs } from './advanced/hook'
import { type StreamBudget, type StreamRequestPriority, UNMETERED_STREAM_BUDGET } from './budget'
import { BUNDLED_STREAM_CONFIG, type StreamConfig, type StreamRungConfig } from './config'
import { isYouTubeStreamOption, streamOptionsOf, type YouTubeStreamOption } from './formats'
import { type LadderHealth, type RungFailure, RungHealthBook, type RungHealthStore } from './health'
import { classifyPlayability, type Playability, YouTubeUnplayableError } from './playability'
import { callPlayer } from './player'
import { probeEndOfFile } from './probe'

/** Options for {@link createYouTubeAudioSource}. */
export interface YouTubeAudioSourceOptions extends YouTubeSessionOptions {
  /**
   * The device's YouTube session, shared with the metadata providers so that every call uses
   * one visitorData. When absent, the source creates its own from the other options.
   */
  session?: YouTubeSession
  /**
   * The ladder's config: a value, or a function that returns the one in use, so that a newer
   * config (see `pickStreamConfig`) takes effect without a new source. The bundled one by
   * default.
   */
  streamConfig?: StreamConfig | (() => StreamConfig)
  /**
   * The request budget every `/player` call draws on, and that hears about bot checks. Leave it
   * out when `ctx.fetch` comes from `@fxm/platform`, whose transports do both themselves.
   */
  budget?: StreamBudget
  /** Where to keep the rungs' health and the last working rung; in memory by default. */
  healthStore?: RungHealthStore
  /** How long one failure cools a rung down, in milliseconds; 5 minutes by default. */
  cooldownMs?: number
  /** The longest cool-down, in milliseconds; 1 hour by default. */
  maxCooldownMs?: number
  /** How long one `/player` call may take, in milliseconds; 20 s by default. */
  playerTimeoutMs?: number
  /** How long one probe request may take, in milliseconds; 10 s by default. */
  probeTimeoutMs?: number
  /** The clock, for tests. */
  now?: () => number
  /**
   * The experimental rungs (stage 1.11, `createAdvancedRungs()` of `./advanced`). Without it,
   * rungs whose kind is not `direct` are never tried.
   */
  advanced?: AdvancedRungs
}

/** Options for one {@link YouTubeAudioSource.resolve} call. */
export interface YouTubeResolveOptions {
  /** What the calls are for, for the request budget: `current-track` by default. */
  priority?: StreamRequestPriority
  /**
   * Rungs not to try this time, by ID, e.g. after a URL from one of them failed to play.
   * `reportPlaybackFailure` makes later resolutions of that video skip the rung anyway.
   */
  skipRungs?: readonly string[]
}

/** YouTube as an audio source. Create it with {@link createYouTubeAudioSource}. */
export interface YouTubeAudioSource extends AudioSource {
  /** Always `ytm`, YouTube's one audio source for every videoId. */
  readonly id: 'ytm'
  /** The session it calls YouTube through. */
  readonly session: YouTubeSession
  /**
   * The candidate for a YouTube track: the track itself, or in Music mode, for an official
   * video that links its song, that song. Tracks of other sources, and videos without a linked
   * song in Music mode, get none: matching them is the matching engine's job.
   */
  match(track: Track, ctx: ProviderContext): Promise<AudioCandidate[]>
  /**
   * The stream options of a `ytm` candidate, best first (see `AudioSource.resolve`): the
   * options of the first rung that yields a playable URL, then any capped options of the rungs
   * before it. Each says its rung, itag, codec, container, bitrate, tier, expiry, IP binding,
   * whether the end-of-file probe passed (`fullLength`) and whether it is audio or a muxed
   * video. When every URL found was capped, those capped options are all it returns.
   *
   * @throws FxmError `Unsupported` without YouTube access, before any request; `NotFound` for
   * a malformed videoId; a {@link YouTubeUnplayableError} for a video the rungs can't play
   * (`Unavailable` with a labelled state such as `age-restricted`, `GeoBlocked`, `NotFound`);
   * `BotCheck` when every rung tried met a bot check; `Parse` when no rung's answer could be
   * used; and `RateLimited`, `Network` or the caller's cancellation as they come.
   */
  resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
    options?: YouTubeResolveOptions,
  ): Promise<YouTubeStreamOption[]>
  /**
   * Tells the ladder that a URL it resolved failed to play: in the Lite tier, a media error or
   * a stall before the first `playing` event, which is that tier's probe. The rung counts a
   * failure, and the next resolutions of that video, for the next 30 minutes, skip it; once
   * every rung was skipped that way, resolution starts again from the top.
   */
  reportPlaybackFailure(option: StreamOption, ctx: ProviderContext): void
  /** The rungs' health and the last working rung on the platform and tier of `ctx`. */
  health(ctx: ProviderContext): Promise<LadderHealth>
}

/** How long a failed playback makes later resolutions of that video skip the rung. */
const PLAYBACK_MEMORY_MS = 30 * 60_000

/** At most this many videos' playback failures are remembered. */
const MAX_REMEMBERED_VIDEOS = 200

/** The health scope of a context: the platform, and the tier of YouTube access. */
function scopeOf(ctx: ProviderContext): string {
  return `${ctx.platform}/${ctx.capabilities.youtube}`
}

/** The videoId of a candidate this source resolves. */
function videoIdOf(candidate: AudioCandidate): string {
  if (candidate.source !== 'ytm') {
    throw new FxmError(
      'Unsupported',
      `The YouTube audio source resolves ytm candidates, not ${String(candidate.source)}`,
    )
  }
  if (!VIDEO_ID.test(candidate.ref)) {
    throw new FxmError('NotFound', `Not a YouTube videoId: ${String(candidate.ref)}`)
  }
  return candidate.ref
}

/** What one resolution has seen so far. */
interface Attempt {
  refreshed: boolean
  state: Extract<Playability, { kind: 'unavailable' }> | undefined
  unplayable: Extract<Playability, { kind: 'unplayable' }> | undefined
  capped: YouTubeStreamOption[]
  errors: FxmError[]
}

/**
 * Creates YouTube's audio source. Share the session with the metadata providers:
 *
 * ```ts
 * const { session, music } = createYouTubeProviders({ visitorDataStore })
 * const audio = createYouTubeAudioSource({ session })
 * const options = await audio.resolve(candidate, ctx, prefs)
 * ```
 *
 * **The ladder.** The config's enabled rungs, in its order: VISIONOS (Opus 251, AAC 140 and the
 * smaller formats), then the ANDROID client's itag 18, a 360p video whose AAC track plays
 * (`media: 'muxed-video'`). Rungs that are cooling down after failing go last (see
 * `health.ts`). The first rung that yields a playable URL wins.
 *
 * - **Probing.** Where the bytes can be read (`ctx.capabilities.mediaBytes`), every URL is
 *   probed at the end of its file, and a rung whose URLs are all capped counts as failed.
 *   Elsewhere (Lite) the URLs are returned `unverified`, and the player's first request is the
 *   probe: report a failure with `reportPlaybackFailure`, then resolve again.
 * - **Bot checks.** A `LOGIN_REQUIRED` bot check is reported to the budget; the visitorData is
 *   refreshed once per resolution, and the ladder moves on.
 * - **Unavailable states.** An age gate, a video made for kids, a live stream or a premiere
 *   stops the ladder, except for later rungs that opt in to that state (`tries`); the bundled
 *   config lets itag 18 try videos made for kids. Then it fails with a labelled
 *   {@link YouTubeUnplayableError}.
 * - **Wrong video.** A response about another video is never used.
 */
export function createYouTubeAudioSource(
  options: YouTubeAudioSourceOptions = {},
): YouTubeAudioSource {
  const session = options.session ?? createYouTubeSession(options)
  const budget = options.budget ?? UNMETERED_STREAM_BUDGET
  const { advanced } = options
  const now = options.now ?? Date.now
  const playerTimeoutMs = options.playerTimeoutMs ?? 20_000
  const probeTimeoutMs = options.probeTimeoutMs ?? 10_000
  const source = options.streamConfig ?? BUNDLED_STREAM_CONFIG
  const configOf = typeof source === 'function' ? source : () => source
  const book = new RungHealthBook({
    now,
    ...(options.healthStore === undefined ? {} : { store: options.healthStore }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options.maxCooldownMs === undefined ? {} : { maxCooldownMs: options.maxCooldownMs }),
  })
  /** Rungs whose URLs failed to play, per videoId, with when to forget it. */
  const playbackFailures = new Map<string, Map<string, number>>()

  function failedRungs(videoId: string): Set<string> {
    const failures = playbackFailures.get(videoId)
    const time = now()
    for (const [rung, until] of failures ?? []) if (until <= time) failures?.delete(rung)
    if (failures?.size === 0) playbackFailures.delete(videoId)
    return new Set(failures?.keys())
  }

  /**
   * The rungs to try, in order: the healthy ones first, the cooling ones after. A rung whose kind
   * is not `direct` is tried only when the advanced hook can run it here (`canRun`).
   */
  function ladderFor(
    config: StreamConfig,
    scope: string,
    videoId: string,
    skip: ReadonlySet<string>,
    ctx: ProviderContext,
  ): StreamRungConfig[] {
    const enabled = config.rungs.filter(
      (rung) => rung.enabled && (rung.kind === 'direct' || advanced?.canRun(rung, ctx) === true),
    )
    if (enabled.length === 0) {
      throw new FxmError('Unsupported', 'Every YouTube stream rung is switched off in the config')
    }
    const failed = failedRungs(videoId)
    let left = enabled.filter((rung) => !skip.has(rung.id) && !failed.has(rung.id))
    if (left.length === 0 && failed.size > 0) {
      // Every rung left failed to play this video: resolve it again from the top.
      playbackFailures.delete(videoId)
      left = enabled.filter((rung) => !skip.has(rung.id))
    }
    if (left.length === 0) {
      throw new FxmError('Unavailable', `No YouTube stream rung is left to try for ${videoId}`)
    }
    const cooling = (rung: StreamRungConfig) => book.coolingUntil(scope, rung.id) !== undefined
    return [...left.filter((rung) => !cooling(rung)), ...left.filter(cooling)]
  }

  /** The options, best first: `compareStreams`, then `prefs`, then the config's preference. */
  function ordered(
    found: readonly YouTubeStreamOption[],
    config: StreamConfig,
    prefs: QualityPrefs,
  ): YouTubeStreamOption[] {
    const format = prefs.download.format
    const preferred = format === 'opus' || format === 'aac' ? format : undefined
    const rank = (option: YouTubeStreamOption) => {
      const rung = config.rungs.findIndex((entry) => entry.id === option.rung)
      const itags = config.rungs[rung]?.itags ?? []
      return (rung < 0 ? config.rungs.length : rung) * 100 + itags.indexOf(option.itag)
    }
    return [...found].sort(
      (a, b) =>
        compareStreams(a, b) ||
        Number(b.codec === preferred) - Number(a.codec === preferred) ||
        rank(a) - rank(b),
    )
  }

  async function probed(
    ctx: ProviderContext,
    found: readonly YouTubeStreamOption[],
  ): Promise<YouTubeStreamOption[]> {
    if (!ctx.capabilities.mediaBytes) return [...found]
    return Promise.all(
      found.map(async (option) => {
        // Only a file can be probed at its end; a SABR session has no file.
        if (option.protocol !== 'progressive') return option
        const result = await probeEndOfFile(ctx, option.url, {
          timeoutMs: probeTimeoutMs,
          ...(option.contentLength === undefined ? {} : { contentLength: option.contentLength }),
        })
        return {
          ...option,
          fullLength: result.fullLength,
          ...(result.contentLength === undefined ? {} : { contentLength: result.contentLength }),
        }
      }),
    )
  }

  /**
   * Tries one rung. Returns its options when it yields a playable URL, and otherwise records
   * why not in `attempt` and returns `undefined`, or throws when nothing else can help.
   */
  async function tryRung(
    ctx: ProviderContext,
    rung: StreamRungConfig,
    videoId: string,
    config: StreamConfig,
    priority: StreamRequestPriority,
    attempt: Attempt,
  ): Promise<YouTubeStreamOption[] | undefined> {
    const scope = scopeOf(ctx)
    const fail = (why: RungFailure, error: FxmError) => {
      book.fail(scope, rung.id, why)
      attempt.errors.push(error)
      return undefined
    }
    const botCheck = (sentVisitorData: boolean, reason: string) => {
      budget.reportBotCheck('login-required')
      if (sentVisitorData && !attempt.refreshed) {
        session.visitorData.invalidate()
        attempt.refreshed = true
      }
      return fail(
        'bot-check',
        new FxmError(
          'BotCheck',
          `YouTube answered the ${rung.id} call with a bot check: ${reason}`,
        ),
      )
    }

    // An experimental rung's own steps (the player script, BotGuard, the evaluator) failing
    // counts against the rung, like an unreadable answer; the ladder goes on.
    const advancedFailure = (error: unknown) => {
      if (ctx.signal?.aborted || isFxmError(error, 'RateLimited')) throw error
      return fail(
        'error',
        isFxmError(error)
          ? error
          : new FxmError('Parse', `The ${rung.id} rung failed`, { cause: error }),
      )
    }
    let call: AdvancedPlayerCall = {}
    if (rung.kind !== 'direct') {
      try {
        call = (await advanced?.prepare(ctx, rung, videoId)) ?? {}
      } catch (error) {
        return advancedFailure(error)
      }
    }

    let answer: Awaited<ReturnType<typeof callPlayer>>
    try {
      answer = await callPlayer(ctx, rung.client, videoId, {
        session,
        budget,
        priority,
        timeoutMs: playerTimeoutMs,
        ...(call.payload === undefined ? {} : { payload: call.payload }),
        ...(call.headers === undefined ? {} : { headers: call.headers }),
      })
    } catch (error) {
      if (isFxmError(error, 'Parse')) return fail('error', error)
      throw error
    }
    if ('botCheck' in answer) return botCheck(answer.sentVisitorData, answer.botCheck)

    const playability = classifyPlayability(answer.json, videoId)
    switch (playability.kind) {
      case 'bot-check':
        return botCheck(answer.sentVisitorData, playability.reason)
      case 'mismatch':
        return fail(
          'mismatch',
          new FxmError(
            'Parse',
            `YouTube answered the ${rung.id} call for ${videoId} about ${playability.videoId ?? 'no video'}`,
          ),
        )
      case 'unavailable':
        attempt.state = playability
        return undefined
      case 'unplayable':
        attempt.unplayable ??= playability
        return undefined
      case 'geo-blocked':
        throw new YouTubeUnplayableError(
          'GeoBlocked',
          `${videoId} can't play in this region: ${playability.reason}`,
          playability,
        )
      case 'gone':
        throw new YouTubeUnplayableError(
          'NotFound',
          `${videoId} is gone: ${playability.reason || playability.status}`,
          playability,
        )
      case 'ok':
        break
    }

    let found: YouTubeStreamOption[]
    if (rung.kind === 'direct') {
      found = streamOptionsOf(answer.json, videoId, rung, config, now())
    } else {
      try {
        found = (await advanced?.streamOptions(ctx, rung, answer.json, videoId, config)) ?? []
      } catch (error) {
        return advancedFailure(error)
      }
    }
    if (found.length === 0) {
      return fail(
        'no-formats',
        new FxmError('Parse', `YouTube's ${rung.id} answer for ${videoId} has no direct audio`),
      )
    }
    const checked = await probed(ctx, found)
    if (checked.every((option) => option.fullLength === 'capped')) {
      attempt.capped.push(...checked)
      return fail(
        'capped',
        new FxmError('Parse', `Every ${rung.id} URL for ${videoId} stops early (capped)`),
      )
    }
    book.succeed(scope, rung.id)
    return [...checked, ...attempt.capped]
  }

  /** What to say when no rung yielded a playable URL. */
  function outcome(attempt: Attempt, videoId: string): YouTubeStreamOption[] {
    if (attempt.capped.length > 0) return attempt.capped
    const { state, unplayable } = attempt
    if (state !== undefined) {
      throw new YouTubeUnplayableError(
        'Unavailable',
        `${videoId} is unavailable (${state.state}): ${state.reason || state.status}`,
        state,
      )
    }
    if (unplayable !== undefined) {
      throw new YouTubeUnplayableError(
        'Unavailable',
        `${videoId} can't play: ${unplayable.reason || unplayable.status}`,
        unplayable,
      )
    }
    const error = attempt.errors.find((entry) => entry.code === 'BotCheck') ?? attempt.errors[0]
    throw error ?? new FxmError('Parse', `No YouTube stream rung yielded a URL for ${videoId}`)
  }

  return {
    id: 'ytm',
    session,

    async match(track, ctx) {
      const parts = parseId(track.id as unknown)
      if (parts === null || (parts.source !== 'ytm' && parts.source !== 'yt')) return []
      const artists = track.artists.map((artist) => artist.name)
      const verdict = modePolicy(track, ctx.mode)
      if (verdict === 'playable' && VIDEO_ID.test(parts.nativeId)) {
        return [
          {
            source: 'ytm',
            ref: parts.nativeId,
            kind: track.kind,
            title: track.title,
            artists,
            ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
            confidence: 1,
            evidence: ['own audio'],
          },
        ]
      }
      const song = verdict === 'plays-linked-song' ? songForVideo(track) : undefined
      const linked = song === undefined ? null : parseId(song)
      if (linked === null || !VIDEO_ID.test(linked.nativeId)) return []
      if (linked.source !== 'ytm' && linked.source !== 'yt') return []
      return [
        {
          source: 'ytm',
          ref: linked.nativeId,
          kind: 'song',
          title: track.title,
          artists,
          confidence: 1,
          evidence: ['song linked by YouTube'],
        },
      ]
    },

    async resolve(candidate, ctx, prefs, resolveOptions = {}) {
      const videoId = videoIdOf(candidate)
      assertYouTubeReachable(ctx)
      ctx.signal?.throwIfAborted()
      await book.ready()
      const config = configOf()
      const skip = new Set(resolveOptions.skipRungs)
      const ladder = ladderFor(config, scopeOf(ctx), videoId, skip, ctx)
      const priority = resolveOptions.priority ?? 'current-track'
      const attempt: Attempt = {
        refreshed: false,
        state: undefined,
        unplayable: undefined,
        capped: [],
        errors: [],
      }
      for (const rung of ladder) {
        // Once the video is in a labelled state, only rungs that opt in to it may try it.
        if (attempt.state !== undefined && !rung.tries.includes(attempt.state.state)) continue
        ctx.signal?.throwIfAborted()
        const found = await tryRung(ctx, rung, videoId, config, priority, attempt)
        if (found !== undefined) return ordered(found, config, prefs)
      }
      return ordered(outcome(attempt, videoId), config, prefs)
    },

    reportPlaybackFailure(option, ctx) {
      if (!isYouTubeStreamOption(option)) return
      book.fail(scopeOf(ctx), option.rung, 'playback')
      const failures = playbackFailures.get(option.videoId) ?? new Map<string, number>()
      failures.set(option.rung, now() + PLAYBACK_MEMORY_MS)
      playbackFailures.delete(option.videoId)
      playbackFailures.set(option.videoId, failures)
      while (playbackFailures.size > MAX_REMEMBERED_VIDEOS) {
        const oldest = playbackFailures.keys().next().value
        if (oldest === undefined) break
        playbackFailures.delete(oldest)
      }
    },

    async health(ctx) {
      await book.ready()
      return book.snapshot(
        scopeOf(ctx),
        configOf().rungs.map((rung) => rung.id),
      )
    },
  }
}
