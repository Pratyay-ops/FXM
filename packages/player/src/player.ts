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
  addToQueue,
  type CatalogMode,
  clearUpcoming,
  createQueue,
  currentQueueItem,
  hasNextQueueItem,
  jumpInQueue,
  moveInQueue,
  nextQueueItem,
  playNext,
  type QueueContext,
  type QueueItem,
  type QueueOptions,
  type QueueState,
  type RandomSource,
  type RepeatMode,
  removeFromQueue,
  type StreamOption,
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
import { type Engine, EngineError } from './engine'
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

/** Why playback stopped with status `error`. */
export interface PlayerError {
  /**
   * `track-failed`: the last track in the queue failed every retry. `circuit-open`: too many
   * tracks failed in a row, so the player stopped skipping (a dead connection, most likely).
   */
  reason: 'track-failed' | 'circuit-open'
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
}

/** The events a {@link Player} announces, with their payloads. */
export interface PlayerEventMap {
  /** The current item changed. `item` is `undefined` when the queue became empty. */
  trackchange: { item: QueueItem | undefined; previous: QueueItem | undefined }
  /** The position jumped: a seek, a restart by "previous", or a repeat of the track. */
  seek: { positionMs: number }
  /** A track failed every retry. The player skips it unless it has to stop. */
  trackfailed: { item: QueueItem; error: Error }
  /** Too many tracks failed in a row, so playback stopped. */
  circuitopen: { failures: number }
  /** The last track ended and nothing follows. */
  queueend: undefined
  /** The browser wants a user gesture before playback can start: show a play button. */
  autoplayblocked: undefined
}

/** Receives every new {@link PlayerState}, with the one it replaces. */
export type PlayerStateListener = (state: PlayerState, previous: PlayerState) => void

/** Called when the next track is being prepared; see {@link PlayerOptions.onPreload}. */
export type PreloadHook = (next: QueueItem, upcoming: readonly QueueItem[]) => void

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
  /** Failed tracks in a row that stop playback (the circuit breaker). Default: 4. */
  maxConsecutiveFailures?: number
  /** How long playback may wait for data before that counts as a network failure; 0 never. */
  stallTimeoutMs?: number
  /** Whether to prepare the next track before the current one ends. Default: true. */
  preload?: boolean
  /** How long before the end of the current track to prepare the next one. Default: 30 s. */
  preloadLeadMs?: number
  /** Resolve again a loaded stream this close to its `expiresAt`. Default: 10 minutes. */
  refreshBeforeExpiryMs?: number
  /**
   * Called once per track when the next one is being prepared, with the upcoming items, e.g.
   * to prefetch more of them. The player itself resolves only the next one.
   */
  onPreload?: PreloadHook
}

/** Options for {@link Player.setQueue}. */
export interface SetQueueOptions {
  /** Whether to start playing at once. Default: true. */
  autoplay?: boolean
}

/** The defaults behind {@link PlayerOptions}. */
export const PLAYER_DEFAULTS = Object.freeze({
  maxRetries: 3,
  retryDelaysMs: Object.freeze([0, 1000, 3000]),
  maxConsecutiveFailures: 4,
  stallTimeoutMs: 15_000,
  preloadLeadMs: 30_000,
  refreshBeforeExpiryMs: 10 * 60_000,
})

/**
 * How much of a track must play after a (re)load before it counts as healthy, which resets its
 * retry count and the circuit breaker. Reaching the end counts too.
 */
const HEALTHY_AFTER_MS = 5000

interface LoadRequest {
  /** Whether to play once loaded; otherwise the track is loaded paused. */
  autoplay: boolean
  /** Where to start, in milliseconds. */
  startAtMs?: number
  /** Why the stream is needed. Default: `play`. */
  reason?: ResolveReason
  /** What went wrong before, for `retry` and `refresh`. */
  failure?: StreamFailure
}

