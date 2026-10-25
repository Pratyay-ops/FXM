/**
 * The stream lifecycle (stage 2.3): the `StreamResolver` the player asks for every stream. It
 * applies the playback policy from `@fxm/core` and keeps the state around it:
 *
 * - the order of preference: an offline copy, the user's choice (the version picked for the
 *   item, else the track's pin) or the recorded candidate, a lossless match with "prefer
 *   lossless", the track's own audio or its matched song, Invidious, and "Unavailable"
 *   (`planPlayback`)
 * - Suggest-band guesses play only after an explicit user action or with "Play best guesses";
 *   otherwise the queue skips them, marked "needs review". A guess the app recorded on a queue
 *   item counts as one, too
 * - the matching engine's decisions, "nothing came close" included, in the match store. Pins
 *   change only when the user asks (`pinMatch`, `unpinMatch`)
 * - the URL cache, per audio candidate and per network, flushed on network changes and on a 403
 *   for a cached URL
 * - probing: a failed probe (an end-of-file probe that found the URL capped, or in the Lite
 *   tier a failure of the media element's first request) falls back to the source's last-resort
 *   rung, then resolves again (`planStreamRecovery`), and the source hears of it
 * - re-resolution on expiry, 401, 403, 410, stalls and media errors; the player resumes at the
 *   same position
 * - prefetching the next tracks, and sharing resolutions that are in flight
 * - Smart Replace, only on a playability verdict while other videos resolve, never for the
 *   user's choice
 * - the format choice per `canPlayType`
 *
 * The player itself does the retries with backoff and the circuit breaker after 4 failed
 * tracks; the lifecycle makes sure each retry gets fresh audio.
 *
 * @module
 */

import {
  type AudioCandidate,
  audioSourceOf,
  type CatalogMode,
  candidateKey,
  canReachAudio,
  choosePlaybackStream,
  currentQueueItem,
  DEFAULT_PLAYBACK_SETTINGS,
  DEFAULT_QUALITY_PREFS,
  entityKey,
  type Fetch,
  FxmError,
  type FxmErrorCode,
  httpStatusOf,
  isAudioCandidate,
  isFxmError,
  isPlayable,
  isYouTubeCandidate,
  type LadderRung,
  linkedSongCandidate,
  type MatchBand,
  type MatchTarget,
  mayPlayMatch,
  ownCandidate,
  type PlayabilityVerdict,
  type PlaybackProblem,
  type PlaybackSettings,
  type PlaybackStep,
  type ProviderContext,
  planPlayback,
  planStreamRecovery,
  playabilityVerdictOf,
  playbackProblemError,
  playbackProblemOf,
  type QualityPrefs,
  type QueueItem,
  type SourceId,
  type StreamFailureFacts,
  type StreamFailureKind,
  type StreamOption,
  sameCandidate,
  smartReplaceAction,
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
  type MatchKey,
  type MatchOutcome,
  type MatchStore,
  matchKeyString,
  type OfflineStore,
  type ResolvePriority,
  type StoredMatch,
  type StreamFailureReport,
  type StreamSource,
  sanitizeStoredMatch,
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
  /** Where the matching decisions are kept (2.6). Default: in memory. */
  matches?: MatchStore
  /** Offline copies (4.1). */
  offline?: OfflineStore
  /**
   * Resolves YouTube candidates through the Invidious instance the user entered. Used only
   * while the `useInvidious` setting is on.
   */
  invidious?: StreamSource
  /**
   * The provider context for calls at a request-budget priority, read afresh each time: the
   * tier can change. Its `fetch` must draw on the budget at `priority`, e.g. with 1.2's
   * transport: `(priority) => ({ ...ctx, fetch: transport.withPriority(priority) })`.
   */
  context: (priority: ResolvePriority) => ProviderContext
  /** The user's quality settings. Default: `DEFAULT_QUALITY_PREFS`. */
  qualityPrefs?: () => QualityPrefs
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
  /** How long an engine's `auto` or `suggest` decision counts before it is matched again. Default: 30 days. */
  maxMatchAgeMs?: number
  /** How long an engine's decision that nothing came close counts. Default: 1 day. */
  maxMissAgeMs?: number
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
  maxMissAgeMs: 24 * 60 * 60_000,
  maxReplacements: 2,
})

/**
 * A track whose match needs the user's review: its best match is a Suggest-band guess they have
 * not confirmed, whether a queue skipped it or a tap let it play. It stays listed until the user
 * pins a version ({@link StreamLifecycle.pinMatch}) or a later match lands in the Auto band; the
 * queue panel shows the ones in the queue.
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

/** Track changes after which the new item counts as asked for, when a request does not say. */
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

/** The most version picks remembered, one per queue item. */
const MAX_PICKS = 64

