/**
 * The player facade: one object the app talks to. It drives a queue (from `@fxm/core`) and an
 * {@link Engine}, asks a {@link StreamResolver} for streams, retries failures, skips tracks that
 * keep failing, stops when too many fail in a row, and prepares the next track early.
 *
 * The facade has no DOM dependency of its own, so the same code drives the direct audio engine
 * on web and desktop and a native engine on Android.
 *
 * @module
 */

import {
  type AudioCandidate,
  type AudioEffectsSettings,
  addToQueue,
  type CatalogMode,
  clearUpcoming,
  createQueue,
  currentQueueItem,
  DEFAULT_AUDIO_EFFECTS,
  type FxmErrorCode,
  hasNextQueueItem,
  isFxmError,
  jumpInQueue,
  moveInQueue,
  nextQueueItem,
  playNext,
  type QueueItem,
  type QueueOptions,
  type QueueState,
  type RandomSource,
  type RepeatMode,
  removeFromQueue,
  restoreQueue,
  type SetQueueOptions,
  type StreamOption,
  sanitizeAudioEffects,
  setQueue,
  setQueueCandidate,
  setQueueMode,
  setQueueRepeat,
  setQueueShuffle,
  skipToNext,
  skipToPrevious,
  type Track,
  upcomingQueueItems,
} from '@fxm/core'
import { callSafely, Emitter, type Listener } from './emitter'
import { type AudioEffectsStatus, type Engine, EngineError, type PlaySupport } from './engine'
import type { ResolvedStream, ResolveReason, StreamFailure, StreamResolver } from './resolver'

/**
 * What the player is doing:
 *
 * - `idle`: the queue is empty
 * - `loading`: getting the current track ready to play (resolving, loading or retrying)
 * - `playing`: playing; see {@link PlayerState.buffering} for waiting on data
 * - `paused`: paused, or a track is selected but not started
 * - `ended`: the last track finished and nothing follows
 * - `error`: playback stopped because tracks failed; see {@link PlayerState.error}
 */
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

/**
 * Why playback stopped with status `error`:
 *
 * - `track-failed`: the player gave up on a track and had nowhere to go: it was the last one
 *   (repeat off), or the next one had already failed in this run of failures
 * - `circuit-open`: too many tracks failed in a row, so the player stopped skipping: a dead
 *   connection most likely, or a queue in which nothing plays
 * - `action-required`: a failure that neither retrying nor skipping fixes, so the user must
 *   act: the platform lacks a capability such as FXM Connect (`Unsupported`), a login is needed
 *   (`AuthRequired`), or the source wants proof of a real user (`BotCheck`). `error` says which
 */
export type PlayerErrorReason = 'track-failed' | 'circuit-open' | 'action-required'

/** Why playback stopped with status `error`. */
export interface PlayerError {
  /** What stopped it. */
  reason: PlayerErrorReason
  /** The last failure. */
  error: Error
  /** The item that failed last. */
  item: QueueItem
}

/** A snapshot of the player, replaced (never changed) on every update. */
export interface PlayerState {
  /** The queue. `currentQueueItem(state.queue)` is the track playing or selected. */
  readonly queue: QueueState
  /** What the player is doing. */
  readonly status: PlayerStatus
  /** Whether playback is waiting for data, e.g. to show a spinner. */
  readonly buffering: boolean
  /** How far into the current track playback is, in milliseconds. */
  readonly positionMs: number
  /** The current track's duration in milliseconds: the engine's value, else the metadata's. */
  readonly durationMs: number | undefined
  /** Volume, from 0 to 1. */
  readonly volume: number
  /** Whether the output is muted. */
  readonly muted: boolean
  /** The stream playing, e.g. for a quality badge. */
  readonly stream: StreamOption | undefined
  /** Why playback stopped, while the status is `error`. */
  readonly error: PlayerError | undefined
  /**
   * The playback speed, 1 being normal (see {@link Player.setAudioEffects}). Always 1 with an
   * engine that can't change it.
   */
  readonly playbackRate: number
  /** What the equalizer and loudness normalization do to the current track. */
  readonly effects: AudioEffectsStatus
  /** The sleep timer, while one runs (see {@link Player.setSleepTimer}). */
  readonly sleepTimer: SleepTimerState | undefined
}

/**
 * A sleep timer to start ({@link Player.setSleepTimer}): pause `afterMs` from now, fading out
 * over the last seconds, or when the current track ends.
 */
export type SleepTimerRequest = { readonly afterMs: number } | { readonly endOfTrack: true }

/**
 * The sleep timer that runs: pausing at `endsAt` (epoch milliseconds, the player's clock) after a
 * fade of `fadeMs`, or at the end of the current track.
 */
export type SleepTimerState =
  | { readonly endsAt: number; readonly fadeMs: number }
  | { readonly endOfTrack: true }

/** Why the sleep timer paused playback: its time came, or the track it waited for ended. */
export type SleepReason = 'timer' | 'end-of-track'

/** What a player's engine supports of the audio effects, for the settings to offer. */
export interface EffectsSupport {
  /** The equalizer and loudness normalization: the engine applies them. */
  readonly effects: boolean
  /** Playback speed. */
  readonly playbackRate: boolean
  /** Crossfade: the engine has it, and it can fade on this device (`volume`). */
  readonly crossfade: boolean
  /**
   * Whether the engine can change the level of what plays: not where pages can't set a media
   * element's volume (iOS), which crossfades need (see `Engine.canSetVolume`).
   */
  readonly volume: boolean
}

/**
 * Why the current item changed:
 *
 * - `queue`: a new queue, or tracks added to an empty one
 * - `restore`: a saved queue was put back
 * - `next`, `previous`, `jump`: the user skipped, went back or picked an item
 * - `ended`: the previous track played to its end
 * - `failed`: the previous track failed and was skipped
 * - `removed`: the previous item was removed from the queue
 */
export type TrackChangeCause =
  | 'queue'
  | 'restore'
  | 'next'
  | 'previous'
  | 'jump'
  | 'ended'
  | 'failed'
  | 'removed'

/**
 * Why the position jumped:
 *
 * - `user`: a seek (from the seek bar, a lyric line or the system controls), or stop
 * - `restart`: "previous" restarted the track, or play after the end of the queue started it
 *   over
 * - `repeat`: the track ended and plays again: repeat one, or a one-track queue repeating
 */
export type SeekCause = 'user' | 'restart' | 'repeat'

/** The events a {@link Player} announces, with their payloads. */
export interface PlayerEventMap {
  /** The current item changed. `item` is `undefined` when the queue became empty. */
  trackchange: {
    item: QueueItem | undefined
    previous: QueueItem | undefined
    cause: TrackChangeCause
  }
  /** The position jumped: a seek, a restart, or a repeat of the track. */
  seek: { positionMs: number; cause: SeekCause }
  /**
   * The player gave up on a track: it failed every retry, cannot play anywhere (skipped at
   * once), or cannot play until the user acts (then playback stops with `action-required`).
   * The player moves on unless it has to stop.
   */
  trackfailed: { item: QueueItem; error: Error }
  /** Too many tracks failed in a row, so playback stopped. */
  circuitopen: { failures: number }
  /** The last track ended and nothing follows. */
  queueend: undefined
  /** The browser wants a user gesture before playback can start: show a play button. */
  autoplayblocked: undefined
  /**
   * The current track is close to its end (`preloadLeadMs`), so `next` can be prepared. The
   * player resolves it itself when the `preload` option is on; listen to prefetch more of
   * `upcoming` or to top up a radio. Announced once per pair of current and next item, also
   * with `preload: false`. `upcoming` is the items after the current one in play order and does
   * not wrap around for repeat `all`, so it can be empty while `next` is the first item again.
   */
  preload: { next: QueueItem; upcoming: readonly QueueItem[] }
  /** The sleep timer paused playback (see {@link Player.setSleepTimer}). */
  sleep: { reason: SleepReason }
}

