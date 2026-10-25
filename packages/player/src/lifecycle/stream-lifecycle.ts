/**
 * The stream lifecycle (stage 2.3): the `StreamResolver` the player asks for every stream. It
 * applies the playback policy from `@fxm/core` and keeps the state around it:
 *
 * - the order of preference: an offline copy, the pin or the recorded candidate, a lossless
 *   match with "prefer lossless", the track's own audio or its matched song, Invidious, and
 *   "Unavailable" (`planPlayback`)
 * - Suggest-band guesses play only after an explicit user action or with "Play best guesses";
 *   otherwise the queue skips them, marked "needs review"
 * - the URL cache, per audio candidate and per network, flushed on network changes and on a 403
 *   for a cached URL
 * - probing: a failed probe (an end-of-file probe that found the URL capped, or in the Lite
 *   tier a failure of the media element's first request) falls back to the source's last-resort
 *   rung, then resolves again (`planStreamRecovery`)
 * - re-resolution on expiry, 401, 403, 410, stalls and media errors; the player resumes at the
 *   same position
 * - prefetching the next tracks, and sharing resolutions that are in flight
 * - Smart Replace, only on a playability verdict while other videos resolve, never for a pin
 * - the format choice per `canPlayType`
 *
 * The player itself does the retries with backoff and the circuit breaker after 4 failed
 * tracks; the lifecycle makes sure each retry gets fresh audio.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  candidateKey,
  canReachAudio,
  choosePlaybackStream,
  currentQueueItem,
  DEFAULT_PLAYBACK_SETTINGS,
  DEFAULT_QUALITY_PREFS,
  DEFAULT_STREAMING_SETTINGS,
  entityKey,
  FxmError,
  type FxmErrorCode,
  httpStatusOf,
  isFxmError,
  isPlayable,
  isYouTubeCandidate,
  type LadderRung,
  linkedSongCandidate,
  type MatchTarget,
  mayPlayMatch,
  ownCandidate,
  type PlaybackProblem,
  type PlaybackSettings,
  type PlaybackStep,
  type ProbePlan,
  type ProbeScope,
  type ProviderContext,
  planPlayback,
  planStreamRecovery,
  playabilityVerdictOf,
  playbackProblemError,
  playbackProblemOf,
  type QualityPrefs,
  type QueueItem,
  type SmartReplaceAction,
  type SourceId,
  type StreamChoice,
  type StreamFailureKind,
  type StreamingSettings,
  type StreamOption,
  sameCandidate,
  smartReplaceAction,
  streamingProfile,
  streamsUsableUntil,
  type Track,
  type UnavailableReason,
  URL_REFRESH_MARGIN_MS,
  upcomingQueueItems,
} from '@fxm/core'
import { Emitter, type Listener } from '../emitter'
import { isEngineError, type PlaySupport } from '../engine'
import type { Player, TrackChangeCause } from '../player'
import type { ResolvedStream, ResolveRequest, StreamFailure, StreamResolver } from '../resolver'
import {
  createMemoryMatchStore,
  isStoredMatch,
  type MatchKey,
  type MatchOutcome,
  type MatchStore,
  matchKeyString,
  type OfflineStore,
  type ResolvePriority,
  type StoredMatch,
  type StreamSource,
  type TrackMatcher,
} from './adapters'
import { InFlight } from './in-flight'
import { createStaticNetworkMonitor, type NetworkMonitor } from './network'
import { resolutionKey, UrlCache } from './url-cache'

/** How the lifecycle is put together and tuned. */
export interface StreamLifecycleOptions {
  /**
   * Resolves candidates into streams, one per audio source: the YouTube ladder for `ytm` (1.4),
   * Internet Archive and Jamendo (1.6, through `fromAudioSource`), local files (4.4).
   */
  sources: readonly StreamSource[]
  /** Finds songs and lossless copies for tracks (1.7). Without one, only stored matches play. */
  matcher?: TrackMatcher
  /** Where matches are kept (2.6). Default: in memory. */
  matches?: MatchStore
  /** Offline copies (4.1). */
  offline?: OfflineStore
  /**
   * Resolves YouTube candidates through the Invidious instance the user entered. Used only
   * while the `useInvidious` setting is on.
   */
  invidious?: StreamSource
  /** The provider context for every call, read afresh each time: the tier can change. */
  context: () => ProviderContext
  /** The user's quality settings. Default: `DEFAULT_QUALITY_PREFS`. */
  qualityPrefs?: () => QualityPrefs
  /**
   * Which connection's quality ceiling to follow, and the data saver (stage 4.3): see
   * `streamingProfile`. Default: `DEFAULT_STREAMING_SETTINGS` (the detected connection, data
   * saver off).
   */
  streaming?: () => StreamingSettings
  /** The user's playback settings. Default: `DEFAULT_PLAYBACK_SETTINGS`. */
  settings?: () => PlaybackSettings
  /** The network monitor. Default: one that never changes. */
  network?: NetworkMonitor
  /** The clock, in epoch milliseconds. Default: `Date.now`. */
  now?: () => number
  /** How many upcoming tracks to prefetch, the next one included. Default: 3. */
  prefetchCount?: number
  /** Stop handing out a cached URL this long before it expires. Default: 10 minutes. */
  refreshBeforeExpiryMs?: number
  /** How long to hand out cached URLs that carry no expiry. Default: 1 hour. */
  maxUrlAgeMs?: number
  /**
   * How recent another item's resolution must be to prove that the source still resolves, for
   * Smart Replace. Default: 30 minutes.
   */
  evidenceWindowMs?: number
  /** How long an unpinned stored match counts before it is matched again. Default: 30 days. */
  maxMatchAgeMs?: number
  /** How many times Smart Replace may replace a track's match within one resolution. Default: 2. */
  maxReplacements?: number
}