/**
 * How long a 403 counts toward changing rung: about one failure episode, the player's retries
 * of one item. A 403 hours later starts over on the same rung.
 */
const FORBIDDEN_EPISODE_MS = 10 * 60_000

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
  /** The flush generation it was resolved in: a flush since makes it a stream of the past. */
  readonly generation: number
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
  readonly generation: number
  readonly channel: string
  readonly key: string
}

/** How one run of the policy goes. */
interface RunOptions {
  /** The context at the run's priority, with its mode and signal. */
  readonly ctx: ProviderContext
  /** The queue's catalog mode. */
  readonly mode: CatalogMode
  /** Whether the user asked for this item just now. */
  readonly explicit: boolean
  /** Whether the recorded candidate is the version the user picked for this item. */
  readonly picked: boolean
  readonly priority: ResolvePriority
  readonly canPlay: (stream: StreamOption) => PlaySupport
  readonly signal: AbortSignal
  readonly skipOffline: boolean
}

/** Why a source refused an item, for "Unavailable". */
interface Refusal {
  readonly code: FxmErrorCode
  readonly state?: string
  readonly detail?: string
}

/** What one run of the policy collected while it went through the steps. */
interface RunState {
  /** The stored song decision, as the run found it. */
  readonly song: StoredMatch | undefined
  /** Whether the run ends with the user's Invidious instance. */
  readonly invidious: boolean
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
  /** A failure a retry may fix, kept while Invidious may still play the YouTube audio. */
  deferred: { error: unknown } | undefined
  /** The first refusal of the item by a source. */
  refusal: Refusal | undefined
}

/** A match the run found, stored or new. */
interface Found {
  readonly band: MatchBand
  readonly candidate: AudioCandidate
  readonly alternatives: readonly AudioCandidate[]
  readonly pinned: boolean
  /** The stored match that Smart Replace found gone, which this one replaces. */
  readonly replaces: AudioCandidate | undefined
}

/** A recent successful resolution, proof that a source still resolves on a network. */
interface Evidence {
  readonly network: string
  /** The audio source (`ytm` for every YouTube video). */
  readonly source: SourceId
  readonly key: string
  readonly at: number
}