/** Receives every new {@link PlayerState}, with the one it replaces. */
export type PlayerStateListener = (state: PlayerState, previous: PlayerState) => void

/**
 * What the player does after a failed attempt to play an item:
 *
 * - `retry`: try the item again after a wait, up to `maxRetries` times, then skip it
 * - `skip`: give up on the item at once and move on: it cannot play anywhere. Counts toward
 *   `maxConsecutiveSkips`, not toward `maxConsecutiveFailures`
 * - `stop`: stop with `action-required`: nothing will play until the user acts
 */
export type FailureClass = 'retry' | 'skip' | 'stop'

/** Every {@link FailureClass}. */
const FAILURE_CLASSES: readonly FailureClass[] = ['retry', 'skip', 'stop']

/** `FxmError` codes for an item that cannot play anywhere. */
const SKIP_CODES: ReadonlySet<FxmErrorCode> = new Set(['NotFound', 'Unavailable', 'GeoBlocked'])

/** `FxmError` codes that no item gets past until the user acts. */
const STOP_CODES: ReadonlySet<FxmErrorCode> = new Set(['Unsupported', 'AuthRequired', 'BotCheck'])

/**
 * The default {@link FailureClass} of a failure, by its `FxmError` code:
 *
 * - `NotFound`, `Unavailable`, `GeoBlocked`: `skip`, the item cannot play anywhere
 * - `Unsupported`, `AuthRequired`, `BotCheck`: `stop`, the user must act (install FXM Connect,
 *   log in, prove they are human) before anything plays
 * - anything else: `retry`. That includes `RateLimited` (the player then waits at least
 *   `retryAfterMs`), `Network`, `Expired`, `Parse`, every `EngineError` and errors that are not
 *   `FxmError`s
 */
export function classifyFailure(error: Error): FailureClass {
  if (!isFxmError(error)) return 'retry'
  if (SKIP_CODES.has(error.code)) return 'skip'
  if (STOP_CODES.has(error.code)) return 'stop'
  return 'retry'
}

/** How the player is put together and tuned. */
export interface PlayerOptions {
  /** Plays the streams. The player owns it from now on and destroys it with itself. */
  engine: Engine
  /** Finds the stream for each queue item. */
  resolver: StreamResolver
  /** The queue's initial mode, repeat and shuffle settings. */
  queue?: QueueOptions
  /** Initial volume, from 0 to 1. Default: 1. */
  volume?: number
  /** Whether the output starts muted. Default: false. */
  muted?: boolean
  /** Randomness for shuffling. Default: `Math.random`. */
  random?: RandomSource
  /** The clock, in epoch milliseconds, for stream expiry. Default: `Date.now`. */
  now?: () => number
  /** Retries per track after its first attempt fails. Default: 3. */
  maxRetries?: number
  /** Wait before each retry, by retry number; the last value repeats. Default: 0, 1 s, 3 s. */
  retryDelaysMs?: readonly number[]
  /** Tracks in a row that failed every retry and stop playback (circuit breaker). Default: 4. */
  maxConsecutiveFailures?: number
  /**
   * Tracks in a row the player gave up on, skipped ones included, that stop playback, so a
   * queue in which nothing plays is not resolved to its end. Default: 10.
   */
  maxConsecutiveSkips?: number
  /** How long playback may wait for data before that counts as a network failure; 0 never. */
  stallTimeoutMs?: number
  /**
   * Whether to resolve the next track before the current one ends and hand it to
   * `engine.preload`. The `preload` event is announced either way. Default: true.
   */
  preload?: boolean
  /** How long before the end of the current track to prepare the next one. Default: 30 s. */
  preloadLeadMs?: number
  /** Resolve again a loaded stream this close to its `expiresAt`. Default: 10 minutes. */
  refreshBeforeExpiryMs?: number
  /**
   * Decides what a failed attempt leads to (see {@link FailureClass}). Default:
   * {@link classifyFailure}; wrap it to change single cases.
   */
  classifyFailure?: (error: Error, item: QueueItem) => FailureClass
  /**
   * The audio effects to start with: the equalizer, loudness normalization, crossfade and speed.
   * Default: `DEFAULT_AUDIO_EFFECTS` from `@fxm/core`. Change them with
   * {@link Player.setAudioEffects}.
   */
  effects?: AudioEffectsSettings
  /** How long the sleep timer fades out before it pauses, at most. Default: 12 s. */
  sleepFadeMs?: number
}

/** Options for {@link Player.setQueue}. */
export interface PlayerSetQueueOptions extends Omit<SetQueueOptions, 'random'> {
  /** Whether to start playing at once. Default: true. */
  autoplay?: boolean
  /** Where to start the first track, in milliseconds, e.g. to resume it. Default: 0. */
  startAtMs?: number
}

/** The defaults behind {@link PlayerOptions}. */
export const PLAYER_DEFAULTS = Object.freeze({
  maxRetries: 3,
  retryDelaysMs: Object.freeze([0, 1000, 3000]),
  maxConsecutiveFailures: 4,
  maxConsecutiveSkips: 10,
  stallTimeoutMs: 15_000,
  preloadLeadMs: 30_000,
  refreshBeforeExpiryMs: 10 * 60_000,
  sleepFadeMs: 12_000,
})

/**
 * The shortest crossfade worth starting, in milliseconds: closer to the end than this, the track
 * just ends and the next one follows as usual.
 */
const MIN_CROSSFADE_MS = 1000

/**
 * How long after its time the player pauses for an engine whose own sleep timer should have
 * done it already (Android's native player), in milliseconds.
 */
const SLEEP_GRACE_MS = 2000

/** How fast the output comes back when a sleep timer is cancelled during its fade. */
const SLEEP_RESTORE_MS = 400

/**
 * How much of a track must play after a (re)load before it counts as healthy, which resets its
 * retry count and the circuit breaker. Reaching the end counts too.
 */
const HEALTHY_AFTER_MS = 5000

/**
 * How far the position must move past where playback started waiting for data before that
 * proves audio plays again, whatever the engine said. A stray late update moves it a few
 * milliseconds at most.
 */
const PROGRESS_PROOF_MS = 1000

interface LoadRequest {
  /** Whether to play once loaded; otherwise the track is loaded paused. */
  autoplay: boolean
  /** Where to start, in milliseconds. */
  startAtMs?: number
  /** Why the stream is needed. Default: `retry` after a failure of the item, else `play`. */
  reason?: ResolveReason
  /** What went wrong before. Default: the item's last failure, for a `retry`. */
  failure?: StreamFailure
}

interface Preload {
  /** The item being prepared. */
  uid: number
  /** Cancels its resolution. */
  abort: AbortController
  /** Its resolution, shared with the load when the item comes up. */
  promise: Promise<ResolvedStream>
  /** The resolution, once it was handed to the engine to prepare: what a crossfade starts. */
  resolved?: ResolvedStream
}

/** The stream the engine holds for the current item. */
interface Loaded {
  uid: number
  stream: StreamOption
  /** Whether the engine reported `play` for this load yet. */
  played: boolean
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume))
}

/** What the effects do where the engine applies none: whatever is on is unavailable. */
function effectsWithoutEngine(settings: AudioEffectsSettings): AudioEffectsStatus {
  return {
    equalizer: settings.equalizer.enabled ? 'unavailable' : 'off',
    loudness: settings.loudness.enabled ? 'unavailable' : 'off',
    loudnessGainDb: 0,
  }
}

/** Whether `a` and `b` are on the same album, by the album's ID. */
function sameAlbum(a: Track, b: Track): boolean {
  return a.album?.id !== undefined && a.album.id === b.album?.id
}