/** The defaults behind {@link StreamLifecycleOptions}. */
export const LIFECYCLE_DEFAULTS = Object.freeze({
  prefetchCount: 3,
  refreshBeforeExpiryMs: URL_REFRESH_MARGIN_MS,
  maxUrlAgeMs: 60 * 60_000,
  evidenceWindowMs: 30 * 60_000,
  maxMatchAgeMs: 30 * 24 * 60 * 60_000,
  maxReplacements: 2,
})

/**
 * A track whose match needs the user's review: its best match is a Suggest-band guess they have
 * not confirmed, whether a queue skipped it or a tap let it play. It stays listed until the user
 * confirms a version ({@link StreamLifecycle.confirmMatch}) or a later match lands in the Auto
 * band; the queue panel shows the ones in the queue.
 */
export interface ReviewItem {
  /** The track. */
  readonly track: Track
  /** The best guess. */
  readonly guess: AudioCandidate
  /** The other candidates, best first. */
  readonly alternatives: readonly AudioCandidate[]
}

/** Why every cached URL was dropped. */
export type FlushReason = 'network' | 'ip-changed' | 'manual'

/** The events a {@link StreamLifecycle} announces, with their payloads. */
export interface LifecycleEventMap {
  /** The list of items that need review changed; the payload is the whole new list. */
  reviewchange: readonly ReviewItem[]
  /** Smart Replace swapped a track's match, whose audio is gone, for a new one. */
  smartreplace: { track: Track; from: AudioCandidate; to: AudioCandidate }
  /** Every cached URL was dropped. */
  flush: { reason: FlushReason; dropped: number }
}

/** What the lifecycle reads from the player it serves (see {@link StreamLifecycle.attach}). */
export type LifecyclePlayer = Pick<Player, 'getState' | 'subscribe' | 'on'>

/** Track changes after which the new item counts as asked for by the user. */
const EXPLICIT_CAUSES: ReadonlySet<TrackChangeCause> = new Set([
  'queue',
  'jump',
  'previous',
  'restore',
])

/** Player statuses from which a move to `loading` is the user pressing play. */
const IDLE_STATUSES: ReadonlySet<string> = new Set(['idle', 'paused', 'ended', 'error'])

/** `FxmError` codes that no retry fixes until the user acts: the player then stops. */
const STOP_CODES: ReadonlySet<FxmErrorCode> = new Set(['Unsupported', 'AuthRequired', 'BotCheck'])

/** `FxmError` codes that say this candidate cannot play from this source. */
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

/** The most evidence entries kept. */
const MAX_EVIDENCE = 32

/** The channel of resolutions through the user's Invidious instance (see {@link resolutionKey}). */
const INVIDIOUS = 'invidious'

/** What the lifecycle knows about a stream it handed to the player. */
interface Issued {
  readonly candidate: AudioCandidate
  readonly source: StreamSource
  readonly rung: LadderRung
  /** Whether it came from the URL cache. */
  readonly cached: boolean
  readonly network: string
  /** The source's ID, or {@link INVIDIOUS}. */
  readonly channel: string
  /** The {@link resolutionKey} of the resolution it came from. */
  readonly key: string
}

/** One resolution of candidate options, from the cache or the source. */
interface Resolution {
  readonly options: readonly StreamOption[]
  readonly cached: boolean
  readonly network: string
  readonly channel: string
  readonly key: string
}

/** How one run of the policy goes. */
interface RunOptions {
  readonly ctx: ProviderContext
  /** Whether the user asked for this item just now. */
  readonly explicit: boolean
  readonly priority: ResolvePriority
  readonly canPlay: (stream: StreamOption) => PlaySupport
  readonly signal: AbortSignal
  readonly skipOffline: boolean
}

/** What one run of the policy collected while it went through the steps. */
interface RunState {
  /** Candidates tried in this run, by key. */
  readonly tried: Set<string>
  /** Problems of steps that found nothing. */
  readonly problems: PlaybackProblem[]
  /** Errors after which nothing plays until the user acts. */
  readonly stops: FxmError[]
  /** Alternatives the matching engine offered. */
  readonly alternatives: AudioCandidate[]
  /** The first candidate Smart Replace found gone in this run. */
  replaced: AudioCandidate | undefined
  /** The first YouTube candidate that may play, for Invidious. */
  youtube: { candidate: AudioCandidate; record: boolean } | undefined
}

/** A recent successful resolution, proof that a source still resolves on a network. */
interface Evidence {
  readonly network: string
  readonly source: string
  readonly key: string
  readonly at: number
}

function trackKey(track: Track): string {
  return entityKey(track.id)
}

function formatOf(stream: StreamOption): string {
  return `${stream.codec}/${stream.container}`
}

/** The kind of a playback failure, for `planStreamRecovery`. */
function failureKind(error: Error): StreamFailureKind {
  if (isEngineError(error, 'expired') || isFxmError(error, 'Expired')) return 'expired'
  if (isEngineError(error, 'decode')) return 'decode'
  return 'media'
}