interface Preload {
  /** The item being prepared. */
  uid: number
  /** Cancels its resolution. */
  abort: AbortController
  /** Its resolution, shared with the load when the item comes up. */
  promise: Promise<ResolvedStream>
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

/**
 * Plays a queue of tracks through an engine. Every method is safe to call at any time and never
 * throws; the async ones resolve when the action has been carried out, and never reject. Read
 * the state with {@link getState} and {@link subscribe}, and discrete happenings with {@link on}.
 */
export class Player {
  #state: PlayerState
  readonly #engine: Engine
  readonly #resolver: StreamResolver
  readonly #random: RandomSource
  readonly #now: () => number
  readonly #onPreload: PreloadHook | undefined
  readonly #config: {
    maxRetries: number
    retryDelaysMs: readonly number[]
    maxConsecutiveFailures: number
    stallTimeoutMs: number
    preload: boolean
    preloadLeadMs: number
    refreshBeforeExpiryMs: number
  }
  readonly #events = new Emitter<PlayerEventMap>()
  readonly #subscribers = new Set<PlayerStateListener>()
  readonly #detach: (() => void)[]
  /** Increments whenever pending work for the current item must be dropped. */
  #token = 0
  #abort: AbortController | undefined
  /** The stream the engine holds for the current item, while its events count. */
  #loaded: { uid: number; stream: StreamOption } | undefined
  #preload: Preload | undefined
  /** Failed attempts for the current item. */
  #attempts = 0
  /** Tracks that failed in a row. */
  #failedTracks = 0
  /** The position from which the current load counts as healthy. */
  #healthyAtMs: number | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #stallTimer: ReturnType<typeof setTimeout> | undefined
  #destroyed = false

  constructor(options: PlayerOptions) {
    this.#engine = options.engine
    this.#resolver = options.resolver
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? Date.now
    this.#onPreload = options.onPreload
    this.#config = {
      maxRetries: Math.floor(nonNegative(options.maxRetries, PLAYER_DEFAULTS.maxRetries)),
      retryDelaysMs: options.retryDelaysMs ?? PLAYER_DEFAULTS.retryDelaysMs,
      maxConsecutiveFailures: Math.max(
        1,
        nonNegative(options.maxConsecutiveFailures, PLAYER_DEFAULTS.maxConsecutiveFailures),
      ),
      stallTimeoutMs: nonNegative(options.stallTimeoutMs, PLAYER_DEFAULTS.stallTimeoutMs),
      preload: options.preload ?? true,
      preloadLeadMs: nonNegative(options.preloadLeadMs, PLAYER_DEFAULTS.preloadLeadMs),
      refreshBeforeExpiryMs: nonNegative(
        options.refreshBeforeExpiryMs,
        PLAYER_DEFAULTS.refreshBeforeExpiryMs,
      ),
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
    ]
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
   * Replaces the queue with `tracks` and plays the one at `startIndex` (see `setQueue` in
   * `@fxm/core` for how the mode and shuffle apply).
   */
  async setQueue(
    tracks: readonly Track[],
    startIndex = 0,
    context?: QueueContext,
    options: SetQueueOptions = {},
  ): Promise<void> {
    if (this.#destroyed) return
    this.#userAction()
    const queue = setQueue(this.#state.queue, tracks, {
      startIndex,
      ...(context === undefined ? {} : { context }),
      random: this.#random,
    })
    this.#changeQueue(queue)
    if (currentQueueItem(queue) === undefined) {
      this.#commit({ status: 'idle', buffering: false })
      return
    }
    if (options.autoplay === false) {
      this.#commit({ status: 'paused', buffering: false })
      return
    }
    await this.#load({ autoplay: true })
  }

  /**
   * Puts back a saved queue (see `restoreQueue` in `@fxm/core`), paused at `positionMs` of its
   * current item. The player's mode applies. Playing resumes there.
   */
  restore(queue: QueueState, positionMs = 0): void {
    if (this.#destroyed) return
    this.#cancel()
    this.#cancelPreload()
    const restored = setQueueMode(queue, this.#state.queue.mode)
    this.#changeQueue(restored)
    const item = currentQueueItem(restored)
    this.#commit({
      status: item === undefined ? 'idle' : 'paused',
      buffering: false,
      positionMs: item === undefined ? 0 : nonNegative(positionMs, 0),
      durationMs: item?.track.durationMs,
      stream: undefined,
      error: undefined,
    })
  }