/**
 * Plays a queue of tracks through an engine. Every method is safe to call at any time and never
 * throws; the async ones resolve when the action has been carried out, and never reject. Read
 * the state with {@link getState} and {@link subscribe}, and discrete happenings with {@link on}.
 *
 * The transport methods (`setQueue`, `play`, `next`, `previous`, `toggle`) call
 * `engine.unlock()` before they await anything, so call them straight from a user gesture.
 */
export class Player {
  #state: PlayerState
  readonly #engine: Engine
  readonly #resolver: StreamResolver
  readonly #random: RandomSource
  readonly #now: () => number
  readonly #classify: (error: Error, item: QueueItem) => FailureClass
  readonly #config: {
    maxRetries: number
    retryDelaysMs: readonly number[]
    maxConsecutiveFailures: number
    maxConsecutiveSkips: number
    stallTimeoutMs: number
    preload: boolean
    preloadLeadMs: number
    refreshBeforeExpiryMs: number
    sleepFadeMs: number
  }
  readonly #events = new Emitter<PlayerEventMap>()
  readonly #subscribers = new Set<PlayerStateListener>()
  readonly #detach: (() => void)[]
  /** What the engine can play, for the resolver. */
  readonly #canPlay = (stream: StreamOption): PlaySupport => this.#support(stream)
  /** Increments whenever pending work for the current item must be dropped. */
  #token = 0
  #abort: AbortController | undefined
  /** The stream the engine holds for the current item, while its events count. */
  #loaded: Loaded | undefined
  #preload: Preload | undefined
  /** The current and next item of the last `preload` event. */
  #announced: { current: number; next: number } | undefined
  /** Failed attempts for the current item. */
  #attempts = 0
  /** The current item's last failure, until it plays for a while; the next load retries it. */
  #lastFailure: { uid: number; failure: StreamFailure } | undefined
  /** The current item's uid while it counts as asked for (see `ResolveRequest.explicit`). */
  #explicitUid: number | undefined
  /** Tracks in the current run of failures that failed every retry. */
  #failedTracks = 0
  /** Tracks in the current run of failures, skipped ones included. */
  #failedRun = 0
  /** The items given up on in the current run, so a repeating queue does not go round again. */
  readonly #failedUids = new Set<number>()
  /** The position from which the current load counts as healthy. */
  #healthyAtMs: number | undefined
  /** Where playback was when the stall watch started, while it runs. */
  #stallFromMs: number | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #stallTimer: ReturnType<typeof setTimeout> | undefined
  /** The audio effects in use. */
  #effects: AudioEffectsSettings = DEFAULT_AUDIO_EFFECTS
  /** Set while a crossfade hands playback to the next item: the engine must not pause then. */
  #handover = false
  /** Set during `engine.crossfade()`: a duration reported then is the incoming track's. */
  #crossfading = false
  /** The incoming track's duration, as the engine reported it during `engine.crossfade()`. */
  #incomingDurationMs: number | undefined
  /** The sleep timer's deadline. */
  #sleepTimer: ReturnType<typeof setTimeout> | undefined
  /** When the sleep timer's fade starts. */
  #sleepFadeTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether the sleep timer has started fading the output. */
  #sleepFading = false
  #destroyed = false

  constructor(options: PlayerOptions) {
    this.#engine = options.engine
    this.#resolver = options.resolver
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? Date.now
    this.#classify = options.classifyFailure ?? classifyFailure
    this.#config = {
      maxRetries: Math.floor(nonNegative(options.maxRetries, PLAYER_DEFAULTS.maxRetries)),
      retryDelaysMs: options.retryDelaysMs ?? PLAYER_DEFAULTS.retryDelaysMs,
      maxConsecutiveFailures: Math.max(
        1,
        nonNegative(options.maxConsecutiveFailures, PLAYER_DEFAULTS.maxConsecutiveFailures),
      ),
      maxConsecutiveSkips: Math.max(
        1,
        nonNegative(options.maxConsecutiveSkips, PLAYER_DEFAULTS.maxConsecutiveSkips),
      ),
      stallTimeoutMs: nonNegative(options.stallTimeoutMs, PLAYER_DEFAULTS.stallTimeoutMs),
      preload: options.preload ?? true,
      preloadLeadMs: nonNegative(options.preloadLeadMs, PLAYER_DEFAULTS.preloadLeadMs),
      refreshBeforeExpiryMs: nonNegative(
        options.refreshBeforeExpiryMs,
        PLAYER_DEFAULTS.refreshBeforeExpiryMs,
      ),
      sleepFadeMs: nonNegative(options.sleepFadeMs, PLAYER_DEFAULTS.sleepFadeMs),
    }
    const volume = clampVolume(nonNegative(options.volume, 1))
    const muted = options.muted ?? false
    this.#state = {
      queue: createQueue(options.queue),
      status: 'idle',
      buffering: false,
      positionMs: 0,
      durationMs: undefined,
      volume,
      muted,
      stream: undefined,
      error: undefined,
      playbackRate: 1,
      effects: effectsWithoutEngine(DEFAULT_AUDIO_EFFECTS),
      sleepTimer: undefined,
    }
    const engine = this.#engine
    engine.setVolume(volume)
    engine.setMuted(muted)
    this.#detach = [
      engine.on('timeupdate', (positionMs) => this.#onTimeUpdate(positionMs)),
      engine.on('durationchange', (durationMs) => this.#onDurationChange(durationMs)),
      engine.on('play', () => this.#onPlay()),
      engine.on('pause', () => this.#onPause()),
      engine.on('ended', () => this.#onEnded()),
      engine.on('error', (error) => this.#onError(error)),
      engine.on('waiting', () => this.#onWaiting()),
      engine.on('stalled', () => this.#onWaiting()),
      engine.on('effects', (status) => this.#onEffects(status)),
      engine.on('sleep', ({ reason }) => this.#onEngineSleep(reason)),
    ]
    this.#applyEffects(sanitizeAudioEffects(options.effects ?? DEFAULT_AUDIO_EFFECTS))
  }

  // --- Reading -------------------------------------------------------------------------------

  /** The current state. */
  getState(): PlayerState {
    return this.#state
  }

  /** Calls `listener` with every new state. Returns a function that stops it. */
  subscribe(listener: PlayerStateListener): () => void {
    this.#subscribers.add(listener)
    return () => {
      this.#subscribers.delete(listener)
    }
  }

  /** Adds a listener for one {@link PlayerEventMap} event. Returns a function that removes it. */
  on<K extends keyof PlayerEventMap>(type: K, listener: Listener<PlayerEventMap[K]>): () => void {
    return this.#events.on(type, listener)
  }

  // --- Queue ---------------------------------------------------------------------------------

  /**
   * Replaces the queue with `tracks` and plays its start track (see `setQueue` in `@fxm/core`
   * for how the mode, the start index and shuffle apply): `{ shuffle: true }` without a
   * `startIndex` is a shuffle button, starting at a random track.
   */
  async setQueue(tracks: readonly Track[], options: PlayerSetQueueOptions = {}): Promise<void> {
    if (this.#destroyed) return
    const { autoplay = true, startAtMs, ...start } = options
    const queue = setQueue(this.#state.queue, tracks, { ...start, random: this.#random })
    const item = currentQueueItem(queue)
    if (autoplay && item !== undefined) this.#engine.unlock?.()
    this.#userAction()
    this.#changeQueue(queue, 'queue')
    this.#ask()
    if (item === undefined) {
      this.#commit({ status: 'idle', buffering: false })
      return
    }
    const positionMs = nonNegative(startAtMs, 0)
    if (!autoplay) {
      this.#commit({ status: 'paused', buffering: false, positionMs })
      return
    }
    await this.#load({ autoplay: true, startAtMs: positionMs })
  }

  /**
   * Puts back a saved queue, paused at `positionMs` of its current item. `saved` is untrusted
   * data, such as a `QueueState` read back from storage: it goes through `restoreQueue` from
   * `@fxm/core` in the player's mode, so a malformed item or one the mode hides is dropped.
   * Playing resumes there. Returns whether `saved` was a queue.
   */
  restore(saved: unknown, positionMs = 0): boolean {
    if (this.#destroyed) return false
    const queue = restoreQueue(saved, this.#state.queue.mode)
    if (queue === null) return false
    this.#cancel()
    this.#cancelPreload()
    this.#resetRun()
    this.#changeQueue(queue, 'restore')
    const item = currentQueueItem(queue)
    this.#commit({
      status: item === undefined ? 'idle' : 'paused',
      buffering: false,
      positionMs: item === undefined ? 0 : nonNegative(positionMs, 0),
      durationMs: item?.track.durationMs,
      stream: undefined,
      error: undefined,
    })
    return true
  }

  /** Inserts `tracks` right after the current item. */
  playNext(tracks: readonly Track[]): void {
    this.#edit(playNext(this.#state.queue, tracks), 'queue')
  }

  /** Appends `tracks` to the end of the queue. */
  addToQueue(tracks: readonly Track[]): void {
    this.#edit(addToQueue(this.#state.queue, tracks), 'queue')
  }

  /** Removes the item at `index`. Removing the current item moves on to the following one. */
  remove(index: number): void {
    this.#edit(removeFromQueue(this.#state.queue, index), 'removed')
  }

  /** Moves the item at `from` to `to`. */
  move(from: number, to: number): void {
    this.#edit(moveInQueue(this.#state.queue, from, to), 'queue')
  }

  /** Removes every item after the current one. */
  clearUpcoming(): void {
    this.#edit(clearUpcoming(this.#state.queue), 'queue')
  }

  /** Turns shuffle on or off. The current track keeps playing. */
  setShuffle(shuffle: boolean): void {
    this.#edit(setQueueShuffle(this.#state.queue, shuffle, this.#random), 'queue')
  }

  /** Sets how the queue repeats. */
  setRepeat(repeat: RepeatMode): void {
    this.#edit(setQueueRepeat(this.#state.queue, repeat), 'queue')
  }

  /** Switches the catalog mode. The current track keeps playing. */
  setCatalogMode(mode: CatalogMode): void {
    this.#edit(setQueueMode(this.#state.queue, mode), 'queue')
  }

  /**
   * Records `candidate` as the audio for the item with `uid`, e.g. the version the user picked
   * in "Not the right version?", or clears it. When that item is the current one and has a
   * stream, the player resolves the new candidate (reason `replace`) and carries on at the same
   * position (from the start after the end of the queue), playing or paused as before. Ignored
   * for an unknown uid, and for a candidate the queue's mode does not let play.
   *
   * It records the version on this one item and remembers nothing else: to keep the choice for
   * the track (a pin in the match cache), tell the resolver, e.g. `StreamLifecycle.pinMatch`.
   */
  setCandidate(uid: number, candidate?: AudioCandidate): void {
    if (this.#destroyed) return
    const queue = setQueueCandidate(this.#state.queue, uid, candidate)
    if (queue === this.#state.queue) return
    this.#commit({ queue })
    // A preparation of this item resolved the old candidate.
    if (this.#preload?.uid === uid) this.#cancelPreload()
    if (currentQueueItem(queue)?.uid !== uid) return
    this.#ask()
    this.#lastFailure = undefined
    this.#attempts = 0
    const { status, positionMs } = this.#state
    const playing = this.#wantsPlayback()
    if (!playing && this.#loaded === undefined) return
    const startAtMs = status === 'ended' ? 0 : positionMs
    void this.#load({ autoplay: playing, startAtMs, reason: 'replace' })
  }

  // --- Transport -----------------------------------------------------------------------------

  /**
   * Plays. With an `index`, jumps to that item and plays it from the start. Without one,
   * resumes the current item: after an error it tries that item again, and after the end of
   * the queue it plays what was added since, or the last track again.
   */
  async play(index?: number): Promise<void> {
    if (this.#destroyed) return
    const { queue, status } = this.#state
    if (index !== undefined && index !== queue.index) {
      const jumped = jumpInQueue(queue, index)
      if (jumped === queue) return
      this.#engine.unlock?.()
      this.#userAction()
      this.#changeQueue(jumped, 'jump')
      this.#ask()
      await this.#load({ autoplay: true })
      return
    }
    if (currentQueueItem(queue) === undefined || status === 'loading' || status === 'playing')
      return
    this.#engine.unlock?.()
    this.#userAction()
    if (status === 'ended') {
      const next = hasNextQueueItem(queue) ? skipToNext(queue) : queue
      const moved = this.#changeQueue(next, 'next')
      this.#ask()
      if (moved) await this.#load({ autoplay: true })
      else await this.#restart(true, 'restart')
      return
    }
    this.#ask()
    const loaded = this.#loaded
    const positionMs = this.#state.positionMs
    if (loaded === undefined) {
      await this.#load({ autoplay: true, startAtMs: positionMs })
      return
    }
    if (this.#isExpiring(loaded.stream)) {
      await this.#refresh(loaded.stream, positionMs)
      return
    }
    this.#commit({ status: 'playing', buffering: true, error: undefined })
    this.#armStallTimer()
    await this.#engine.play()
  }

  /**
   * Pauses. A track still resolving loads paused. A failed track waiting for its retry waits
   * for play instead: the player never retries or skips while paused.
   */
  pause(): void {
    if (this.#destroyed || !this.#wantsPlayback()) return
    this.#clearStallTimer()
    this.#clearRetryTimer()
    this.#commit({ status: 'paused', buffering: false })
    if (this.#loaded !== undefined) this.#engine.pause()
  }

  /** Pauses when playing (or about to), plays otherwise. */
  async toggle(): Promise<void> {
    if (this.#wantsPlayback()) this.pause()
    else await this.play()
  }

  /**
   * Skips to the next item, wrapping when repeat is on. It keeps playing if it was, and stays
   * paused (without loading anything) if it was paused. At the end of the queue with repeat off
   * it does nothing.
   */
  async next(): Promise<void> {
    if (this.#destroyed) return
    const { queue, status } = this.#state
    if (!hasNextQueueItem(queue)) return
    this.#engine.unlock?.()
    this.#userAction()
    const autoplay = status !== 'paused'
    if (!this.#changeQueue(skipToNext(queue), 'next')) await this.#restart(autoplay, 'restart')
    else if (autoplay) await this.#load({ autoplay: true })
    else this.#commit({ status: 'paused', buffering: false })
  }

  /**
   * Restarts the current item when more than 3 s in (and when there is nothing before it),
   * otherwise goes back to the previous item. Keeps playing or stays paused like {@link next}.
   */
  async previous(): Promise<void> {
    if (this.#destroyed) return
    const { queue, status, positionMs } = this.#state
    if (currentQueueItem(queue) === undefined) return
    this.#engine.unlock?.()
    this.#userAction()
    const autoplay = status !== 'paused'
    const back = skipToPrevious(queue, positionMs)
    const moved = this.#changeQueue(back, 'previous')
    this.#ask()
    if (!moved) await this.#restart(autoplay, 'restart')
    else if (autoplay) await this.#load({ autoplay: true })
    else this.#commit({ status: 'paused', buffering: false })
  }

  /** Moves to `positionMs` within the current track, clamped to the track. */
  seek(positionMs: number): void {
    if (this.#destroyed || !Number.isFinite(positionMs)) return
    if (currentQueueItem(this.#state.queue) === undefined) return
    const { durationMs, status } = this.#state
    const target = Math.max(
      0,
      durationMs === undefined ? positionMs : Math.min(positionMs, durationMs),
    )
    this.#seekTo(target, 'user')
    if (status === 'ended') this.#commit({ status: 'paused' })
  }

  /** Moves the position by `deltaMs` (negative to go back). */
  seekBy(deltaMs: number): void {
    this.seek(this.#state.positionMs + deltaMs)
  }

  /** Pauses and goes back to the start of the current track. */
  stop(): void {
    if (this.#destroyed || currentQueueItem(this.#state.queue) === undefined) return
    this.pause()
    this.#seekTo(0, 'user')
    const { status } = this.#state
    if (status === 'ended' || status === 'error') {
      this.#commit({ status: 'paused', error: undefined })
    }
  }

  /** Sets the volume, from 0 to 1. */
  setVolume(volume: number): void {
    if (this.#destroyed || !Number.isFinite(volume)) return
    const value = clampVolume(volume)
    this.#engine.setVolume(value)
    this.#commit({ volume: value })
  }

  /** Mutes or unmutes, keeping the volume. */
  setMuted(muted: boolean): void {
    if (this.#destroyed) return
    this.#engine.setMuted(muted)
    this.#commit({ muted })
  }

  // --- Audio effects -------------------------------------------------------------------------

  /**
   * Applies the audio effects (stage 8.1): the equalizer and loudness normalization go to the
   * engine, which reports what they do to the current track in `effects`; the speed to the
   * engine as well (`playbackRate`); crossfade the player does itself. `settings` is validated
   * with `sanitizeAudioEffects`, so stored settings can be passed as they are.
   */
  setAudioEffects(settings: AudioEffectsSettings): void {
    if (this.#destroyed) return
    this.#applyEffects(sanitizeAudioEffects(settings))
  }

  /** The audio effects in use. */
  getAudioEffects(): AudioEffectsSettings {
    return this.#effects
  }

  /** Sets the playback speed, 1 being normal, keeping the other effects. The pitch stays. */
  setPlaybackRate(rate: number): void {
    this.setAudioEffects({ ...this.#effects, playbackRate: rate })
  }

  /** What the engine supports of the audio effects. */
  effectsSupport(): EffectsSupport {
    const engine = this.#engine
    const volume = engine.canSetVolume?.() ?? true
    return {
      effects: engine.setEffects !== undefined,
      playbackRate: engine.setPlaybackRate !== undefined,
      crossfade: engine.crossfade !== undefined && volume,
      volume,
    }
  }

  /**
   * Starts a sleep timer, replacing the one that runs, or cancels it with `null`:
   *
   * - `{ afterMs }`: pauses that long from now, after fading out over the last `sleepFadeMs`
   *   (12 s by default), where the engine fades. Pausing or playing meanwhile doesn't stop it.
   * - `{ endOfTrack: true }`: pauses when the current track ends, on the next track, ready to
   *   play it (with repeat one, at the start of the same track); no crossfade into it.
   *
   * It announces `sleep` when it paused playback, and the state's `sleepTimer` shows it while it
   * runs. Engines that run their own timer (Android's native player, whose playback goes on while
   * the page may not run) get it too, and whichever comes first pauses.
   */
  setSleepTimer(request: SleepTimerRequest | null): void {
    if (this.#destroyed) return
    this.#clearSleepTimers(true)
    const engine = this.#engine
    if (request === null) {
      engine.setSleepTimer?.(null)
      this.#commit({ sleepTimer: undefined })
      return
    }
    if ('endOfTrack' in request) {
      const timer: SleepTimerState = { endOfTrack: true }
      engine.setSleepTimer?.(timer)
      this.#commit({ sleepTimer: timer })
      return
    }
    const afterMs = nonNegative(request.afterMs, 0)
    const endsAt = this.#now() + afterMs
    const fadeMs = Math.min(this.#config.sleepFadeMs, afterMs)
    const timer: SleepTimerState = { endsAt, fadeMs }
    if (engine.setSleepTimer !== undefined) {
      engine.setSleepTimer(timer)
    } else if (engine.fadeOutput !== undefined && fadeMs > 0) {
      this.#sleepFadeTimer = setTimeout(() => {
        this.#sleepFadeTimer = undefined
        this.#sleepFading = true
        engine.fadeOutput?.(0, Math.max(0, endsAt - this.#now()))
      }, afterMs - fadeMs)
    }
    // An engine with its own timer pauses on time; the player's deadline is the safety net.
    const graceMs = engine.setSleepTimer === undefined ? 0 : SLEEP_GRACE_MS
    this.#sleepTimer = setTimeout(() => {
      this.#sleepTimer = undefined
      this.#sleep('timer')
    }, afterMs + graceMs)
    this.#commit({ sleepTimer: timer })
  }

  /** Stops everything, destroys the engine and drops every listener. */
  destroy(): void {
    if (this.#destroyed) return
    this.#cancel()
    this.#cancelPreload()
    this.#clearSleepTimers(false)
    this.#destroyed = true
    for (const detach of this.#detach) detach()
    this.#engine.destroy()
    this.#subscribers.clear()
    this.#events.clear()
  }

  // --- State ---------------------------------------------------------------------------------

  #commit(patch: Partial<PlayerState>): void {
    const previous = this.#state
    const keys = Object.keys(patch) as (keyof PlayerState)[]
    if (keys.every((key) => Object.is(previous[key], patch[key]))) return
    const state: PlayerState = { ...previous, ...patch }
    this.#state = state
    for (const listener of [...this.#subscribers]) callSafely(listener, state, previous)
  }

  /**
   * Commits `queue`. When its current item differs, drops everything pending for the old one,
   * resets the per-track state and announces the change. Returns whether the item changed.
   * A restored queue always counts as a change: its uids are the saved queue's, which may name
   * other items than the uids of the queue it replaces.
   */
  #changeQueue(queue: QueueState, cause: TrackChangeCause): boolean {
    const before = this.#state.queue
    if (queue === before) return false
    const previous = currentQueueItem(before)
    const item = currentQueueItem(queue)
    const same =
      cause === 'restore'
        ? previous === undefined && item === undefined
        : previous?.uid === item?.uid
    if (same) {
      this.#commit({ queue })
      this.#syncPreload()
      return false
    }
    this.#cancel()
    this.#attempts = 0
    this.#lastFailure = undefined
    this.#explicitUid = undefined
    this.#healthyAtMs = undefined
    this.#announced = undefined
    this.#commit({
      queue,
      positionMs: 0,
      durationMs: item?.track.durationMs,
      buffering: false,
      stream: undefined,
      error: undefined,
    })
    this.#syncPreload()
    this.#events.emit('trackchange', { item, previous, cause })
    return true
  }

  /** Applies a queue edit; if it replaced the current item, plays or selects the new one. */
  #edit(queue: QueueState, cause: TrackChangeCause): void {
    if (this.#destroyed) return
    const wasPlaying = this.#wantsPlayback()
    if (!this.#changeQueue(queue, cause)) return
    if (currentQueueItem(queue) === undefined) this.#commit({ status: 'idle' })
    else if (wasPlaying) void this.#load({ autoplay: true })
    else this.#commit({ status: 'paused' })
  }

  #wantsPlayback(): boolean {
    const { status } = this.#state
    return status === 'loading' || status === 'playing'
  }

  /** An explicit user action: the user asked for playback, so the failure counts start over. */
  #userAction(): void {
    this.#attempts = 0
    this.#resetRun()
  }

  /** The user asked for the current item: its resolutions are explicit until it changes. */
  #ask(): void {
    this.#explicitUid = currentQueueItem(this.#state.queue)?.uid
  }

  /** Ends the current run of failed tracks. */
  #resetRun(): void {
    this.#failedTracks = 0
    this.#failedRun = 0
    this.#failedUids.clear()
  }

  #markHealthy(): void {
    this.#attempts = 0
    this.#lastFailure = undefined
    this.#healthyAtMs = undefined
    this.#resetRun()
  }

  #isExpiring(stream: StreamOption): boolean {
    const { expiresAt } = stream
    return expiresAt !== undefined && expiresAt - this.#config.refreshBeforeExpiryMs <= this.#now()
  }

  /** How sure the engine is that it can play `stream`; never `capped` ones. */
  #support(stream: StreamOption): PlaySupport {
    if (stream.fullLength === 'capped') return 'no'
    return this.#engine.canPlay?.(stream) ?? 'maybe'
  }

  // --- Loading -------------------------------------------------------------------------------

  /** Drops whatever is loading, retrying or loaded for the current item. */
  #cancel(): void {
    this.#token += 1
    this.#abort?.abort()
    this.#abort = undefined
    this.#clearRetryTimer()
    this.#clearStallTimer()
    if (this.#loaded !== undefined) {
      this.#loaded = undefined
      // A crossfade's engine plays the next item already: the old one fades out by itself.
      if (!this.#handover) this.#engine.pause()
    }
  }

  /** Loads a fresh stream for a loaded one that expires soon, at `positionMs`, and plays it. */
  async #refresh(stream: StreamOption, positionMs: number): Promise<void> {
    const error = new EngineError('expired', 'The stream URL expires before it can play')
    const started = this.#loaded?.stream === stream && this.#loaded?.played === true
    const failure: StreamFailure = { error, stream, positionMs, started }
    await this.#load({ autoplay: true, startAtMs: positionMs, reason: 'refresh', failure })
  }

  /** Resolves and loads the current item, then plays it if `request.autoplay` still holds. */
  async #load(request: LoadRequest): Promise<void> {
    this.#cancel()
    const token = this.#token
    const item = currentQueueItem(this.#state.queue)
    if (item === undefined) {
      this.#commit({ status: 'idle', buffering: false })
      return
    }
    const remembered = this.#lastFailure?.uid === item.uid ? this.#lastFailure.failure : undefined
    const reason = request.reason ?? (remembered === undefined ? 'play' : 'retry')
    const failure = request.failure ?? (reason === 'retry' ? remembered : undefined)
    // A user playing a failed item again starts a new round of retries, after that failure.
    if (reason === 'retry' && this.#attempts === 0) this.#attempts = 1
    const abort = new AbortController()
    this.#abort = abort
    this.#commit({
      status: request.autoplay ? 'loading' : 'paused',
      buffering: request.autoplay,
      positionMs: nonNegative(request.startAtMs, 0),
      error: undefined,
    })
    let resolved: ResolvedStream
    try {
      resolved = await this.#resolve(item, reason, failure, abort.signal)
    } catch (error) {
      if (token === this.#token) this.#fail(item, toError(error), undefined)
      return
    }
    if (token !== this.#token) return
    if (resolved.candidate !== undefined) {
      this.#commit({ queue: setQueueCandidate(this.#state.queue, item.uid, resolved.candidate) })
    }
    const { stream } = resolved
    const refusal = this.#refusal(stream)
    if (refusal !== undefined) {
      this.#fail(item, refusal, stream)
      return
    }
    const startAtMs = this.#state.positionMs
    this.#loaded = { uid: item.uid, stream, played: false }
    this.#healthyAtMs = startAtMs + HEALTHY_AFTER_MS
    this.#commit({ stream })
    try {
      const source = { stream, item: currentQueueItem(this.#state.queue) ?? item }
      await this.#engine.load(source, startAtMs)
    } catch (error) {
      if (token === this.#token) this.#fail(item, toError(error), stream)
      return
    }
    if (token !== this.#token || this.#state.status !== 'loading') return
    this.#armStallTimer()
    await this.#engine.play()
  }

  /** The stream for `item`: the one prepared ahead when it is still fresh, else a new one. */
  async #resolve(
    item: QueueItem,
    reason: ResolveReason,
    failure: StreamFailure | undefined,
    signal: AbortSignal,
  ): Promise<ResolvedStream> {
    const preloaded = reason === 'play' ? this.#takePreload(item, signal) : undefined
    if (preloaded !== undefined) {
      try {
        const resolved = await preloaded
        if (!this.#isExpiring(resolved.stream)) return resolved
      } catch {
        // The preload failed: resolve again below.
      }
      if (signal.aborted) throw signal.reason
    }
    return this.#resolver.resolve(item, {
      reason,
      attempt: this.#attempts,
      ...(failure === undefined ? {} : { failure }),
      explicit: reason === 'replace' || this.#explicitUid === item.uid,
      mode: this.#state.queue.mode,
      signal,
      canPlay: this.#canPlay,
    })
  }

  /** Why the player will not hand `stream` to the engine, if it will not. */
  #refusal(stream: StreamOption): EngineError | undefined {
    if (stream.fullLength === 'capped') {
      return new EngineError('unsupported', 'The stream URL stops before the end of the file')
    }
    if (this.#support(stream) !== 'no') return undefined
    const { codec, container, protocol } = stream
    return new EngineError(
      'unsupported',
      `The engine cannot play ${codec} in ${container} (${protocol})`,
    )
  }

  /**
   * Counts a failed attempt to play `item` while playing: retries it after a delay, resuming
   * where it was, skips it or stops, as {@link PlayerOptions.classifyFailure} says. While paused
   * nothing is retried or skipped: the failure is kept, and the next play retries the item.
   */
  #fail(item: QueueItem, error: Error, stream: StreamOption | undefined): void {
    const playing = this.#wantsPlayback()
    const positionMs = this.#state.positionMs
    const started = this.#loaded?.stream === stream && this.#loaded?.played === true
    this.#cancel()
    const failure: StreamFailure =
      stream === undefined ? { error, positionMs } : { error, stream, positionMs, started }
    this.#lastFailure = { uid: item.uid, failure }
    if (!playing) {
      this.#commit({ buffering: false })
      return
    }
    const failureClass = this.#classifyFailure(error, item)
    if (failureClass === 'stop') {
      this.#events.emit('trackfailed', { item, error })
      this.#stop('action-required', item, error)
      return
    }
    if (failureClass === 'skip') {
      this.#giveUp(item, error, false)
      return
    }
    this.#attempts += 1
    if (this.#attempts > this.#config.maxRetries) {
      this.#giveUp(item, error, true)
      return
    }
    this.#commit({ status: 'loading', buffering: true })
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      void this.#load({ autoplay: true, startAtMs: this.#state.positionMs })
    }, this.#retryDelay(error))
  }

  /** The class of a failure; a classifier that throws or answers nonsense means `retry`. */
  #classifyFailure(error: Error, item: QueueItem): FailureClass {
    try {
      const failureClass = this.#classify(error, item)
      return FAILURE_CLASSES.includes(failureClass) ? failureClass : 'retry'
    } catch (classifierError) {
      console.error(classifierError)
      return 'retry'
    }
  }

  /** The wait before the next retry: the configured delay, or longer if the source says so. */
  #retryDelay(error: Error): number {
    const delays = this.#config.retryDelaysMs
    const delayMs = delays[this.#attempts - 1] ?? delays.at(-1) ?? 0
    const retryAfterMs = isFxmError(error, 'RateLimited') ? error.retryAfterMs : undefined
    return retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
      ? Math.max(delayMs, retryAfterMs)
      : delayMs
  }

  /**
   * Gives up on `item`, after its retries (`retried`) or at once, and moves to the next item.
   * Stops instead when too many tracks failed in a row, or when there is no next item that has
   * not failed already in this run.
   */
  #giveUp(item: QueueItem, error: Error, retried: boolean): void {
    this.#attempts = 0
    this.#failedRun += 1
    if (retried) this.#failedTracks += 1
    this.#failedUids.add(item.uid)
    this.#events.emit('trackfailed', { item, error })
    const config = this.#config
    if (
      this.#failedTracks >= config.maxConsecutiveFailures ||
      this.#failedRun >= config.maxConsecutiveSkips
    ) {
      this.#stop('circuit-open', item, error)
      this.#events.emit('circuitopen', { failures: this.#failedRun })
      return
    }
    const { queue } = this.#state
    const next = skipToNext(queue)
    const nextUid = currentQueueItem(next)?.uid
    if (next === queue || nextUid === undefined || this.#failedUids.has(nextUid)) {
      this.#stop('track-failed', item, error)
      return
    }
    this.#changeQueue(next, 'failed')
    void this.#load({ autoplay: true })
  }

  #stop(reason: PlayerErrorReason, item: QueueItem, error: Error): void {
    this.#attempts = 0
    this.#commit({ status: 'error', buffering: false, error: { reason, error, item } })
  }

  /** Plays the current item again from the start (or just rewinds it). */
  async #restart(autoplay: boolean, cause: 'restart' | 'repeat'): Promise<void> {
    this.#seekTo(0, cause)
    if (!autoplay) {
      if (this.#state.status === 'ended') this.#commit({ status: 'paused' })
      return
    }
    const loaded = this.#loaded
    if (loaded === undefined) {
      await this.#load({ autoplay: true })
      return
    }
    if (this.#isExpiring(loaded.stream)) {
      await this.#refresh(loaded.stream, 0)
      return
    }
    this.#commit({ status: 'playing', buffering: true, error: undefined })
    this.#armStallTimer()
    await this.#engine.play()
  }

  #seekTo(positionMs: number, cause: SeekCause): void {
    if (this.#loaded !== undefined) this.#engine.seek(positionMs)
    // A seek is no progress: the stall watch measures from the new position.
    if (this.#stallFromMs !== undefined) this.#stallFromMs = positionMs
    this.#commit({ positionMs })
    this.#events.emit('seek', { positionMs, cause })
  }

  // --- Timers --------------------------------------------------------------------------------

  /**
   * Starts the stall watch: unless audio plays (a `play` event, or the position moving on)
   * within `stallTimeoutMs`, the attempt counts as a network failure.
   */
  #armStallTimer(): void {
    this.#clearStallTimer()
    const timeoutMs = this.#config.stallTimeoutMs
    if (timeoutMs <= 0) return
    this.#stallFromMs = this.#state.positionMs
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = undefined
      this.#stallFromMs = undefined
      const loaded = this.#loaded
      const item = currentQueueItem(this.#state.queue)
      if (loaded === undefined || item === undefined || !this.#wantsPlayback()) return
      this.#fail(item, new EngineError('network', `No audio for ${timeoutMs} ms`), loaded.stream)
    }, timeoutMs)
  }

  #clearStallTimer(): void {
    this.#stallFromMs = undefined
    if (this.#stallTimer === undefined) return
    clearTimeout(this.#stallTimer)
    this.#stallTimer = undefined
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer === undefined) return
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
  }

  // --- Preloading ----------------------------------------------------------------------------

  /**
   * Once the current track is close enough to its end: prepares the next item (with the
   * `preload` option) and announces it with the `preload` event.
   */
  #maybePreload(): void {
    if (this.#loaded === undefined) return
    const { queue, positionMs, durationMs } = this.#state
    const current = currentQueueItem(queue)
    const next = nextQueueItem(queue)
    if (queue.repeat === 'one' || current === undefined || next === undefined) return
    if (next.uid === current.uid) return
    const totalMs = durationMs ?? current.track.durationMs
    if (totalMs === undefined || totalMs - positionMs > this.#config.preloadLeadMs) return
    if (this.#config.preload && this.#preload?.uid !== next.uid) this.#startPreload(next)
    const announced = this.#announced
    if (announced?.current === current.uid && announced.next === next.uid) return
    this.#announced = { current: current.uid, next: next.uid }
    this.#events.emit('preload', { next, upcoming: upcomingQueueItems(queue) })
  }

  /** Resolves `next` ahead and hands the stream to the engine. */
  #startPreload(next: QueueItem): void {
    this.#cancelPreload()
    const abort = new AbortController()
    const promise = new Promise<ResolvedStream>((resolve) => {
      resolve(
        this.#resolver.resolve(next, {
          reason: 'preload',
          attempt: 0,
          explicit: false,
          mode: this.#state.queue.mode,
          signal: abort.signal,
          canPlay: this.#canPlay,
        }),
      )
    })
    const preload: Preload = { uid: next.uid, abort, promise }
    this.#preload = preload
    promise.then(
      (resolved) => {
        if (this.#preload !== preload || this.#refusal(resolved.stream) !== undefined) return
        preload.resolved = resolved
        this.#engine.preload?.({ stream: resolved.stream, item: next })
      },
      () => {
        // Nothing prepared: the item resolves again when it plays.
      },
    )
  }

  /** Hands the preparation for `item` to its load, which then owns its cancellation. */
  #takePreload(item: QueueItem, signal: AbortSignal): Promise<ResolvedStream> | undefined {
    const preload = this.#preload
    if (preload === undefined || preload.uid !== item.uid) return undefined
    this.#preload = undefined
    signal.addEventListener('abort', () => preload.abort.abort(), { once: true })
    return preload.promise
  }

  #cancelPreload(): void {
    const preload = this.#preload
    if (preload === undefined) return
    this.#preload = undefined
    preload.abort.abort()
    this.#engine.preload?.(null)
  }

  /** Drops a preparation for an item that is no longer current or next. */
  #syncPreload(): void {
    const preload = this.#preload
    if (preload === undefined) return
    const { queue } = this.#state
    const { uid } = preload
    if (uid === currentQueueItem(queue)?.uid || uid === nextQueueItem(queue)?.uid) return
    this.#cancelPreload()
  }

  // --- Effects, crossfade and the sleep timer ------------------------------------------------

  #applyEffects(settings: AudioEffectsSettings): void {
    this.#effects = settings
    const engine = this.#engine
    if (engine.setEffects !== undefined) {
      // The engine reports what they do to the current track with `effects`.
      engine.setEffects({ equalizer: settings.equalizer, loudness: settings.loudness })
    } else {
      this.#commit({ effects: effectsWithoutEngine(settings) })
    }
    const playbackRate = engine.setPlaybackRate === undefined ? 1 : settings.playbackRate
    engine.setPlaybackRate?.(playbackRate)
    this.#commit({ playbackRate })
  }

  /**
   * Starts the crossfade into the next item once the current track is that close to its end
   * (in real time, so at the playback speed): only for the item that follows by itself (not on
   * repeat one, nor at the end of the queue), when its stream is resolved and prepared in the
   * engine, not between tracks of one album unless the setting says so, and not while a sleep
   * timer waits for the end of the track. Tried on every position report until the engine can.
   */
  #maybeCrossfade(): void {
    const { durationMs: crossfadeMs, sameAlbum: acrossAlbum } = this.#effects.crossfade
    const engine = this.#engine
    if (crossfadeMs <= 0 || engine.crossfade === undefined) return
    const state = this.#state
    if (state.status !== 'playing' || state.buffering) return
    if (state.sleepTimer !== undefined && 'endOfTrack' in state.sleepTimer) return
    const loaded = this.#loaded
    if (loaded === undefined || !loaded.played) return
    const { queue, durationMs, positionMs, playbackRate } = state
    const current = currentQueueItem(queue)
    const next = nextQueueItem(queue)
    if (queue.repeat === 'one' || current === undefined || next === undefined) return
    if (next.uid === current.uid || (!acrossAlbum && sameAlbum(current.track, next.track))) return
    const preload = this.#preload
    const resolved = preload?.uid === next.uid ? preload.resolved : undefined
    if (resolved === undefined || this.#isExpiring(resolved.stream) || durationMs === undefined) {
      return
    }
    const remainingMs = (durationMs - positionMs) / playbackRate
    if (remainingMs > crossfadeMs || remainingMs < MIN_CROSSFADE_MS) return
    // What the engine reports during the call is about `next` already (see `Engine.crossfade`),
    // while the state still shows the current track: its duration waits for the hand-over.
    this.#crossfading = true
    this.#incomingDurationMs = undefined
    let started = false
    try {
      started = engine.crossfade({ stream: resolved.stream, item: next }, remainingMs)
    } finally {
      this.#crossfading = false
    }
    const incomingDurationMs = this.#incomingDurationMs
    this.#incomingDurationMs = undefined
    if (started) this.#adoptCrossfade(next, resolved, incomingDurationMs)
  }

  /**
   * The engine started `next` in a crossfade: the current track counts as played to its end
   * (cause `ended`), and `next` becomes current with the stream the engine plays, without a new
   * load, and with the duration the engine reported during the call, if it did. Its `play` event
   * comes from the engine.
   */
  #adoptCrossfade(next: QueueItem, resolved: ResolvedStream, durationMs: number | undefined): void {
    // The preparation is taken: its stream plays.
    this.#preload = undefined
    this.#markHealthy()
    this.#clearStallTimer()
    this.#handover = true
    try {
      this.#changeQueue(skipToNext(this.#state.queue), 'ended')
    } finally {
      this.#handover = false
    }
    // A listener of the track change may have moved on already: its action wins.
    if (currentQueueItem(this.#state.queue)?.uid !== next.uid || this.#loaded !== undefined) return
    if (resolved.candidate !== undefined) {
      this.#commit({ queue: setQueueCandidate(this.#state.queue, next.uid, resolved.candidate) })
    }
    const { stream } = resolved
    this.#loaded = { uid: next.uid, stream, played: false }
    this.#healthyAtMs = HEALTHY_AFTER_MS
    const duration = durationMs === undefined ? {} : { durationMs }
    if (!this.#wantsPlayback()) {
      // A listener paused meanwhile.
      this.#engine.pause()
      this.#commit({ stream, ...duration })
      return
    }
    this.#commit({ status: 'playing', buffering: true, stream, error: undefined, ...duration })
    this.#armStallTimer()
  }

  /** The sleep timer's time came: pause, if playing, and put the output back for later. */
  #sleep(reason: SleepReason): void {
    const playing = this.#wantsPlayback()
    this.#clearSleepTimers(false)
    this.#engine.setSleepTimer?.(null)
    if (playing) this.pause()
    if (this.#engine.fadeOutput !== undefined) this.#engine.fadeOutput(1, 0)
    this.#commit({ sleepTimer: undefined })
    if (playing) this.#events.emit('sleep', { reason })
  }

  /**
   * The track a sleep timer waited for ended: the next item becomes current, paused, ready to
   * play; with repeat one, or a queue of one repeating, the track goes back to its start, paused;
   * at the end of the queue it ends as usual.
   */
  #sleepAtEnd(): void {
    this.#engine.setSleepTimer?.(null)
    this.#commit({ sleepTimer: undefined })
    const { queue, durationMs, positionMs } = this.#state
    if (!hasNextQueueItem(queue)) {
      this.#commit({ status: 'ended', buffering: false, positionMs: durationMs ?? positionMs })
      this.#events.emit('queueend', undefined)
    } else if (queue.repeat !== 'one' && this.#changeQueue(skipToNext(queue), 'ended')) {
      this.#commit({ status: 'paused', buffering: false })
    } else {
      this.#seekTo(0, 'repeat')
      this.#commit({ status: 'paused', buffering: false })
    }
    this.#events.emit('sleep', { reason: 'end-of-track' })
  }

  /** What the effects do now, as the engine reports it; an unchanged report changes nothing. */
  #onEffects(status: AudioEffectsStatus): void {
    const { effects } = this.#state
    if (
      effects.equalizer === status.equalizer &&
      effects.equalizerReason === status.equalizerReason &&
      effects.loudness === status.loudness &&
      effects.loudnessGainDb === status.loudnessGainDb
    ) {
      return
    }
    this.#commit({ effects: { ...status } })
  }

  /**
   * The engine's own sleep timer ended, pausing playback if something played: like the player's
   * own timer, it announces `sleep` only then.
   */
  #onEngineSleep(reason: SleepReason): void {
    if (this.#state.sleepTimer === undefined) return
    const playing = this.#wantsPlayback()
    this.#clearSleepTimers(false)
    if (playing) this.pause()
    this.#commit({ sleepTimer: undefined })
    if (playing) this.#events.emit('sleep', { reason })
  }

  /** Stops the sleep timer's timers; `restore` brings the output back if it was fading. */
  #clearSleepTimers(restore: boolean): void {
    if (this.#sleepTimer !== undefined) clearTimeout(this.#sleepTimer)
    if (this.#sleepFadeTimer !== undefined) clearTimeout(this.#sleepFadeTimer)
    this.#sleepTimer = undefined
    this.#sleepFadeTimer = undefined
    if (this.#sleepFading && restore) this.#engine.fadeOutput?.(1, SLEEP_RESTORE_MS)
    this.#sleepFading = false
  }

  // --- Engine events -------------------------------------------------------------------------

  #onTimeUpdate(positionMs: number): void {
    const loaded = this.#loaded
    // Before the load first plays, the player knows better: it asked the engine where to start.
    if (loaded === undefined || !loaded.played || !Number.isFinite(positionMs)) return
    const stalledAt = this.#stallFromMs
    if (
      stalledAt !== undefined &&
      positionMs >= stalledAt + PROGRESS_PROOF_MS &&
      this.#wantsPlayback()
    ) {
      // The position moves on, so audio plays, whatever `waiting` or `stalled` said.
      this.#clearStallTimer()
      this.#commit({ positionMs, buffering: false })
    } else {
      this.#commit({ positionMs })
    }
    if (this.#healthyAtMs !== undefined && positionMs >= this.#healthyAtMs) this.#markHealthy()
    this.#maybePreload()
    this.#maybeCrossfade()
  }

  #onDurationChange(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return
    if (this.#crossfading) {
      this.#incomingDurationMs = durationMs
      return
    }
    if (this.#loaded === undefined) return
    this.#commit({ durationMs })
    this.#maybePreload()
  }

  #onPlay(): void {
    const loaded = this.#loaded
    if (loaded === undefined) return
    loaded.played = true
    this.#clearStallTimer()
    this.#commit({ status: 'playing', buffering: false, error: undefined })
  }

  #onPause(): void {
    if (this.#loaded === undefined || !this.#wantsPlayback()) return
    this.#clearStallTimer()
    this.#commit({ status: 'paused', buffering: false })
  }

  #onWaiting(): void {
    if (this.#loaded === undefined || !this.#wantsPlayback()) return
    this.#commit({ buffering: true })
    // Keep a running deadline, but measure progress from where playback stopped.
    if (this.#stallTimer === undefined) this.#armStallTimer()
    else this.#stallFromMs = this.#state.positionMs
  }

  #onEnded(): void {
    if (this.#loaded === undefined) return
    this.#markHealthy()
    this.#clearStallTimer()
    const { queue, sleepTimer } = this.#state
    if (sleepTimer !== undefined && 'endOfTrack' in sleepTimer) {
      this.#sleepAtEnd()
      return
    }
    if (queue.repeat === 'one') {
      void this.#restart(true, 'repeat')
      return
    }
    if (!hasNextQueueItem(queue)) {
      const { durationMs, positionMs } = this.#state
      this.#commit({ status: 'ended', buffering: false, positionMs: durationMs ?? positionMs })
      this.#events.emit('queueend', undefined)
      return
    }
    if (this.#changeQueue(skipToNext(queue), 'ended')) void this.#load({ autoplay: true })
    else void this.#restart(true, 'repeat')
  }

  #onError(error: EngineError): void {
    const loaded = this.#loaded
    const item = currentQueueItem(this.#state.queue)
    if (loaded === undefined || item === undefined) return
    if (error.type === 'autoplay-blocked') {
      this.#clearStallTimer()
      this.#commit({ status: 'paused', buffering: false })
      this.#events.emit('autoplayblocked', undefined)
      return
    }
    this.#fail(item, error, loaded.stream)
  }
}
