/**
 * YouTube's audio source: `resolve` walks the ladder of rungs (VISIONOS's Opus and AAC, then the
 * ANDROID client's itag 18) until one yields a playable URL, probing the end of the files where
 * the bytes can be read.
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
import type { JsonRecord } from '../json'
import {
  assertYouTubeReachable,
  createYouTubeSession,
  type YouTubeSession,
  type YouTubeSessionOptions,
} from '../session'
import { type StreamBudget, type StreamRequestPriority, UNMETERED_STREAM_BUDGET } from './budget'
import { BUNDLED_STREAM_CONFIG, type StreamConfig, type StreamRungConfig } from './config'
import { isYouTubeStreamOption, parseStreamUrl, type YouTubeStreamOption } from './formats'
import { type LadderHealth, type RungFailure, RungHealthBook, type RungHealthStore } from './health'
import { DIRECT_RUNGS, type RungTools, type StreamRungKind } from './kinds'
import { classifyPlayability, type Playability, YouTubeUnplayableError } from './playability'
import type { PlayerAnswer } from './player'
import { probeEndOfFile, statusOf } from './probe'

/**
 * The session the audio source calls YouTube through: the device's session, shared with the
 * metadata providers so that every call uses one visitorData, or the options to create one of
 * its own (see `createYouTubeSession`). Never both.
 */
export type YouTubeAudioSessionOptions =
  | {
      /** The device's YouTube session. */
      session: YouTubeSession
      config?: never
      visitorDataStore?: never
      timeoutMs?: never
    }
  | (YouTubeSessionOptions & { session?: never })

/** What {@link createYouTubeAudioSource} takes besides its session. */
export interface YouTubeStreamSourceOptions {
  /**
   * The ladder's config: a value, or a function that returns the one in use, so that a newer
   * config (see `pickYouTubeConfigs`) takes effect without a new source. The bundled one by
   * default.
   */
  streamConfig?: StreamConfig | (() => StreamConfig)
  /**
   * The rung kinds this source runs besides `direct`, e.g. stage 1.11's (see `kinds.ts`). Parse
   * the config with the same kinds, or their rungs are left out of it.
   */
  rungKinds?: readonly StreamRungKind[]
  /**
   * The request budget every InnerTube call draws on, and that hears about bot checks. Leave it
   * out when `ctx.fetch` comes from `@fxm/platform`, whose transports do both themselves.
   */
  budget?: StreamBudget
  /** Where to keep the rungs' health and the last working rung; in memory by default. */
  healthStore?: RungHealthStore
  /** How long one failure cools a rung down, in milliseconds; 5 minutes by default. */
  cooldownMs?: number
  /** The longest cool-down, in milliseconds; 1 hour by default. */
  maxCooldownMs?: number
  /**
   * How long each `/player` call may take, in milliseconds, and so may the call that asks
   * YouTube for a visitorData first in the Lite tier; 20 s by default. (A session's own
   * `timeoutMs` governs its other requests, such as `sw.js_data`.)
   */
  playerTimeoutMs?: number
  /** How long each googlevideo request of a probe or status check may take; 10 s by default. */
  probeTimeoutMs?: number
  /** The clock, for tests. */
  now?: () => number
}

/** Options for {@link createYouTubeAudioSource}: the session, and the stream options. */
export type YouTubeAudioSourceOptions = YouTubeAudioSessionOptions & YouTubeStreamSourceOptions

/**
 * Which URLs `resolve` probes at the end of their file, where the bytes can be read:
 *
 * - `best` (the default): for each codec and media, its best URL as `compareStreams` ranks them
 *   (Opus 251, AAC 140, itag 18), or the next one when that one is capped. The others stay
 *   `unverified`. Caps belong to a client, not a format, so this answers the probe's question
 *   with two requests on VISIONOS instead of five, and covers what playback and downloads pick
 *   first on Wi-Fi in any browser
 * - `all`: every URL, e.g. for a download in a lower format
 * - `none`: no URL; probe one later with `probeEndOfFile`
 */
export type ProbeMode = 'best' | 'all' | 'none'