  /** Inserts `tracks` right after the current item. */
  playNext(tracks: readonly Track[]): void {
    this.#edit(playNext(this.#state.queue, tracks))
  }

  /** Appends `tracks` to the end of the queue. */
  addToQueue(tracks: readonly Track[]): void {
    this.#edit(addToQueue(this.#state.queue, tracks))
  }

  /** Removes the item at `index`. Removing the current item moves on to the following one. */
  remove(index: number): void {
    this.#edit(removeFromQueue(this.#state.queue, index))
  }

  /** Moves the item at `from` to `to`. */
  move(from: number, to: number): void {
    this.#edit(moveInQueue(this.#state.queue, from, to))
  }

  /** Removes every item after the current one. */
  clearUpcoming(): void {
    this.#edit(clearUpcoming(this.#state.queue))
  }

  /** Turns shuffle on or off. The current track keeps playing. */
  setShuffle(shuffle: boolean): void {
    this.#edit(setQueueShuffle(this.#state.queue, shuffle, this.#random))
  }

  /** Sets how the queue repeats. */
  setRepeat(repeat: RepeatMode): void {
    this.#edit(setQueueRepeat(this.#state.queue, repeat))
  }

  /** Switches the catalog mode. The current track keeps playing. */
  setMode(mode: CatalogMode): void {
    this.#edit(setQueueMode(this.#state.queue, mode))
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
      this.#userAction()
      this.#changeQueue(jumped)
      await this.#load({ autoplay: true })
      return
    }
    if (currentQueueItem(queue) === undefined || status === 'loading' || status === 'playing')
      return
    this.#userAction()
    if (status === 'ended') {
      const next = hasNextQueueItem(queue) ? skipToNext(queue) : queue
      if (this.#changeQueue(next)) await this.#load({ autoplay: true })
      else await this.#restart(true)
      return
    }
    const loaded = this.#loaded
    const positionMs = this.#state.positionMs
    if (loaded === undefined) {
      await this.#load({ autoplay: true, startAtMs: positionMs })
      return
    }
    if (this.#isExpiring(loaded.stream)) {
      const error = new EngineError('expired', 'The stream URL expired while paused')
      const failure = { error, stream: loaded.stream, positionMs }
      await this.#load({ autoplay: true, startAtMs: positionMs, reason: 'refresh', failure })
      return
    }
    this.#commit({ status: 'playing', buffering: true, error: undefined })
    this.#armStallTimer()
    await this.#engine.play()
  }