/** What a player that is not attached can play: anything but a capped stream, maybe. */
function guessSupport(stream: StreamOption): PlaySupport {
  return stream.fullLength === 'capped' ? 'no' : 'maybe'
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function aborted(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && (error === signal.reason || !isFxmError(error))
}

/**
 * Resolves queue items into streams for the player, following the playback policy. Pass it to
 * the player as its resolver, then {@link attach} the player:
 *
 * ```ts
 * const lifecycle = new StreamLifecycle({ sources, matcher, context: () => ctx, network })
 * const player = new Player({ engine, resolver: lifecycle })
 * lifecycle.attach(player)
 * ```
 *
 * Attaching tells the lifecycle which item the user asked for (a Suggest-band guess plays only
 * then) and lets it prefetch the next tracks when the player announces `preload`.
 */
export class StreamLifecycle implements StreamResolver {
  readonly #sources: ReadonlyMap<string, StreamSource>
  readonly #matcher: TrackMatcher | undefined
  readonly #matches: MatchStore
  readonly #offline: OfflineStore | undefined
  readonly #invidious: StreamSource | undefined
  readonly #context: () => ProviderContext
  readonly #prefs: () => QualityPrefs
  readonly #streaming: () => StreamingSettings
  readonly #settings: () => PlaybackSettings
  readonly #network: NetworkMonitor
  readonly #now: () => number
  readonly #config: {
    prefetchCount: number
    refreshBeforeExpiryMs: number
    maxUrlAgeMs: number
    evidenceWindowMs: number
    maxMatchAgeMs: number
    maxReplacements: number
  }
  readonly #events = new Emitter<LifecycleEventMap>()
  readonly #cache = new UrlCache()
  readonly #resolving = new InFlight<readonly StreamOption[]>()
  readonly #matching = new InFlight<MatchOutcome>()
  /** The streams handed to the player, each a copy of its option. */
  readonly #issued = new WeakMap<StreamOption, Issued>()
  /** Signed URLs that failed on the current network, and offline copies that failed. */
  readonly #failedUrls = new Set<string>()
  /** Formats (`codec/container`) that failed to decode, per candidate key. */
  readonly #badFormats = new Map<string, Set<string>>()
  /** The rung to resolve each candidate on, per network and candidate key; `top` when absent. */
  readonly #rungs = new Map<string, LadderRung>()
  /** 403s per network, candidate key and rung. */
  readonly #forbidden = new Map<string, number>()
  /** Candidates Smart Replace found gone, per track key. */
  readonly #dead = new Map<string, Map<string, AudioCandidate>>()
  /** Items that need review, per track key. */
  readonly #reviews = new Map<string, ReviewItem>()
  #evidence: Evidence[] = []
  /** The uid of the item the user asked for, while it is current. */
  #explicitUid: number | undefined
  #canPlay: (stream: StreamOption) => PlaySupport = guessSupport
  #player: LifecyclePlayer | undefined
  #detachPlayer: (() => void) | undefined
  #prefetchGeneration = 0
  readonly #prefetchAbort = new AbortController()
  readonly #stopNetwork: () => void
  #destroyed = false

  constructor(options: StreamLifecycleOptions) {
    this.#sources = new Map(options.sources.map((source) => [source.id, source]))
    this.#matcher = options.matcher
    this.#matches = options.matches ?? createMemoryMatchStore()
    this.#offline = options.offline
    this.#invidious = options.invidious
    this.#context = options.context
    this.#prefs = options.qualityPrefs ?? (() => DEFAULT_QUALITY_PREFS)
    this.#streaming = options.streaming ?? (() => DEFAULT_STREAMING_SETTINGS)
    this.#settings = options.settings ?? (() => DEFAULT_PLAYBACK_SETTINGS)
    this.#network = options.network ?? createStaticNetworkMonitor()
    this.#now = options.now ?? Date.now
    const d = LIFECYCLE_DEFAULTS
    this.#config = {
      prefetchCount: Math.floor(nonNegative(options.prefetchCount, d.prefetchCount)),
      refreshBeforeExpiryMs: nonNegative(options.refreshBeforeExpiryMs, d.refreshBeforeExpiryMs),
      maxUrlAgeMs: nonNegative(options.maxUrlAgeMs, d.maxUrlAgeMs),
      evidenceWindowMs: nonNegative(options.evidenceWindowMs, d.evidenceWindowMs),
      maxMatchAgeMs: nonNegative(options.maxMatchAgeMs, d.maxMatchAgeMs),
      maxReplacements: Math.floor(nonNegative(options.maxReplacements, d.maxReplacements)),
    }
    this.#stopNetwork = this.#network.subscribe(() => this.#flush('network'))
  }

  // --- The resolver --------------------------------------------------------------------------

  /** Resolves the stream to play `item` (see `StreamResolver`). */
  async resolve(item: QueueItem, request: ResolveRequest): Promise<ResolvedStream> {
    if (this.#destroyed) throw new Error('The stream lifecycle was destroyed')
    this.#canPlay = request.canPlay
    const ctx = this.#ctx(request.signal)
    if (request.failure !== undefined) await this.#recover(request.failure, ctx, request.signal)
    const replace = request.reason === 'replace'
    if (replace && item.candidate !== undefined) {
      await this.#pin(item.track, item.candidate, ctx.mode)
    }
    return this.#run(item, {
      ctx,
      explicit: this.#isExplicit(item, request),
      priority: request.reason === 'preload' ? 'prefetch' : 'playback',
      canPlay: request.canPlay,
      signal: request.signal,
      skipOffline: replace,
    })
  }

  // --- The player ----------------------------------------------------------------------------

  /**
   * Follows `player`: which item the user asked for (a tap, a jump, "previous", a restored
   * queue, or play on a paused or stopped item), so that its Suggest-band guess may play, and
   * its `preload` events, to prefetch the next tracks. Returns a function that stops following.
   */
  attach(player: LifecyclePlayer): () => void {
    this.#detachPlayer?.()
    this.#player = player
    const stops = [
      player.on('trackchange', ({ item, cause }) => {
        this.#explicitUid = item !== undefined && EXPLICIT_CAUSES.has(cause) ? item.uid : undefined
      }),
      player.subscribe((state, previous) => {
        if (state.status !== 'loading' || !IDLE_STATUSES.has(previous.status)) return
        const item = currentQueueItem(state.queue)
        if (item !== undefined) this.#explicitUid = item.uid
      }),
      player.on('preload', ({ next, upcoming }) => this.prefetch([next, ...upcoming])),
    ]
    const detach = () => {
      for (const stop of stops) stop()
      // A detach from an earlier `attach` leaves the newer one alone.
      if (this.#detachPlayer !== detach) return
      this.#detachPlayer = undefined
      this.#player = undefined
      this.#explicitUid = undefined
    }
    this.#detachPlayer = detach
    return detach
  }

  /**
   * Resolves the first {@link StreamLifecycleOptions.prefetchCount} of `items` ahead of time,
   * one after another, into the URL cache, skipping the current item. Their matches are looked
   * up too, so Suggest-band guesses show up as "needs review" before the queue reaches them.
   * A later call takes over from an earlier one.
   */
  prefetch(items: readonly QueueItem[]): void {
    if (this.#destroyed) return
    const player = this.#player
    const current = player === undefined ? undefined : currentQueueItem(player.getState().queue)
    const seen = new Set<number>()
    const chosen: QueueItem[] = []
    for (const item of items) {
      if (chosen.length >= this.#config.prefetchCount) break
      if (item.uid === current?.uid || seen.has(item.uid)) continue
      seen.add(item.uid)
      chosen.push(item)
    }
    this.#prefetchGeneration += 1
    void this.#prefetchChain(chosen, this.#prefetchGeneration)
  }

  // --- Matches and reviews -------------------------------------------------------------------

  /**
   * Pins `candidate` as the audio for `track`: the user's pick, e.g. a guess they confirmed in
   * the review. A pin always plays first and is never swapped or deleted by the lifecycle.
   */
  async confirmMatch(track: Track, candidate: AudioCandidate): Promise<void> {
    await this.#pin(track, candidate, this.#context().mode)
  }

  /** The items whose match needs the user's review, in the order they were found. */
  reviews(): readonly ReviewItem[] {
    return [...this.#reviews.values()]
  }

  // --- Cache and events ----------------------------------------------------------------------

  /** Drops every cached URL, e.g. when the platform reports a network change of its own. */
  flush(): void {
    if (!this.#destroyed) this.#flush('manual')
  }

  /** Adds a listener for one {@link LifecycleEventMap} event. Returns a function that removes it. */
  on<K extends keyof LifecycleEventMap>(
    type: K,
    listener: Listener<LifecycleEventMap[K]>,
  ): () => void {
    return this.#events.on(type, listener)
  }

  /** Stops prefetching, follows no player or network any more and drops every cached URL. */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#prefetchAbort.abort()
    this.#detachPlayer?.()
    this.#stopNetwork()
    this.#cache.clear()
    this.#resolving.clear()
    this.#matching.clear()
    this.#events.clear()
  }

  // --- Running the policy --------------------------------------------------------------------

  #ctx(signal: AbortSignal): ProviderContext {
    return { ...this.#context(), signal }
  }

  #isExplicit(item: QueueItem, request: ResolveRequest): boolean {
    if (request.reason === 'replace') return true
    if (request.reason === 'preload') return false
    // The player never retries an item it skipped as unavailable or needing review by itself:
    // only when the user plays it again.
    const failure = request.failure
    if (failure?.stream === undefined && playbackProblemOf(failure?.error) !== undefined) {
      return true
    }
    return this.#explicitUid === item.uid
  }

  /** Goes through the policy's steps for `item` until one gives a stream. */
  async #run(item: QueueItem, options: RunOptions): Promise<ResolvedStream> {
    const { track } = item
    const { ctx } = options
    const settings = this.#settings()
    const pin = await this.#stored({ trackId: track.id, mode: ctx.mode, target: 'song' })
    const steps = planPlayback({
      track,
      mode: ctx.mode,
      ...(item.candidate === undefined ? {} : { recorded: item.candidate }),
      ...(pin?.pinned === true ? { pinned: pin.candidate } : {}),
      settings: {
        ...settings,
        useInvidious: settings.useInvidious && this.#invidious !== undefined,
      },
      skipOffline: options.skipOffline,
    })
    const state: RunState = {
      tried: new Set(),
      problems: [],
      stops: [],
      alternatives: [],
      replaced: undefined,
      youtube: undefined,
    }
    for (const step of steps) {
      options.signal.throwIfAborted()
      const resolved = await this.#step(item, step, options, state)
      if (resolved !== undefined) return resolved
    }
    throw this.#giveUp(track, state)
  }

  async #step(
    item: QueueItem,
    step: PlaybackStep,
    options: RunOptions,
    state: RunState,
  ): Promise<ResolvedStream | undefined> {
    switch (step.type) {
      case 'offline':
        return this.#tryOffline(item.track, options)
      case 'candidate': {
        const role =
          step.origin === 'recorded' ? this.#roleOf(item.track, step.candidate) : step.origin
        return this.#tryCandidate(item.track, step.candidate, options, state, {
          role: role === 'pinned' ? 'match' : role,
          pinned: step.origin === 'pinned',
          record: true,
        })
      }
      case 'match':
        return this.#tryMatch(item.track, step.target, options, state)
      case 'invidious':
        return this.#tryInvidious(options, state)
    }
  }

  /** The role of the candidate recorded on a queue item. */
  #roleOf(track: Track, candidate: AudioCandidate): 'own' | 'linked-song' | 'match' {
    const own = ownCandidate(track)
    if (own !== undefined && sameCandidate(own, candidate)) return 'own'
    const linked = linkedSongCandidate(track)
    if (linked !== undefined && sameCandidate(linked, candidate)) return 'linked-song'
    return 'match'
  }

  async #tryOffline(track: Track, options: RunOptions): Promise<ResolvedStream | undefined> {
    if (this.#offline === undefined) return undefined
    try {
      const stream = await this.#offline.find(track, options.ctx)
      if (stream === undefined || this.#failedUrls.has(stream.url)) return undefined
      if (options.canPlay(stream) === 'no') return undefined
      return { stream: { ...stream } }
    } catch (error) {
      if (aborted(options.signal, error)) throw error
      return undefined
    }
  }

  /**
   * Resolves one candidate through its source and chooses the stream to play. Returns
   * `undefined` when this candidate cannot play, after recording why in `state`, and throws
   * failures that a retry may fix.
   */
  async #tryCandidate(
    track: Track,
    candidate: AudioCandidate,
    options: RunOptions,
    state: RunState,
    how: { role: 'own' | 'linked-song' | 'match'; pinned: boolean; record: boolean },
  ): Promise<ResolvedStream | undefined> {
    const key = candidateKey(candidate)
    if (state.tried.has(key) || this.#isDead(track, key)) return undefined
    state.tried.add(key)
    if (isYouTubeCandidate(candidate) && state.youtube === undefined) {
      state.youtube = { candidate, record: how.record }
    }
    const source = this.#sources.get(candidate.source)
    if (source === undefined) {
      state.problems.push(this.#unavailable(track, 'no-source'))
      return undefined
    }
    if (!canReachAudio(candidate.source, options.ctx.capabilities)) {
      state.stops.push(this.#unreachable(candidate.source))
      return undefined
    }
    try {
      const stream = await this.#streamFor(candidate, source, options)
      if (stream === undefined) {
        state.problems.push(this.#unavailable(track, 'no-stream'))
        return undefined
      }
      return how.record ? { stream, candidate } : { stream }
    } catch (error) {
      if (aborted(options.signal, error)) throw error
      return this.#candidateFailed(track, candidate, error, options, state, how)
    }
  }

  /** Handles a candidate whose source rejected: Smart Replace, fall through, or throw. */
  async #candidateFailed(
    track: Track,
    candidate: AudioCandidate,
    error: unknown,
    options: RunOptions,
    state: RunState,
    how: { role: 'own' | 'linked-song' | 'match'; pinned: boolean },
  ): Promise<undefined> {
    const verdict = playabilityVerdictOf(error)
    if (verdict !== undefined) {
      const othersResolve = await this.#othersResolve(candidate, options)
      const action: SmartReplaceAction = smartReplaceAction({
        candidate,
        role: how.role,
        pinned: how.pinned,
        verdict,
        othersResolve,
      })
      if (action === 'replace') {
        this.#markDead(track, candidate)
        state.replaced ??= candidate
      }
      const reason = action === 'keep-pin' ? 'pinned-unplayable' : 'unplayable'
      state.problems.push(this.#unavailable(track, reason))
      return undefined
    }
    if (isFxmError(error) && STOP_CODES.has(error.code)) {
      state.stops.push(error)
      return undefined
    }
    if (isFxmError(error) && UNPLAYABLE_CODES.has(error.code)) {
      state.problems.push(this.#unavailable(track, how.pinned ? 'pinned-unplayable' : 'unplayable'))
      return undefined
    }
    throw error
  }

  /**
   * Finds the track's match for `target`, from the match store or the matching engine, and
   * plays it if it may. When Smart Replace finds the match gone, it matches again without it.
   */
  async #tryMatch(
    track: Track,
    target: MatchTarget,
    options: RunOptions,
    state: RunState,
  ): Promise<ResolvedStream | undefined> {
    const optional = target === 'lossless'
    try {
      for (let round = 0; round <= this.#config.maxReplacements; round += 1) {
        const match = await this.#findMatch(track, target, options, state)
        if (match === undefined) return undefined
        const { candidate, band, pinned } = match
        state.alternatives.push(...match.alternatives)
        const allowed = mayPlayMatch({
          target,
          band,
          isrcVerified: candidate.signals?.isrcVerified === true,
          pinned,
          explicit: options.explicit,
          playBestGuesses: this.#settings().playBestGuesses,
        })
        const confirmed = pinned || band === 'auto'
        // A guess needs review until the user confirms it, even when a tap lets it play.
        if (target === 'song' && confirmed) this.#clearReview(track)
        else if (target === 'song') this.#markReview(track, candidate, match.alternatives)
        if (!allowed) {
          if (target === 'song') {
            state.problems.push({
              type: 'needs-review',
              trackId: track.id,
              guess: candidate,
              alternatives: match.alternatives,
            })
          }
          return undefined
        }
        const resolved = await this.#tryCandidate(track, candidate, options, state, {
          role: 'match',
          pinned,
          record: confirmed,
        })
        if (resolved !== undefined) {
          const from = state.replaced ?? match.replaces
          if (from !== undefined && !sameCandidate(from, candidate)) {
            this.#events.emit('smartreplace', { track, from, to: candidate })
          }
          return resolved
        }
        // Matched again only when Smart Replace found this match gone.
        if (!this.#isDead(track, candidateKey(candidate))) return undefined
      }
      return undefined
    } catch (error) {
      if (optional && !aborted(options.signal, error)) return undefined
      throw error
    }
  }

  /**
   * The track's match: the stored one, unless it is gone or stale, else a new one from the
   * matching engine, which is then stored. `undefined` when there is none, after recording why.
   */
  async #findMatch(
    track: Track,
    target: MatchTarget,
    options: RunOptions,
    state: RunState,
  ): Promise<(StoredMatch & { replaces: AudioCandidate | undefined }) | undefined> {
    const { ctx } = options
    const key: MatchKey = { trackId: track.id, mode: ctx.mode, target }
    const stored = await this.#stored(key)
    const storedDead = stored !== undefined && this.#isDead(track, candidateKey(stored.candidate))
    if (stored !== undefined && !storedDead) {
      if (stored.pinned || this.#now() - stored.matchedAt <= this.#config.maxMatchAgeMs) {
        return { ...stored, replaces: undefined }
      }
    }
    if (stored?.pinned === true) return undefined
    const matcher = this.#matcher
    if (matcher === undefined) {
      state.problems.push(this.#unavailable(track, storedDead ? 'unplayable' : 'no-match'))
      return undefined
    }
    // Songs are matched on YouTube Music, which this platform cannot reach.
    if (target === 'song' && ctx.capabilities.youtube === 'none') {
      state.stops.push(this.#unreachable('ytm'))
      return undefined
    }
    const exclude = [...(this.#dead.get(trackKey(track))?.values() ?? [])]
    const flightKey = [matchKeyString(key), ...exclude.map(candidateKey).sort()].join('\u0000')
    let outcome: MatchOutcome
    try {
      outcome = await this.#matching.run(flightKey, options.signal, (signal) =>
        matcher.match(track, {
          target,
          ctx: { ...ctx, signal },
          exclude,
          priority: options.priority,
          signal,
        }),
      )
    } catch (error) {
      if (aborted(options.signal, error)) throw error
      if (isFxmError(error) && STOP_CODES.has(error.code)) {
        state.stops.push(error)
        return undefined
      }
      throw error
    }
    const usable = (candidate: AudioCandidate) =>
      isPlayable(candidate, ctx.mode) && !this.#isDead(track, candidateKey(candidate))
    const alternatives = outcome.alternatives.filter(usable)
    const best = outcome.best !== undefined && usable(outcome.best) ? outcome.best : undefined
    if (outcome.band === 'none' || best === undefined) {
      if (storedDead) await this.#forget(key)
      state.alternatives.push(...alternatives)
      state.problems.push(this.#unavailable(track, storedDead ? 'unplayable' : 'no-match'))
      return undefined
    }
    const match: StoredMatch = {
      band: outcome.band,
      candidate: best,
      alternatives,
      pinned: false,
      matchedAt: this.#now(),
    }
    await this.#store(key, match)
    return { ...match, replaces: storedDead ? stored?.candidate : undefined }
  }

  /** Resolves the YouTube audio found so far through the user's Invidious instance. */
  async #tryInvidious(options: RunOptions, state: RunState): Promise<ResolvedStream | undefined> {
    const invidious = this.#invidious
    const found = state.youtube
    if (invidious === undefined || found === undefined) return undefined
    try {
      const resolution = await this.#options(
        found.candidate,
        invidious,
        INVIDIOUS,
        'top',
        options,
        false,
      )
      const stream = this.#choose(found.candidate, invidious, 'top', resolution, options)
      if (stream === undefined) return undefined
      return found.record ? { stream, candidate: found.candidate } : { stream }
    } catch (error) {
      if (aborted(options.signal, error)) throw error
      return undefined
    }
  }

  /** Why nothing played, as the error the player acts on. */
  #giveUp(track: Track, state: RunState): Error {
    const [stop] = state.stops
    if (stop !== undefined) return stop
    const review = state.problems.find((problem) => problem.type === 'needs-review')
    if (review !== undefined) return playbackProblemError(review)
    const reasons = new Set(
      state.problems.flatMap((problem) => (problem.type === 'unavailable' ? [problem.reason] : [])),
    )
    const reason = UNAVAILABLE_ORDER.find((candidate) => reasons.has(candidate)) ?? 'no-source'
    const seen = new Set<string>()
    const alternatives = state.alternatives.filter((candidate) => {
      const key = candidateKey(candidate)
      if (seen.has(key) || this.#isDead(track, key)) return false
      seen.add(key)
      return true
    })
    return playbackProblemError({ type: 'unavailable', trackId: track.id, reason, alternatives })
  }

  #unavailable(track: Track, reason: UnavailableReason): PlaybackProblem {
    return { type: 'unavailable', trackId: track.id, reason, alternatives: [] }
  }

  /** The error for audio the platform cannot reach, e.g. YouTube without Lite or FXM Connect. */
  #unreachable(source: SourceId): FxmError {
    return new FxmError('Unsupported', `${source} audio is not reachable on this platform`)
  }

  // --- Streams -------------------------------------------------------------------------------

  /**
   * The stream to play for `candidate`: from its remembered rung (the top of the ladder unless a
   * probe failed there), then the fallback rung when the top yields nothing playable ("fall back
   * to itag 18"), then once more from the top with fresh URLs ("then re-resolve") when what
   * failed came from the cache or from the remembered fallback rung.
   */
  async #streamFor(
    candidate: AudioCandidate,
    source: StreamSource,
    options: RunOptions,
  ): Promise<StreamOption | undefined> {
    const channel = source.id
    const memory = this.#memoryKey(this.#network.id, channel, candidate)
    const remembered = this.#rungs.get(memory) ?? 'top'
    let resolution = await this.#options(candidate, source, channel, remembered, options, false)
    let stream = this.#choose(candidate, source, remembered, resolution, options)
    let retryTop = resolution.cached || remembered === 'fallback'
    if (stream === undefined && remembered === 'top' && source.hasFallback === true) {
      this.#rungs.set(memory, 'fallback')
      resolution = await this.#options(candidate, source, channel, 'fallback', options, false)
      stream = this.#choose(candidate, source, 'fallback', resolution, options)
      retryTop ||= resolution.cached
    }
    if (stream === undefined && retryTop) {
      this.#rungs.delete(memory)
      resolution = await this.#options(candidate, source, channel, 'top', options, true)
      stream = this.#choose(candidate, source, 'top', resolution, options)
    }
    return stream
  }

  /** The key under which the rung to use for a candidate is remembered. */
  #memoryKey(network: string, channel: string, candidate: AudioCandidate): string {
    return `${network}\u0000${channel}\u0000${candidateKey(candidate)}`
  }

  /** The options of one resolution: from the cache unless `fresh`, else from the source. */
  async #options(
    candidate: AudioCandidate,
    source: StreamSource,
    channel: string,
    rung: LadderRung,
    options: RunOptions,
    fresh: boolean,
  ): Promise<Resolution> {
    const network = this.#network.id
    const key = resolutionKey(network, channel, candidate, rung)
    const hit = fresh ? undefined : this.#cache.get(key, this.#now())
    if (hit !== undefined) return { options: hit.options, cached: true, network, channel, key }
    if (fresh) this.#cache.delete(key)
    const resolved = await this.#resolving.run(key, options.signal, async (signal) => {
      const found = await source.resolve(candidate, {
        ctx: { ...options.ctx, signal },
        prefs: this.#prefs(),
        probe: this.#probePlan(candidate, options),
        rung,
        priority: options.priority,
        signal,
      })
      this.#remember(network, channel, key, candidate, found)
      return found
    })
    return { options: resolved, cached: false, network, channel, key }
  }

  /**
   * Caches a fresh resolution and, unless it went through Invidious, records it as proof that
   * its source resolves.
   */
  #remember(
    network: string,
    channel: string,
    key: string,
    candidate: AudioCandidate,
    found: readonly StreamOption[],
  ): void {
    if (this.#destroyed || network !== this.#network.id) return
    const now = this.#now()
    const usableUntil = streamsUsableUntil(found, now, {
      marginMs: this.#config.refreshBeforeExpiryMs,
      maxAgeMs: this.#config.maxUrlAgeMs,
    })
    this.#cache.set(key, { options: found, resolvedAt: now, usableUntil })
    if (channel === INVIDIOUS || found.length === 0) return
    const evidence: Evidence = {
      network,
      source: candidate.source,
      key: candidateKey(candidate),
      at: now,
    }
    this.#evidence = [...this.#evidence.slice(-(MAX_EVIDENCE - 1)), evidence]
  }

  /** Chooses the stream to play from a resolution, and remembers where it came from. */
  #choose(
    candidate: AudioCandidate,
    source: StreamSource,
    rung: LadderRung,
    resolution: Resolution,
    options: RunOptions,
  ): StreamOption | undefined {
    const { choice } = this.#streamChoice(candidate, options)
    const picked = choosePlaybackStream(resolution.options, choice)
    if (picked === undefined) return undefined
    const stream: StreamOption = { ...picked }
    this.#issued.set(stream, {
      candidate,
      source,
      rung,
      cached: resolution.cached,
      network: resolution.network,
      channel: resolution.channel,
      key: resolution.key,
    })
    return stream
  }

  /**
   * How to choose among `candidate`'s streams now: the player's formats, the ceiling and the
   * audio-only preference of the connection and the data saver (`streamingProfile`), and no URL
   * or format that already failed. `probe` says how much the source should probe meanwhile.
   */
  #streamChoice(
    candidate: AudioCandidate,
    options: RunOptions,
  ): { choice: StreamChoice; probe: ProbeScope } {
    const detected = this.#network.cellular ? 'cellular' : 'unknown'
    const profile = streamingProfile(this.#prefs(), this.#streaming(), detected)
    const key = candidateKey(candidate)
    const choice: StreamChoice = {
      support: options.canPlay,
      ceiling: profile.ceiling,
      preferAudioOnly: profile.preferAudioOnly,
      exclude: (option) =>
        this.#failedUrls.has(option.url) ||
        this.#badFormats.get(key)?.has(formatOf(option)) === true,
    }
    return { choice, probe: profile.probe }
  }

  /**
   * How the source probes the streams it finds for `candidate`: every URL, or with the data saver
   * only the one {@link #choose} would pick.
   */
  #probePlan(candidate: AudioCandidate, options: RunOptions): ProbePlan {
    const { choice, probe } = this.#streamChoice(candidate, options)
    return { scope: probe, choose: (found) => choosePlaybackStream(found, choice) }
  }

  // --- Failures ------------------------------------------------------------------------------

  /**
   * Learns from a failed stream before the item is resolved again: a signed, IP-bound URL is
   * never handed out again on this network, and `planStreamRecovery` decides about the cache
   * and the rung.
   */
  async #recover(failure: StreamFailure, ctx: ProviderContext, signal: AbortSignal): Promise<void> {
    const { stream } = failure
    if (stream === undefined) return
    const issued = this.#issued.get(stream)
    if (issued === undefined || issued.network !== this.#network.id) {
      this.#failedUrls.add(stream.url)
      return
    }
    const kind = failureKind(failure.error)
    let status = httpStatusOf(failure.error)
    if (status === undefined && kind !== 'expired' && ctx.capabilities.mediaBytes) {
      status = await this.#checkStatus(issued.source, stream, ctx, signal)
    }
    const memory = this.#memoryKey(issued.network, issued.channel, issued.candidate)
    const forbiddenKey = `${memory}\u0000${issued.rung}`
    const forbiddenCount = this.#forbidden.get(forbiddenKey) ?? 0
    const recovery = planStreamRecovery({
      kind,
      ...(status === undefined ? {} : { status }),
      started: failure.started ?? false,
      fullLength: stream.fullLength,
      rung: issued.rung,
      cached: issued.cached,
      hasFallback: issued.source.hasFallback === true,
      forbiddenCount,
    })
    if (recovery.flushAll) this.#flush('ip-changed')
    // A signed, IP-bound URL is replaced by a fresh resolution; a stable one (Internet Archive,
    // Jamendo) is all there is, so it may be tried again after a passing failure.
    if (stream.ipBound) this.#failedUrls.add(stream.url)
    if (status === 403 && !issued.cached) this.#forbidden.set(forbiddenKey, forbiddenCount + 1)
    if (recovery.avoidFormat) {
      const key = candidateKey(issued.candidate)
      const formats = this.#badFormats.get(key) ?? new Set<string>()
      formats.add(formatOf(stream))
      this.#badFormats.set(key, formats)
      return
    }
    this.#cache.delete(issued.key)
    if (recovery.target === 'same') {
      this.#rungs.set(memory, issued.rung)
    } else if (recovery.target === 'fallback') {
      this.#rungs.set(memory, 'fallback')
    } else {
      this.#rungs.delete(memory)
      this.#cache.delete(resolutionKey(issued.network, issued.channel, issued.candidate, 'top'))
    }
  }

  async #checkStatus(
    source: StreamSource,
    stream: StreamOption,
    ctx: ProviderContext,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (source.checkStatus === undefined) return undefined
    try {
      return await source.checkStatus(stream, { ctx, signal })
    } catch {
      return undefined
    }
  }

  /** Drops every cached URL and what the lifecycle learned on the old network. */
  #flush(reason: FlushReason): void {
    const dropped = this.#cache.clear()
    this.#resolving.clear()
    this.#failedUrls.clear()
    this.#rungs.clear()
    this.#forbidden.clear()
    this.#evidence = []
    this.#dead.clear()
    this.#events.emit('flush', { reason, dropped })
  }

  // --- Smart Replace -------------------------------------------------------------------------

  #isDead(track: Track, key: string): boolean {
    return this.#dead.get(trackKey(track))?.has(key) === true
  }

  #markDead(track: Track, candidate: AudioCandidate): void {
    const key = trackKey(track)
    const dead = this.#dead.get(key) ?? new Map<string, AudioCandidate>()
    dead.set(candidateKey(candidate), candidate)
    this.#dead.set(key, dead)
  }

  /**
   * Whether other items of the candidate's source resolve on this network: one resolved
   * recently, or, failing that, one of the next items in the queue resolves now.
   */
  async #othersResolve(candidate: AudioCandidate, options: RunOptions): Promise<boolean> {
    if (this.#hasEvidence(candidate)) return true
    const source = this.#sources.get(candidate.source)
    const player = this.#player
    if (source === undefined || player === undefined) return false
    const { mode } = options.ctx
    for (const item of upcomingQueueItems(player.getState().queue).slice(0, 3)) {
      const other = [item.candidate, ownCandidate(item.track)].find(
        (found): found is AudioCandidate =>
          found !== undefined &&
          found.source === candidate.source &&
          !sameCandidate(found, candidate) &&
          isPlayable(found, mode),
      )
      if (other === undefined) continue
      try {
        const prefetch: RunOptions = { ...options, priority: 'prefetch' }
        await this.#options(other, source, source.id, 'top', prefetch, false)
      } catch (error) {
        if (aborted(options.signal, error)) throw error
      }
      break
    }
    return this.#hasEvidence(candidate)
  }

  #hasEvidence(candidate: AudioCandidate): boolean {
    const network = this.#network.id
    const key = candidateKey(candidate)
    const since = this.#now() - this.#config.evidenceWindowMs
    return this.#evidence.some(
      (entry) =>
        entry.network === network &&
        entry.source === candidate.source &&
        entry.key !== key &&
        entry.at >= since,
    )
  }

  // --- The match store -----------------------------------------------------------------------

  async #stored(key: MatchKey): Promise<StoredMatch | undefined> {
    try {
      const match = await this.#matches.get(key)
      return isStoredMatch(match) ? match : undefined
    } catch (error) {
      console.error(error)
      return undefined
    }
  }

  async #store(key: MatchKey, match: StoredMatch): Promise<void> {
    try {
      await this.#matches.put(key, match)
    } catch (error) {
      console.error(error)
    }
  }

  async #forget(key: MatchKey): Promise<void> {
    try {
      await this.#matches.delete(key)
    } catch (error) {
      console.error(error)
    }
  }

  /**
   * Pins `candidate` for `track`, unless it is the track's own audio, which needs no pin. The
   * user chose it, so it plays even if Smart Replace gave up on it earlier.
   */
  async #pin(track: Track, candidate: AudioCandidate, mode: CatalogMode): Promise<void> {
    const own = ownCandidate(track)
    if (own !== undefined && sameCandidate(own, candidate)) return
    if (!isPlayable(candidate, mode)) return
    this.#dead.get(trackKey(track))?.delete(candidateKey(candidate))
    const key: MatchKey = { trackId: track.id, mode, target: 'song' }
    const stored = await this.#stored(key)
    await this.#store(key, {
      band:
        stored !== undefined && sameCandidate(stored.candidate, candidate) ? stored.band : 'auto',
      candidate,
      alternatives: stored?.alternatives ?? [],
      pinned: true,
      matchedAt: this.#now(),
    })
    this.#clearReview(track)
  }

  #markReview(track: Track, guess: AudioCandidate, alternatives: readonly AudioCandidate[]): void {
    const key = trackKey(track)
    const known = this.#reviews.get(key)
    if (known !== undefined && sameCandidate(known.guess, guess)) return
    this.#reviews.set(key, { track, guess, alternatives })
    this.#events.emit('reviewchange', this.reviews())
  }

  #clearReview(track: Track): void {
    if (this.#reviews.delete(trackKey(track))) this.#events.emit('reviewchange', this.reviews())
  }

  // --- Prefetching ---------------------------------------------------------------------------

  async #prefetchChain(items: readonly QueueItem[], generation: number): Promise<void> {
    const signal = this.#prefetchAbort.signal
    for (const item of items) {
      if (generation !== this.#prefetchGeneration || signal.aborted) return
      try {
        await this.#run(item, {
          ctx: this.#ctx(signal),
          explicit: false,
          priority: 'prefetch',
          canPlay: this.#canPlay,
          signal,
          skipOffline: false,
        })
      } catch {
        // Nothing prepared: the item resolves again when it plays.
      }
    }
  }
}