/** Options for one {@link YouTubeAudioSource.resolve} call. */
export interface YouTubeResolveOptions {
  /** What the calls are for, for the request budget: `current-track` by default. */
  priority?: StreamRequestPriority
  /**
   * `all` (the default): the whole ladder, best rung first. `fallback`: only the last-resort rung
   * (`fallback` in the config: itag 18), e.g. after the URLs of the top of the ladder failed
   * their probe in the player. The playback policy's `rung: 'top'` and `rung: 'fallback'`.
   */
  rungs?: 'all' | 'fallback'
  /** Which URLs to probe where the bytes can be read: `best` by default (see {@link ProbeMode}). */
  probe?: ProbeMode
}

/**
 * Why a URL from the ladder failed to play, in the words of the playback policy's recovery plan
 * (stage 2.3's `RecoveryReason`). Only three say the rung is at fault, and count against it:
 *
 * - `probe-failed`: an `unverified` URL failed its first request, which is the probe where
 *   nothing could be probed before (Lite, or a Connect probe that failed CORS after a redirect)
 * - `fallback-failed`: the same, for a URL of the last-resort rung
 * - `forbidden-again`: a fresh URL of the rung answered 403 again
 *
 * The others say nothing about the rung: `expired`, `unauthorized`, `ip-changed`, `forbidden`
 * (a first 403, which is resolved again on the same rung), `first-request` (a `verified` URL
 * failed before it played, so it isn't capped), `mid-play` and `decode`.
 */
export type PlaybackFailureReason =
  | 'probe-failed'
  | 'fallback-failed'
  | 'forbidden-again'
  | 'forbidden'
  | 'ip-changed'
  | 'expired'
  | 'unauthorized'
  | 'first-request'
  | 'mid-play'
  | 'decode'

/** The {@link PlaybackFailureReason}s that count against the rung. */
const RUNG_AT_FAULT: ReadonlySet<string> = new Set([
  'probe-failed',
  'fallback-failed',
  'forbidden-again',
])