  /** Pauses. A track still loading stays loaded, paused. */
  pause(): void {
    if (this.#destroyed || !this.#wantsPlayback()) return
    this.#clearStallTimer()
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
    this.#userAction()
    const autoplay = status !== 'paused'
    if (!this.#changeQueue(skipToNext(queue))) await this.#restart(autoplay)
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
    this.#userAction()
    const autoplay = status !== 'paused'
    if (!this.#changeQueue(skipToPrevious(queue, positionMs))) await this.#restart(autoplay)
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
    this.#seekTo(target)
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
    this.#seekTo(0)
    const { status } = this.#state
    if (status === 'ended' || status === 'error')
      this.#commit({ status: 'paused', error: undefined })
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

  /** Stops everything, destroys the engine and drops every listener. */
  destroy(): void {
    if (this.#destroyed) return
    this.#cancel()
    this.#cancelPreload()
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
   */
  #changeQueue(queue: QueueState): boolean {
    const before = this.#state.queue
    if (queue === before) return false
    const previous = currentQueueItem(before)
    const item = currentQueueItem(queue)
    if (previous?.uid === item?.uid) {
      this.#commit({ queue })
      this.#syncPreload()
      return false
    }
    this.#cancel()
    this.#attempts = 0
    this.#healthyAtMs = undefined
    this.#commit({
      queue,
      positionMs: 0,
      durationMs: item?.track.durationMs,
      buffering: false,
      stream: undefined,
      error: undefined,
    })
    this.#syncPreload()
    this.#events.emit('trackchange', { item, previous })
    return true
  }

  /** Applies a queue edit; if it replaced the current item, plays or selects the new one. */
  #edit(queue: QueueState): void {
    if (this.#destroyed) return
    const wasPlaying = this.#wantsPlayback()
    if (!this.#changeQueue(queue)) return
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
    this.#failedTracks = 0
  }

  #markHealthy(): void {
    this.#attempts = 0
    this.#failedTracks = 0
    this.#healthyAtMs = undefined
  }

  #isExpiring(stream: StreamOption): boolean {
    const { expiresAt } = stream
    return expiresAt !== undefined && expiresAt - this.#config.refreshBeforeExpiryMs <= this.#now()
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
      this.#engine.pause()
    }
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
      resolved = await this.#resolve(item, request, abort.signal)
    } catch (error) {
      if (token === this.#token) this.#fail(item, toError(error), undefined)
      return
    }
    if (token !== this.#token) return
    if (resolved.candidate !== undefined) {
      this.#changeQueue(setQueueCandidate(this.#state.queue, item.uid, resolved.candidate))
    }
    const { stream } = resolved
    if (this.#engine.canPlay?.(stream) === false) {
      const message = `The engine cannot play ${stream.codec} in ${stream.container} (${stream.protocol})`
      this.#fail(item, new EngineError('unsupported', message), stream)
      return
    }
    const startAtMs = this.#state.positionMs
    this.#loaded = { uid: item.uid, stream }
    this.#healthyAtMs = startAtMs + HEALTHY_AFTER_MS
    this.#commit({ stream })
    try {
      await this.#engine.load(
        { stream, item: currentQueueItem(this.#state.queue) ?? item },
        startAtMs,
      )
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
    request: LoadRequest,
    signal: AbortSignal,
  ): Promise<ResolvedStream> {
    const reason = request.reason ?? 'play'
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
      ...(request.failure === undefined ? {} : { failure: request.failure }),
      signal,
    })
  }

  /**
   * Counts a failed attempt to play `item`: retries it after a delay, resuming where it was,
   * or gives up on it after the last retry.
   */
  #fail(item: QueueItem, error: Error, stream: StreamOption | undefined): void {
    const autoplay = this.#wantsPlayback()
    const positionMs = this.#state.positionMs
    this.#cancel()
    this.#attempts += 1
    if (this.#attempts > this.#config.maxRetries) {
      this.#trackFailed(item, error, autoplay)
      return
    }
    this.#commit({ status: autoplay ? 'loading' : 'paused', buffering: autoplay })
    const failure: StreamFailure =
      stream === undefined ? { error, positionMs } : { error, stream, positionMs }
    const delays = this.#config.retryDelaysMs
    const delayMs = delays[this.#attempts - 1] ?? delays.at(-1) ?? 0
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      const startAtMs = this.#state.positionMs
      void this.#load({ autoplay: this.#wantsPlayback(), startAtMs, reason: 'retry', failure })
    }, delayMs)
  }