/** The request-budget priority of work in flight, which a more urgent caller raises. */
interface SharedPriority {
  value: ResolvePriority
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
  if (isEngineError(error, 'unsupported')) return 'unsupported'
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

/** The candidate as its audio source names it: `ytm` for a video named with either prefix. */
function asAudio(candidate: AudioCandidate): AudioCandidate {
  const source = audioSourceOf(candidate.source)
  return source === candidate.source ? candidate : { ...candidate, source }
}

/**
 * Resolves queue items into streams for the player, following the playback policy. Pass it to
 * the player as its resolver, then {@link attach} the player:
 *
 * ```ts
 * const lifecycle = new StreamLifecycle({ sources, matcher, context, network })
 * const player = new Player({ engine, resolver: lifecycle })
 * lifecycle.attach(player)
 * ```
 *
 * Attaching lets the lifecycle prefetch the next tracks when the player announces `preload`,
 * and lets Smart Replace check the next tracks. The player says on every request whether the
 * user asked for the item (`ResolveRequest.explicit`); for a player that does not, attaching
 * also lets the lifecycle work that out.
 */
export class StreamLifecycle implements StreamResolver {
  readonly #sources: ReadonlyMap<SourceId, StreamSource>
  readonly #matcher: TrackMatcher | undefined
  readonly #matches: MatchStore
  readonly #offline: OfflineStore | undefined
  readonly #invidious: StreamSource | undefined
  readonly #context: (priority: ResolvePriority) => ProviderContext
  readonly #prefs: () => QualityPrefs
  readonly #settings: () => PlaybackSettings
  readonly #network: NetworkMonitor
  readonly #now: () => number
  readonly #config: {
    prefetchCount: number
    refreshBeforeExpiryMs: number
    maxUrlAgeMs: number
    evidenceWindowMs: number
    maxMatchAgeMs: number
    maxMissAgeMs: number
    maxReplacements: number
  }
  readonly #events = new Emitter<LifecycleEventMap>()
  readonly #cache = new UrlCache()
  readonly #resolving = new InFlight<readonly StreamOption[]>()
  readonly #matching = new InFlight<MatchOutcome>()
  /** The priority of each piece of work in flight, by its key. */
  readonly #priorities = new Map<string, SharedPriority>()
  /** The streams handed to the player, each a copy of its option. */
  readonly #issued = new WeakMap<StreamOption, Issued>()
  /** Signed URLs that failed on the current network, and offline copies that failed. */
  readonly #failedUrls = new Set<string>()
  /** Formats (`codec/container`) that failed to decode, per candidate key. */
  readonly #badFormats = new Map<string, Set<string>>()
  /** The rung to resolve each candidate on, per network and candidate key; `top` when absent. */
  readonly #rungs = new Map<string, LadderRung>()
  /** 403s per network, candidate key and rung, and when the last one came. */
  readonly #forbidden = new Map<string, { count: number; at: number }>()
  /** Candidates Smart Replace found gone, per track key. */
  readonly #dead = new Map<string, Map<string, AudioCandidate>>()
  /** Items that need review, per track key. */
  readonly #reviews = new Map<string, ReviewItem>()
  /** The version the user picked for a queue item, as its candidate key, by the item's uid. */
  readonly #picks = new Map<number, string>()
  #evidence: Evidence[] = []
  /** Increments on every flush, so work from before it is never cached or trusted. */
  #generation = 0
  /** The uid of the item the user asked for, while it is current, for requests that do not say. */
  #explicitUid: number | undefined
  #canPlay: (stream: StreamOption) => PlaySupport = guessSupport
  #player: LifecyclePlayer | undefined
  #detachPlayer: (() => void) | undefined
  #warnedUnattached = false
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
      maxMissAgeMs: nonNegative(options.maxMissAgeMs, d.maxMissAgeMs),
      maxReplacements: Math.floor(nonNegative(options.maxReplacements, d.maxReplacements)),
    }
    this.#stopNetwork = this.#network.subscribe(() => this.#flush('network'))
  }

  // --- The resolver --------------------------------------------------------------------------

  /** Resolves the stream to play `item` (see `StreamResolver`). */
  async resolve(item: QueueItem, request: ResolveRequest): Promise<ResolvedStream> {
    if (this.#destroyed) throw new Error('The stream lifecycle was destroyed')
    this.#warnUnattached()
    this.#canPlay = request.canPlay
    const priority: ResolvePriority = request.reason === 'preload' ? 'prefetch' : 'current-track'
    const base = this.#context(priority)
    const mode = request.mode ?? base.mode
    const ctx: ProviderContext = { ...base, mode, signal: request.signal }
    if (request.failure !== undefined) await this.#recover(request.failure, ctx, request.signal)
    const picked = this.#isPick(item, request)
    return this.#run(item, {
      ctx,
      mode,
      explicit: this.#isExplicit(item, request),
      picked,
      priority,
      canPlay: request.canPlay,
      signal: request.signal,
      skipOffline: picked,
    })
  }

  // --- The player ----------------------------------------------------------------------------

  /**
   * Follows `player`: its `preload` events, to prefetch the next tracks, and its queue, so that
   * Smart Replace can check that the next videos resolve. For requests that do not say whether
   * the user asked for the item, it also follows which item that is (a tap, a jump, "previous",
   * a restored queue, or play on a paused or stopped item). Returns a function that stops
   * following.
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
   * Pins `candidate` as the audio for `track` in the current catalog mode: the user's pick in
   * "Not the right version?", or a guess they confirmed in the review. A pin plays first from
   * now on, and the lifecycle never swaps or deletes it by itself. Choosing the track's own
   * audio needs no pin: it removes the pin of another version instead. Queue items keep the
   * candidate recorded on them; `Player.setCandidate` changes those.
   */
  async pinMatch(track: Track, candidate: AudioCandidate): Promise<void> {
    if (this.#destroyed) return
    const mode = this.#mode()
    const key: MatchKey = { sourceTrackId: track.id, mode, target: 'song' }
    const own = ownCandidate(track)
    if (own !== undefined && sameCandidate(own, candidate)) {
      await this.#unpin(key)
      this.#clearReview(track)
      return
    }
    if (!isAudioCandidate(candidate) || !isPlayable(candidate, mode)) return
    this.#dead.get(trackKey(track))?.delete(candidateKey(candidate))
    const stored = await this.#stored(key)
    const previous = stored?.candidate === undefined ? [] : [stored.candidate]
    await this.#store(key, {
      // The band the engine gave this very candidate, when it was the engine's pick.
      band:
        stored?.candidate !== undefined && sameCandidate(stored.candidate, candidate)
          ? stored.band
          : 'none',
      candidate,
      alternatives: [...previous, ...(stored?.alternatives ?? [])].filter(
        (other) => !sameCandidate(other, candidate),
      ),
      ...(candidate.signals === undefined ? {} : { signals: candidate.signals }),
      evidence: ['pinned by the user'],
      userPinned: true,
      decidedAt: this.#now(),
    })
    this.#clearReview(track)
  }

  /**
   * Removes the user's pin for `track` in the current catalog mode ("reset to automatic"), so
   * the policy decides again. Queue items keep the candidate recorded on them.
   */
  async unpinMatch(track: Track): Promise<void> {
    if (this.#destroyed) return
    await this.#unpin({ sourceTrackId: track.id, mode: this.#mode(), target: 'song' })
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
    this.#priorities.clear()
    this.#events.clear()
  }

  // --- Running the policy --------------------------------------------------------------------

  /** The catalog mode: the attached player's queue's, else the provider context's. */
  #mode(): CatalogMode {
    return this.#player?.getState().queue.mode ?? this.#context('current-track').mode
  }

  #warnUnattached(): void {
    if (this.#player !== undefined || this.#warnedUnattached) return
    this.#warnedUnattached = true
    console.warn(
      'StreamLifecycle: no player is attached, so it prefetches nothing and Smart Replace ' +
        'cannot check the next tracks. Call lifecycle.attach(player).',
    )
  }

  #isExplicit(item: QueueItem, request: ResolveRequest): boolean {
    if (request.reason === 'replace') return true
    if (request.reason === 'preload') return false
    if (request.explicit !== undefined) return request.explicit
    // A player that does not say: work it out from the player attached.
    // The player never retries an item it skipped as unavailable or needing review by itself:
    // only when the user plays it again.
    const failure = request.failure
    if (failure?.stream === undefined && playbackProblemOf(failure?.error) !== undefined) {
      return true
    }
    return this.#explicitUid === item.uid
  }

  /**
   * Whether the candidate recorded on `item` is the version the user picked for it: picked
   * just now (`replace`), or earlier while it is still the one recorded, e.g. on a retry.
   */
  #isPick(item: QueueItem, request: ResolveRequest): boolean {
    if (request.reason !== 'replace') return this.#pickOf(item)
    this.#picks.delete(item.uid)
    if (item.candidate === undefined) return false
    this.#picks.set(item.uid, candidateKey(item.candidate))
    for (const uid of this.#picks.keys()) {
      if (this.#picks.size <= MAX_PICKS) break
      this.#picks.delete(uid)
    }
    return true
  }

  #pickOf(item: QueueItem): boolean {
    const { candidate } = item
    return candidate !== undefined && this.#picks.get(item.uid) === candidateKey(candidate)
  }

  /** Goes through the policy's steps for `item` until one gives a stream. */
  async #run(item: QueueItem, options: RunOptions): Promise<ResolvedStream> {
    const { track } = item
    const { mode } = options
    const settings = this.#settings()
    const song = await this.#stored({ sourceTrackId: track.id, mode, target: 'song' })
    const pinned = song?.userPinned === true ? song.candidate : undefined
    const steps = planPlayback({
      track,
      mode,
      ...(item.candidate === undefined ? {} : { recorded: item.candidate }),
      ...(pinned === undefined ? {} : { pinned }),
      picked: options.picked,
      settings: {
        ...settings,
        useInvidious: settings.useInvidious && this.#invidious !== undefined,
      },
      skipOffline: options.skipOffline,
    })
    const state: RunState = {
      song,
      invidious: steps.some((step) => step.type === 'invidious'),
      tried: new Set(),
      problems: [],
      stops: [],
      alternatives: [],
      replaced: undefined,
      youtube: undefined,
      deferred: undefined,
      refusal: undefined,
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
    const { track } = item
    switch (step.type) {
      case 'offline':
        return this.#tryOffline(track, options)
      case 'candidate': {
        const { candidate, origin } = step
        const role = this.#roleOf(track, candidate)
        if (origin === 'recorded' && role === 'match') {
          if (!(await this.#mayPlayRecorded(track, candidate, options, state))) {
            state.problems.push({
              type: 'needs-review',
              trackId: track.id,
              guess: candidate,
              alternatives: [],
            })
            return undefined
          }
        }
        return this.#tryCandidate(track, candidate, options, state, {
          role,
          pinned: origin === 'pinned' || origin === 'picked',
          record: true,
        })
      }
      case 'match':
        return step.target === 'song'
          ? this.#tryMatch(track, 'song', options, state)
          : this.#tryLossless(track, options, state)
      case 'invidious':
        return this.#tryInvidious(options, state)
    }
  }

  /** The role of a candidate for its track. */
  #roleOf(track: Track, candidate: AudioCandidate): 'own' | 'linked-song' | 'match' {
    const own = ownCandidate(track)
    if (own !== undefined && sameCandidate(own, candidate)) return 'own'
    const linked = linkedSongCandidate(track)
    if (linked !== undefined && sameCandidate(linked, candidate)) return 'linked-song'
    return 'match'
  }

  /**
   * Whether a match recorded on the queue item may play now. Like any match, a guess plays only
   * after an explicit user action or with "Play best guesses"; the recorded match counts as
   * confirmed only while a fresh stored decision names it and lets it play (an `auto` song, an
   * `auto` or ISRC-verified lossless copy, a pin).
   */
  async #mayPlayRecorded(
    track: Track,
    candidate: AudioCandidate,
    options: RunOptions,
    state: RunState,
  ): Promise<boolean> {
    if (options.explicit || this.#settings().playBestGuesses) return true
    const targets: MatchTarget[] = isYouTubeCandidate(candidate) ? ['song'] : ['song', 'lossless']
    for (const target of targets) {
      const decision =
        target === 'song'
          ? state.song
          : await this.#stored({ sourceTrackId: track.id, mode: options.mode, target })
      if (decision?.candidate === undefined || !sameCandidate(decision.candidate, candidate)) {
        continue
      }
      const age = this.#now() - decision.decidedAt
      if (!decision.userPinned && age > this.#config.maxMatchAgeMs) continue
      const allowed = mayPlayMatch({
        target,
        band: decision.band,
        isrcVerified: candidate.signals?.isrcVerified === true,
        pinned: decision.userPinned,
        explicit: false,
        playBestGuesses: false,
      })
      if (allowed) return true
    }
    return false
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
    // A last guard: what the mode does not let play never plays, whoever named it.
    if (!isPlayable(candidate, options.mode)) return undefined
    if (isYouTubeCandidate(candidate) && state.youtube === undefined) {
      state.youtube = { candidate, record: how.record }
    }
    const audio = audioSourceOf(candidate.source)
    const source = this.#sources.get(audio)
    if (source === undefined) {
      state.problems.push(this.#unavailable(track, 'no-source'))
      return undefined
    }
    if (!canReachAudio(audio, options.ctx.capabilities)) {
      state.stops.push(this.#unreachable(audio))
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
      return this.#candidateFailed(track, candidate, source, error, options, state, how)
    }
  }

  /** Handles a candidate whose source rejected: Smart Replace, fall through, or throw. */
  async #candidateFailed(
    track: Track,
    candidate: AudioCandidate,
    source: StreamSource,
    error: unknown,
    options: RunOptions,
    state: RunState,
    how: { role: 'own' | 'linked-song' | 'match'; pinned: boolean },
  ): Promise<undefined> {
    const verdict = playabilityVerdictOf(error)
    if (verdict !== undefined && isFxmError(error)) {
      const othersResolve = await this.#othersResolve(candidate, options)
      const action = smartReplaceAction({
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
      this.#refused(state, source, error, verdict)
      const reason = action === 'keep-pin' ? 'pinned-unplayable' : 'unplayable'
      state.problems.push(this.#unavailable(track, reason))
      return undefined
    }
    if (isFxmError(error) && STOP_CODES.has(error.code)) {
      state.stops.push(error)
      return undefined
    }
    if (isFxmError(error) && UNPLAYABLE_CODES.has(error.code)) {
      this.#refused(state, source, error, undefined)
      state.problems.push(this.#unavailable(track, how.pinned ? 'pinned-unplayable' : 'unplayable'))
      return undefined
    }
    if (this.#defer(error, state, isYouTubeCandidate(candidate))) return undefined
    throw error
  }

  /** Remembers the first refusal of the item by a source, with its code, state and words. */
  #refused(
    state: RunState,
    source: StreamSource,
    error: FxmError,
    verdict: PlayabilityVerdict | undefined,
  ): void {
    if (state.refusal !== undefined) return
    let label = verdict?.state
    if (label === undefined) {
      try {
        label = source.stateOf?.(error)
      } catch (stateError) {
        console.error(stateError)
      }
    }
    const detail = verdict?.reason ?? error.message
    state.refusal = {
      code: error.code,
      ...(typeof label === 'string' && label !== '' ? { state: label } : {}),
      ...(detail === '' ? {} : { detail }),
    }
  }

  /**
   * Keeps a failure that a retry may fix, instead of throwing it, while the user's Invidious
   * instance may still play the YouTube audio found: the run goes on, and the error is thrown
   * at the end if nothing plays, so the player's retries stay as they are.
   */
  #defer(error: unknown, state: RunState, youtube: boolean): boolean {
    if (!state.invidious || !youtube) return false
    state.deferred ??= { error }
    return true
  }

  /**
   * "Prefer lossless": the lossless match, if it may play. The step is optional: what goes
   * wrong in it says nothing about the item, so it leaves no stop, problem, refusal, deferred
   * failure or Smart Replace mark behind.
   */
  async #tryLossless(
    track: Track,
    options: RunOptions,
    state: RunState,
  ): Promise<ResolvedStream | undefined> {
    const stops = state.stops.length
    const problems = state.problems.length
    const { replaced, deferred, refusal } = state
    try {
      const resolved = await this.#tryMatch(track, 'lossless', options, state)
      if (resolved !== undefined) return resolved
    } catch (error) {
      if (aborted(options.signal, error)) throw error
    }
    state.stops.length = stops
    state.problems.length = problems
    state.replaced = replaced
    state.deferred = deferred
    state.refusal = refusal
    return undefined
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
    for (let round = 0; round <= this.#config.maxReplacements; round += 1) {
      const match = await this.#findMatch(track, target, options, state)
      if (match === undefined) return undefined
      const { candidate, band, pinned, alternatives } = match
      state.alternatives.push(...alternatives)
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
      else if (target === 'song') this.#markReview(track, candidate, alternatives)
      if (!allowed) {
        if (target === 'song') {
          state.problems.push({
            type: 'needs-review',
            trackId: track.id,
            guess: candidate,
            alternatives,
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
  }

  /**
   * The track's match: the stored decision while it is fresh and its audio may play here, else
   * a new one from the matching engine, which is then stored, also when nothing came close.
   * `undefined` when there is none, after recording why.
   */
  async #findMatch(
    track: Track,
    target: MatchTarget,
    options: RunOptions,
    state: RunState,
  ): Promise<Found | undefined> {
    const { mode } = options
    const key: MatchKey = { sourceTrackId: track.id, mode, target }
    const stored = await this.#stored(key)
    const usable = (candidate: AudioCandidate) =>
      isPlayable(candidate, mode) && !this.#isDead(track, candidateKey(candidate))
    const decided = stored?.candidate
    if (stored !== undefined) {
      const alternatives = stored.alternatives.filter(usable)
      const alive = decided !== undefined && usable(decided)
      // A pin is never matched over, also when its audio cannot play here.
      if (stored.userPinned) {
        if (!alive) return undefined
        return {
          band: stored.band,
          candidate: decided,
          alternatives,
          pinned: true,
          replaces: undefined,
        }
      }
      const age = this.#now() - stored.decidedAt
      if (stored.band === 'none') {
        if (age <= this.#config.maxMissAgeMs) {
          const near = decided === undefined ? [] : [decided]
          state.alternatives.push(...[...near, ...stored.alternatives].filter(usable))
          state.problems.push(this.#unavailable(track, 'no-match'))
          return undefined
        }
      } else if (alive && age <= this.#config.maxMatchAgeMs) {
        return {
          band: stored.band,
          candidate: decided,
          alternatives,
          pinned: false,
          replaces: undefined,
        }
      }
    }
    const storedDead = decided !== undefined && this.#isDead(track, candidateKey(decided))
    const matcher = this.#matcher
    if (matcher === undefined) {
      state.problems.push(this.#unavailable(track, storedDead ? 'unplayable' : 'no-match'))
      return undefined
    }
    // Songs are matched on YouTube Music, which this platform cannot reach.
    if (target === 'song' && options.ctx.capabilities.youtube === 'none') {
      state.stops.push(this.#unreachable('ytm'))
      return undefined
    }
    const exclude = [...(this.#dead.get(trackKey(track))?.values() ?? [])]
    const flightKey = ['match', matchKeyString(key), ...exclude.map(candidateKey).sort()].join(
      '\u0000',
    )
    let outcome: MatchOutcome
    try {
      outcome = await this.#shared(this.#matching, flightKey, options, (ctx, priority, signal) =>
        matcher.match(track, { target, ctx, exclude, priority, signal }),
      )
    } catch (error) {
      if (aborted(options.signal, error)) throw error
      if (isFxmError(error) && STOP_CODES.has(error.code)) {
        state.stops.push(error)
        return undefined
      }
      if (this.#defer(error, state, target === 'song' && state.youtube !== undefined)) {
        return undefined
      }
      throw error
    }
    const alternatives = outcome.alternatives.filter(usable)
    const best = outcome.best !== undefined && usable(outcome.best) ? outcome.best : undefined
    const band: MatchBand = best === undefined ? 'none' : outcome.band
    const decision: StoredMatch = {
      band,
      ...(best === undefined ? {} : { candidate: best }),
      alternatives,
      ...(best?.signals === undefined ? {} : { signals: best.signals }),
      evidence: [...(outcome.evidence ?? best?.evidence ?? [])],
      userPinned: false,
      decidedAt: this.#now(),
    }
    // An outcome some pages were missing from plays as decided, but is not kept.
    if (outcome.incomplete !== true) await this.#store(key, decision)
    else if (storedDead) await this.#forget(key)
    if (band === 'none' || best === undefined) {
      state.alternatives.push(...(best === undefined ? [] : [best]), ...alternatives)
      state.problems.push(this.#unavailable(track, storedDead ? 'unplayable' : 'no-match'))
      return undefined
    }
    return {
      band,
      candidate: best,
      alternatives,
      pinned: false,
      replaces: storedDead ? decided : undefined,
    }
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
  #giveUp(track: Track, state: RunState): unknown {
    // A failure a retry may fix, kept for Invidious: the player retries as it would have.
    if (state.deferred !== undefined) return state.deferred.error
    const [stop] = state.stops
    if (stop !== undefined) return stop
    const review = state.problems.findLast((problem) => problem.type === 'needs-review')
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
    return playbackProblemError({
      type: 'unavailable',
      trackId: track.id,
      reason,
      alternatives,
      ...state.refusal,
    })
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
    const generation = this.#generation
    const key = resolutionKey(network, channel, candidate, rung)
    const hit = fresh ? undefined : this.#cache.get(key, this.#now())
    if (hit !== undefined) {
      return { options: hit.options, cached: true, network, generation, channel, key }
    }
    if (fresh) this.#cache.delete(key)
    const resolved = await this.#shared(
      this.#resolving,
      `resolve\u0000${key}`,
      options,
      async (ctx, priority, signal) => {
        const found = await source.resolve(asAudio(candidate), {
          ctx,
          prefs: this.#prefs(),
          rung,
          priority,
          signal,
        })
        this.#remember(network, generation, channel, key, candidate, found)
        return found
      },
    )
    return { options: resolved, cached: false, network, generation, channel, key }
  }

  /**
   * Runs `start` once for every caller that asks for `key` meanwhile (see `InFlight`). Its
   * context's `fetch` draws on the request budget at the priority of the most urgent caller
   * waiting, so a play request that joins a prefetch raises it to `current-track`.
   */
  #shared<V>(
    flight: InFlight<V>,
    key: string,
    options: RunOptions,
    start: (ctx: ProviderContext, priority: ResolvePriority, signal: AbortSignal) => Promise<V>,
  ): Promise<V> {
    const waiting = this.#priorities.get(key)
    if (waiting !== undefined && options.priority === 'current-track') {
      waiting.value = 'current-track'
    }
    return flight.run(key, options.signal, async (signal) => {
      const shared: SharedPriority = { value: options.priority }
      this.#priorities.set(key, shared)
      try {
        const fetch: Fetch = (input, init) => this.#context(shared.value).fetch(input, init)
        return await start({ ...options.ctx, fetch, signal }, shared.value, signal)
      } finally {
        if (this.#priorities.get(key) === shared) this.#priorities.delete(key)
      }
    })
  }

  /**
   * Caches a fresh resolution and, unless it went through Invidious, records it as proof that
   * its source resolves. Neither happens for a resolution that a flush overtook: its URLs
   * belong to the network, or the IP address, before it.
   */
  #remember(
    network: string,
    generation: number,
    channel: string,
    key: string,
    candidate: AudioCandidate,
    found: readonly StreamOption[],
  ): void {
    if (this.#destroyed || network !== this.#network.id || generation !== this.#generation) return
    const now = this.#now()
    const usableUntil = streamsUsableUntil(found, now, {
      marginMs: this.#config.refreshBeforeExpiryMs,
      maxAgeMs: this.#config.maxUrlAgeMs,
    })
    this.#cache.set(key, { options: found, resolvedAt: now, usableUntil })
    if (channel === INVIDIOUS || found.length === 0) return
    const evidence: Evidence = {
      network,
      source: audioSourceOf(candidate.source),
      key: candidateKey(candidate),
      at: now,
    }
    this.#evidence = [...this.#evidence.slice(-(MAX_EVIDENCE - 1)), evidence]
  }

  /**
   * Chooses the stream to play from a resolution, and remembers where it came from: the rung
   * the source says, else the one asked for.
   */
  #choose(
    candidate: AudioCandidate,
    source: StreamSource,
    rung: LadderRung,
    resolution: Resolution,
    options: RunOptions,
  ): StreamOption | undefined {
    const cellular = this.#network.cellular
    const prefs = this.#prefs()
    const badFormats = this.#badFormats.get(candidateKey(candidate))
    const picked = choosePlaybackStream(resolution.options, {
      support: options.canPlay,
      ceiling: cellular ? prefs.streaming.cellular : prefs.streaming.wifi,
      preferAudioOnly: cellular,
      exclude: (option) =>
        this.#failedUrls.has(option.url) || badFormats?.has(formatOf(option)) === true,
    })
    if (picked === undefined) return undefined
    const stream: StreamOption = { ...picked }
    this.#issued.set(stream, {
      candidate,
      source,
      rung: this.#rungOf(source, picked) ?? rung,
      cached: resolution.cached,
      network: resolution.network,
      generation: resolution.generation,
      channel: resolution.channel,
      key: resolution.key,
    })
    return stream
  }

  #rungOf(source: StreamSource, option: StreamOption): LadderRung | undefined {
    try {
      const rung = source.rungOf?.(option)
      return rung === 'top' || rung === 'fallback' ? rung : undefined
    } catch (error) {
      console.error(error)
      return undefined
    }
  }

  // --- Failures ------------------------------------------------------------------------------

  /**
   * Learns from a failed stream before the item is resolved again: a signed, IP-bound URL is
   * never handed out again on this network, `planStreamRecovery` decides about the cache and
   * the rung, and the source hears when a rung failed.
   */
  async #recover(failure: StreamFailure, ctx: ProviderContext, signal: AbortSignal): Promise<void> {
    const { stream } = failure
    if (stream === undefined) return
    const issued = this.#issued.get(stream)
    if (
      issued === undefined ||
      issued.network !== this.#network.id ||
      issued.generation !== this.#generation
    ) {
      // A stream from before a flush: its URL is dead now, and says nothing about this network.
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
    const now = this.#now()
    const forbidden = this.#forbidden.get(forbiddenKey)
    const forbiddenCount =
      forbidden !== undefined && now - forbidden.at <= FORBIDDEN_EPISODE_MS ? forbidden.count : 0
    const facts: StreamFailureFacts = {
      kind,
      ...(status === undefined ? {} : { status }),
      started: failure.started === true,
      fullLength: stream.fullLength,
      rung: issued.rung,
      cached: issued.cached,
      hasFallback: issued.source.hasFallback === true,
      forbiddenCount,
    }
    const recovery = planStreamRecovery(facts)
    if (recovery.target !== 'same') {
      this.#report(issued.source, stream, { facts, recovery }, ctx, signal)
    }
    if (recovery.flushAll) this.#flush('ip-changed')
    // A signed, IP-bound URL is replaced by a fresh resolution; a stable one (Internet Archive,
    // Jamendo) is all there is, so it may be tried again after a passing failure.
    if (stream.ipBound) this.#failedUrls.add(stream.url)
    if (status === 403 && !issued.cached) {
      this.#forbidden.set(forbiddenKey, { count: forbiddenCount + 1, at: now })
    }
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

  /** Tells a source that a stream's rung failed (see `StreamSource.reportFailure`). */
  #report(
    source: StreamSource,
    stream: StreamOption,
    report: StreamFailureReport,
    ctx: ProviderContext,
    signal: AbortSignal,
  ): void {
    try {
      source.reportFailure?.(stream, report, { ctx, signal })
    } catch (error) {
      console.error(error)
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
    this.#generation += 1
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
   * recently, or, failing that, one of the next items in the queue resolves now. A URL cached
   * long ago proves nothing, so that item is resolved afresh; the result is cached for when it
   * plays.
   */
  async #othersResolve(candidate: AudioCandidate, options: RunOptions): Promise<boolean> {
    if (this.#hasEvidence(candidate)) return true
    const audio = audioSourceOf(candidate.source)
    const source = this.#sources.get(audio)
    const player = this.#player
    if (source === undefined || player === undefined) return false
    for (const item of upcomingQueueItems(player.getState().queue).slice(0, 3)) {
      const other = [item.candidate, ownCandidate(item.track)].find(
        (found): found is AudioCandidate =>
          found !== undefined &&
          audioSourceOf(found.source) === audio &&
          !sameCandidate(found, candidate) &&
          isPlayable(found, options.mode),
      )
      if (other === undefined) continue
      try {
        const prefetch: RunOptions = { ...options, priority: 'prefetch' }
        await this.#options(other, source, source.id, 'top', prefetch, true)
      } catch (error) {
        if (aborted(options.signal, error)) throw error
      }
      break
    }
    return this.#hasEvidence(candidate)
  }

  #hasEvidence(candidate: AudioCandidate): boolean {
    const network = this.#network.id
    const audio = audioSourceOf(candidate.source)
    const key = candidateKey(candidate)
    const since = this.#now() - this.#config.evidenceWindowMs
    return this.#evidence.some(
      (entry) =>
        entry.network === network &&
        entry.source === audio &&
        entry.key !== key &&
        entry.at >= since,
    )
  }

  // --- The match store -----------------------------------------------------------------------

  async #stored(key: MatchKey): Promise<StoredMatch | undefined> {
    try {
      return sanitizeStoredMatch(await this.#matches.get(key))
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

  /** Removes the pin filed under `key`, if there is one: only ever when the user asks. */
  async #unpin(key: MatchKey): Promise<void> {
    const stored = await this.#stored(key)
    if (stored?.userPinned === true) await this.#forget(key)
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
        const base = this.#context('prefetch')
        const mode = this.#player?.getState().queue.mode ?? base.mode
        const picked = this.#pickOf(item)
        await this.#run(item, {
          ctx: { ...base, mode, signal },
          mode,
          explicit: false,
          picked,
          priority: 'prefetch',
          canPlay: this.#canPlay,
          signal,
          skipOffline: picked,
        })
      } catch {
        // Nothing prepared: the item resolves again when it plays.
      }
    }
  }
}