/** YouTube as an audio source. Create it with {@link createYouTubeAudioSource}. */
export interface YouTubeAudioSource extends AudioSource {
  /** Always `ytm`, YouTube's one audio source for every videoId. */
  readonly id: 'ytm'
  /** The session it calls YouTube through. */
  readonly session: YouTubeSession
  /**
   * Whether the config in use has a last-resort rung that is on and that this source runs,
   * which `resolve`'s `rungs: 'fallback'` asks for: the playback policy's
   * `StreamSource.hasFallback`.
   */
  readonly hasFallback: boolean
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
   * @throws FxmError `Unsupported` before any request: without YouTube access, for a candidate
   * of another source, when no rung that is on can run here, or with `rungs: 'fallback'` when
   * there is no such last-resort rung. `NotFound` for a malformed videoId. A
   * {@link YouTubeUnplayableError}, whose `cause` is the playback policy's playability
   * verdict, for a video the rungs can't play: `NotFound` (YouTube's `ERROR`), `GeoBlocked`,
   * or `Unavailable` (a labelled state such as `age-restricted`, a private video, or another
   * reason). `BotCheck` when every rung tried met a bot check; `Parse` when no rung's answer
   * could be used; and `RateLimited`, `Network` or the caller's cancellation as they come.
   */
  resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
    options?: YouTubeResolveOptions,
  ): Promise<YouTubeStreamOption[]>
  /**
   * Tells the ladder that a URL it resolved started playing (the player's first `playing`
   * event). Where nothing could be probed (Lite), this is what makes a rung count as working
   * and the last working rung. A `verified` URL counted when it was resolved, so it is ignored
   * here, and so is an option the ladder did not resolve.
   */
  reportPlaybackSuccess(option: StreamOption, ctx: ProviderContext): void
  /**
   * Tells the ladder that a URL it resolved failed to play, and why. Only a reason that puts
   * the rung at fault counts against it (see {@link PlaybackFailureReason}), which cools it
   * down for later resolutions of every video. Which rung to resolve the failed item on next is
   * the caller's choice (`rungs`): the ladder keeps no memory per video. Options the ladder did
   * not resolve are ignored.
   */
  reportPlaybackFailure(
    option: StreamOption,
    ctx: ProviderContext,
    reason: PlaybackFailureReason,
  ): void
  /**
   * The HTTP status a URL from the ladder answers now to a one-byte ranged GET, where the bytes
   * can be read (`ctx.capabilities.mediaBytes`): e.g. 403 when the device's IP address changed
   * since it was resolved. `undefined` where the status can't be read, after a failed request,
   * or for an option the ladder did not resolve. The playback policy's `checkStatus`.
   */
  checkStatus(option: StreamOption, ctx: ProviderContext): Promise<number | undefined>
  /** The rungs' health and the last working rung on the platform and tier of `ctx`. */
  health(ctx: ProviderContext): Promise<LadderHealth>
}

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
 * **The ladder.** The config's rungs that are on and can run here, in its order: VISIONOS (Opus
 * 251, AAC 140 and the smaller formats), then the ANDROID client's itag 18, a 360p video whose
 * AAC track plays (`media: 'muxed-video'`), the last resort. Rungs that are cooling down after
 * failing go last (see `health.ts`). The first rung that yields a playable URL wins.
 *
 * - **Probing.** Where the bytes can be read (`ctx.capabilities.mediaBytes`), the best URL of
 *   each codec and media is probed at the end of its file (see {@link ProbeMode}), and a rung
 *   whose URLs are all capped counts as failed. Elsewhere (Lite) the URLs are returned
 *   `unverified`, and the player's first request is the probe: report its outcome with
 *   `reportPlaybackSuccess` or `reportPlaybackFailure`, and resolve the failed item again,
 *   e.g. with `rungs: 'fallback'`.
 * - **Bot checks.** A `LOGIN_REQUIRED` bot check is reported to the budget; the visitorData is
 *   refreshed once per resolution, and the ladder moves on. One answered to a call sent without
 *   a visitorData is FXM's own doing, not a sign of a flagged IP address: the rung is tried
 *   again once with the visitorData YouTube issued with it, and nothing is reported.
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
  const now = options.now ?? Date.now
  const playerTimeoutMs = options.playerTimeoutMs ?? 20_000
  const probeTimeoutMs = options.probeTimeoutMs ?? 10_000
  const source = options.streamConfig ?? BUNDLED_STREAM_CONFIG
  const configOf = typeof source === 'function' ? source : () => source
  const kinds = new Map<string, StreamRungKind>([[DIRECT_RUNGS.kind, DIRECT_RUNGS]])
  for (const kind of options.rungKinds ?? []) kinds.set(kind.kind, kind)
  const book = new RungHealthBook({
    now,
    rungs: () => configOf().rungs.map((rung) => rung.id),
    ...(options.healthStore === undefined ? {} : { store: options.healthStore }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options.maxCooldownMs === undefined ? {} : { maxCooldownMs: options.maxCooldownMs }),
  })

  /** Whether `rung` can run in `ctx`: its kind is one this source runs, and it may run here. */
  function canRun(rung: StreamRungConfig, ctx: ProviderContext): boolean {
    const kind = kinds.get(rung.kind)
    const { platforms, fullAccess, mediaBytes } = rung.requires
    return (
      kind !== undefined &&
      (platforms === undefined || platforms.includes(ctx.platform)) &&
      (!fullAccess || ctx.capabilities.youtube === 'full') &&
      (!mediaBytes || ctx.capabilities.mediaBytes) &&
      (kind.canRun?.(rung, ctx) ?? true)
    )
  }

  /** The rungs to try, in order: the healthy ones first, the cooling ones after. */
  function ladderFor(
    config: StreamConfig,
    ctx: ProviderContext,
    rungs: 'all' | 'fallback',
  ): StreamRungConfig[] {
    const usable = config.rungs.filter((rung) => rung.enabled && canRun(rung, ctx))
    if (rungs === 'fallback') {
      const fallback = usable.find((rung) => rung.fallback)
      if (fallback === undefined) {
        throw new FxmError('Unsupported', 'No last-resort YouTube stream rung is on that runs here')
      }
      return [fallback]
    }
    if (usable.length === 0) {
      throw new FxmError('Unsupported', 'No YouTube stream rung is on that runs here')
    }
    const scope = scopeOf(ctx)
    const cooling = (rung: StreamRungConfig) => book.coolingUntil(scope, rung.id) !== undefined
    return [...usable.filter((rung) => !cooling(rung)), ...usable.filter(cooling)]
  }

  /**
   * The options, best first: by `compareStreams`, which within a tier ranks the higher average
   * bitrate first. Only at exactly equal ranks (rare with real bitrates) do the tie-breakers
   * apply: the codec `prefs.download.format` needs no conversion for, then the rung's own order.
   */
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

  /** `found`, with the end of its progressive URLs probed where the bytes are readable. */
  async function probed(
    ctx: ProviderContext,
    found: readonly YouTubeStreamOption[],
    mode: ProbeMode,
  ): Promise<YouTubeStreamOption[]> {
    const result = [...found]
    if (!ctx.capabilities.mediaBytes || mode === 'none') return result
    const probe = async (index: number) => {
      const option = result[index] as YouTubeStreamOption
      const checked = await probeEndOfFile(ctx, option.url, {
        timeoutMs: probeTimeoutMs,
        ...(option.contentLength === undefined ? {} : { contentLength: option.contentLength }),
      })
      result[index] = {
        ...option,
        fullLength: checked.fullLength,
        ...(checked.contentLength === undefined ? {} : { contentLength: checked.contentLength }),
      }
      return checked.fullLength
    }
    const best = [...found.keys()]
      .filter((index) => found[index]?.protocol === 'progressive')
      .sort((a, b) => compareStreams(found[a] as StreamOption, found[b] as StreamOption))
    if (mode === 'all') {
      await Promise.all(best.map(probe))
      return result
    }
    // Per codec and media, best first, until one URL is not capped.
    const groups = new Map<string, number[]>()
    for (const index of best) {
      const { codec, media } = found[index] as YouTubeStreamOption
      groups.set(`${codec}/${media}`, [...(groups.get(`${codec}/${media}`) ?? []), index])
    }
    await Promise.all(
      [...groups.values()].map(async (indices) => {
        for (const index of indices) if ((await probe(index)) !== 'capped') break
      }),
    )
    return result
  }

  /**
   * Tries one rung. Returns its options when it yields a playable URL, and otherwise records
   * why not in `attempt` and returns `undefined`, or throws when nothing else can help.
   */
  async function tryRung(
    ctx: ProviderContext,
    rung: StreamRungConfig,
    videoId: string,
    tools: RungTools,
    attempt: Attempt,
    mode: ProbeMode,
  ): Promise<YouTubeStreamOption[] | undefined> {
    const kind = kinds.get(rung.kind) as StreamRungKind
    const scope = scopeOf(ctx)
    const fail = (why: RungFailure, error: FxmError) => {
      book.fail(scope, rung.id, why)
      attempt.errors.push(error)
      return undefined
    }
    /** A `Parse` failure counts against the rung and lets the next one try; others stop. */
    const failed = (error: unknown) => {
      if (isFxmError(error, 'Parse')) return fail('error', error)
      throw error
    }

    let answer: PlayerAnswer
    let playability: Playability
    let retried = false
    for (;;) {
      try {
        answer = await kind.call(ctx, rung, videoId, tools)
      } catch (error) {
        return failed(error)
      }
      playability =
        'botCheck' in answer
          ? { kind: 'bot-check', reason: answer.botCheck }
          : classifyPlayability(answer.json, videoId)
      if (playability.kind !== 'bot-check' || answer.sentVisitorData) break
      // Sent without a visitorData: VISIONOS refuses every such call (CLEAN-ROOM.md), so the
      // answer says nothing about the IP address or the rung. Try once more with the
      // visitorData YouTube issued with it, if it issued one.
      if (retried || session.visitorData.current === undefined) {
        attempt.errors.push(
          new FxmError(
            'BotCheck',
            `YouTube answered the ${rung.id} call for ${videoId}, sent without a visitorData, with a bot check: ${playability.reason}`,
          ),
        )
        return undefined
      }
      retried = true
    }

    switch (playability.kind) {
      case 'bot-check':
        budget.reportBotCheck('login-required')
        if (!attempt.refreshed) {
          session.visitorData.invalidate()
          attempt.refreshed = true
        }
        return fail(
          'bot-check',
          new FxmError(
            'BotCheck',
            `YouTube answered the ${rung.id} call with a bot check: ${playability.reason}`,
          ),
        )
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
          { videoId, status: playability.status, reason: playability.reason },
        )
      case 'gone':
        throw new YouTubeUnplayableError(
          playability.status === 'ERROR' ? 'NotFound' : 'Unavailable',
          `${videoId} is gone: ${playability.reason || playability.status}`,
          { videoId, status: playability.status, reason: playability.reason },
        )
      case 'ok':
        break
    }

    let found: YouTubeStreamOption[]
    try {
      found = await kind.options(ctx, rung, videoId, (answer as { json: JsonRecord }).json, tools)
    } catch (error) {
      return failed(error)
    }
    if (found.length === 0) {
      return fail(
        'no-formats',
        new FxmError('Parse', `YouTube's ${rung.id} answer for ${videoId} has no direct audio`),
      )
    }
    const checked = await probed(ctx, found, mode)
    if (checked.every((option) => option.fullLength === 'capped')) {
      attempt.capped.push(...checked)
      return fail(
        'capped',
        new FxmError('Parse', `Every ${rung.id} URL for ${videoId} stops early (capped)`),
      )
    }
    // Only a URL known to play makes the rung count as working: here, one that passed the
    // probe. Where nothing was probed, the player says so (`reportPlaybackSuccess`).
    if (checked.some((option) => option.fullLength === 'verified')) book.succeed(scope, rung.id)
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
        { videoId, state: state.state, status: state.status, reason: state.reason },
      )
    }
    if (unplayable !== undefined) {
      throw new YouTubeUnplayableError(
        'Unavailable',
        `${videoId} can't play: ${unplayable.reason || unplayable.status}`,
        { videoId, status: unplayable.status, reason: unplayable.reason },
      )
    }
    const error = attempt.errors.find((entry) => entry.code === 'BotCheck') ?? attempt.errors[0]
    throw error ?? new FxmError('Parse', `No YouTube stream rung yielded a URL for ${videoId}`)
  }

  /** `option` when the ladder resolved it: a rung the config lists, and a sound videoId. */
  function ownOption(option: StreamOption): YouTubeStreamOption | undefined {
    if (!isYouTubeStreamOption(option) || !VIDEO_ID.test(option.videoId)) return undefined
    return configOf().rungs.some((rung) => rung.id === option.rung) ? option : undefined
  }

  return {
    id: 'ytm',
    session,

    get hasFallback() {
      return configOf().rungs.some((rung) => rung.fallback && rung.enabled && kinds.has(rung.kind))
    },

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
      const ladder = ladderFor(
        config,
        ctx,
        resolveOptions.rungs === 'fallback' ? 'fallback' : 'all',
      )
      const mode =
        resolveOptions.probe === 'all' || resolveOptions.probe === 'none'
          ? resolveOptions.probe
          : 'best'
      const tools: RungTools = {
        session,
        budget,
        priority: resolveOptions.priority ?? 'current-track',
        timeoutMs: playerTimeoutMs,
        config,
        now: now(),
      }
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
        const found = await tryRung(ctx, rung, videoId, tools, attempt, mode)
        if (found !== undefined) return ordered(found, config, prefs)
      }
      return ordered(outcome(attempt, videoId), config, prefs)
    },

    reportPlaybackSuccess(option, ctx) {
      const own = ownOption(option)
      if (own?.fullLength === 'unverified') book.succeed(scopeOf(ctx), own.rung)
    },

    reportPlaybackFailure(option, ctx, reason) {
      if (!RUNG_AT_FAULT.has(reason)) return
      const own = ownOption(option)
      if (own !== undefined) book.fail(scopeOf(ctx), own.rung, 'playback')
    },

    async checkStatus(option, ctx) {
      if (!ctx.capabilities.mediaBytes || !isYouTubeStreamOption(option)) return undefined
      if (parseStreamUrl(option.url) === undefined) return undefined
      return statusOf(ctx, option.url, probeTimeoutMs)
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