  /** Gives up on `item`: skips to the next item, or stops when it must. */
  #trackFailed(item: QueueItem, error: Error, autoplay: boolean): void {
    this.#attempts = 0
    this.#failedTracks += 1
    this.#events.emit('trackfailed', { item, error })
    if (this.#failedTracks >= this.#config.maxConsecutiveFailures) {
      this.#commit({
        status: 'error',
        buffering: false,
        error: { reason: 'circuit-open', error, item },
      })
      this.#events.emit('circuitopen', { failures: this.#failedTracks })
      return
    }
    const { queue } = this.#state
    if (!hasNextQueueItem(queue)) {
      this.#commit({
        status: 'error',
        buffering: false,
        error: { reason: 'track-failed', error, item },
      })
      return
    }
    this.#changeQueue(skipToNext(queue))
    if (autoplay) void this.#load({ autoplay: true })
    else this.#commit({ status: 'paused', buffering: false })
  }

  /** Plays the current item again from the start (or just rewinds it). */
  async #restart(autoplay: boolean): Promise<void> {
    this.#seekTo(0)
    if (!autoplay) {
      if (this.#state.status === 'ended') this.#commit({ status: 'paused' })
      return
    }
    if (this.#loaded === undefined) {
      await this.#load({ autoplay: true })
      return
    }
    this.#commit({ status: 'playing', buffering: true, error: undefined })
    this.#armStallTimer()
    await this.#engine.play()
  }

  #seekTo(positionMs: number): void {
    if (this.#loaded !== undefined) this.#engine.seek(positionMs)
    this.#commit({ positionMs })
    this.#events.emit('seek', { positionMs })
  }

  // --- Timers --------------------------------------------------------------------------------

  #armStallTimer(): void {
    this.#clearStallTimer()
    const timeoutMs = this.#config.stallTimeoutMs
    if (timeoutMs <= 0) return
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = undefined
      const loaded = this.#loaded
      const item = currentQueueItem(this.#state.queue)
      if (loaded === undefined || item === undefined || !this.#wantsPlayback()) return
      this.#fail(item, new EngineError('network', `No audio for ${timeoutMs} ms`), loaded.stream)
    }, timeoutMs)
  }

  #clearStallTimer(): void {
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

  /** Starts preparing the next item once the current one is close enough to its end. */
  #maybePreload(): void {
    if (!this.#config.preload || this.#loaded === undefined) return
    const { queue, positionMs, durationMs } = this.#state
    const current = currentQueueItem(queue)
    const next = nextQueueItem(queue)
    if (queue.repeat === 'one' || current === undefined || next === undefined) return
    if (next.uid === current.uid || this.#preload?.uid === next.uid) return
    const totalMs = durationMs ?? current.track.durationMs
    if (totalMs === undefined || totalMs - positionMs > this.#config.preloadLeadMs) return
    this.#cancelPreload()
    const abort = new AbortController()
    const promise = new Promise<ResolvedStream>((resolve) => {
      resolve(this.#resolver.resolve(next, { reason: 'preload', attempt: 0, signal: abort.signal }))
    })
    const preload: Preload = { uid: next.uid, abort, promise }
    this.#preload = preload
    promise.then(
      (resolved) => {
        if (this.#preload !== preload || this.#engine.canPlay?.(resolved.stream) === false) return
        this.#engine.preload?.({ stream: resolved.stream, item: next })
      },
      () => {
        // Nothing prepared: the item resolves again when it plays.
      },
    )
    if (this.#onPreload !== undefined) callSafely(this.#onPreload, next, upcomingQueueItems(queue))
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
    if (preload.uid === currentQueueItem(queue)?.uid || preload.uid === nextQueueItem(queue)?.uid)
      return
    this.#cancelPreload()
  }

  // --- Engine events -------------------------------------------------------------------------

  #onTimeUpdate(positionMs: number): void {
    if (this.#loaded === undefined || !Number.isFinite(positionMs)) return
    this.#commit({ positionMs })
    if (this.#healthyAtMs !== undefined && positionMs >= this.#healthyAtMs) this.#markHealthy()
    this.#maybePreload()
  }

  #onDurationChange(durationMs: number): void {
    if (this.#loaded === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return
    this.#commit({ durationMs })
    this.#maybePreload()
  }

  #onPlay(): void {
    if (this.#loaded === undefined) return
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
    if (this.#stallTimer === undefined) this.#armStallTimer()
  }

  #onEnded(): void {
    if (this.#loaded === undefined) return
    this.#markHealthy()
    this.#clearStallTimer()
    const { queue } = this.#state
    if (queue.repeat === 'one') {
      void this.#restart(true)
      return
    }
    if (!hasNextQueueItem(queue)) {
      const { durationMs, positionMs } = this.#state
      this.#commit({ status: 'ended', buffering: false, positionMs: durationMs ?? positionMs })
      this.#events.emit('queueend', undefined)
      return
    }
    if (this.#changeQueue(skipToNext(queue))) void this.#load({ autoplay: true })
    else void this.#restart(true)
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
