/**
 * The scrobbler: it turns the plays the listening signals report into scrobbles, queues them
 * per service, and sends them with retries, so nothing is lost while the device is offline or a
 * service is down.
 *
 * - **Now playing.** When a play starts, each service hears about it after a short delay, so
 *   skipping through a queue doesn't flood it. Last.fm asks that failed now-playing requests
 *   are not retried, and they aren't.
 * - **Scrobbles.** When a play ends, each service whose rules it meets (half the track or 4
 *   minutes; on Last.fm, a track longer than 30 seconds) gets a scrobble at the end of its queue.
 *   Queues are sent oldest first, in batches, as both services ask.
 * - **Failures** (see `ScrobbleFailure`): a temporary one waits with exponential backoff and
 *   jitter, and a rate limit as long as the service asked; both keep the scrobbles. A refusal of
 *   FXM's credentials keeps them too, and tells the app (`onRefused`), which pauses the service
 *   until the user connects again. A request the service rejects as malformed is sent again one
 *   scrobble at a time, and only the scrobble it still rejects is dropped.
 *
 * The app decides which services are connected (`targets`) and where the queue lives (`store`).
 *
 * @module
 */

import type { PlayContext, Track } from '@fxm/core'
import { scrobbleFailureOf } from './errors'
import { qualifiesForScrobble, validLengthMs } from './rules'
import type { ScrobbleStore } from './store'
import type { ScrobbleTarget } from './target'
import { sanitizeScrobble, scrobbleOf, scrobbleTrackOf } from './track'
import type {
  Scrobble,
  ScrobbleContext,
  ScrobblePlay,
  ScrobbleServiceId,
  ScrobbleTrack,
} from './types'

/** How many scrobbles a queue keeps per service; the oldest go beyond it. */
export const MAX_QUEUED_SCROBBLES = 5000

/** Settings of a {@link Scrobbler}. */
export interface ScrobblerOptions {
  /** Where the queues live. */
  store: ScrobbleStore
  /**
   * The services connected now. Read whenever the scrobbler needs them, so connecting,
   * disconnecting or pausing a service takes effect at once.
   */
  targets: () => readonly ScrobbleTarget[]
  /** The context requests go out with: the platform's `fetch`. Read for every request. */
  context: () => ScrobbleContext
  /**
   * Called when a service refuses FXM's credentials, with the target that sent them. The app
   * should mark it paused (so `targets` returns it with `paused`) and ask the user to connect
   * again, unless its credentials changed since (see `ScrobbleTarget.account`).
   */
  onRefused?: (service: ScrobbleServiceId, error: unknown, target: ScrobbleTarget) => void
  /** Whether the device is online. Default: always. Offline, nothing is sent. */
  online?: () => boolean
  /**
   * Runs a flush exclusively among every scrobbler that shares the store, e.g. with a Web Lock
   * across tabs, so no queue entry is sent twice. Default: runs it as it is.
   */
  exclusive?: <T>(run: () => Promise<T>) => Promise<T>
  /** Most scrobbles kept per service. Default: {@link MAX_QUEUED_SCROBBLES}. */
  maxQueued?: number
  /** How long a play must be playing before "now playing" goes out. Default: 3 s. */
  nowPlayingDelayMs?: number
  /** The first wait after a temporary failure. Default: 30 s; it doubles with each failure. */
  retryBaseMs?: number
  /** The longest wait after temporary failures. Default: 1 hour. */
  retryMaxMs?: number
  /** Random numbers in `[0, 1)`, for the jitter. Default: `Math.random`. */
  random?: () => number
}

/** How sending to one service is going, in this program. */
export interface ScrobbleServiceStatus {
  /** The service. */
  service: ScrobbleServiceId
  /** Scrobbles the service accepted. */
  sent: number
  /** Scrobbles the service took but left out, e.g. Last.fm's filters. */
  ignored: number
  /** Scrobbles dropped: rejected by the service, unreadable, or over the queue's limit. */
  dropped: number
  /** When the last batch went through, as epoch milliseconds. */
  lastSentAt?: number
  /** When the next try is due after a failure, as epoch milliseconds. */
  retryAt?: number
  /** What went wrong last, until a batch goes through. Never holds a credential. */
  lastError?: string
}

/** What the scrobbler hears when a play starts. */
export interface PlayStart {
  /** The track. */
  track: Track
  /** Where the play started from. */
  context?: PlayContext
}

interface ServiceState extends ScrobbleServiceStatus {
  /** Temporary failures in a row. */
  failures: number
  /** Whether `retryAt` waits out a rate limit, which coming back online doesn't cut short. */
  rateLimited: boolean
}

/** A message for status, from any error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Turns plays into scrobbles and sends them (see the module documentation). Create one per
 * program, and close it when the program ends.
 */
export class Scrobbler {
  private readonly options: ScrobblerOptions
  private readonly maxQueued: number
  private readonly nowPlayingDelayMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly random: () => number
  private readonly states = new Map<ScrobbleServiceId, ServiceState>()
  private readonly listeners = new Set<() => void>()
  private nowPlaying: { trackId: string; timer: ReturnType<typeof setTimeout> } | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> | undefined
  private again = false
  private closed = false

  constructor(options: ScrobblerOptions) {
    this.options = options
    this.maxQueued = options.maxQueued ?? MAX_QUEUED_SCROBBLES
    this.nowPlayingDelayMs = options.nowPlayingDelayMs ?? 3000
    this.retryBaseMs = options.retryBaseMs ?? 30_000
    this.retryMaxMs = options.retryMaxMs ?? 3_600_000
    this.random = options.random ?? Math.random
  }

  /**
   * A play started: after the now-playing delay, every connected service that isn't paused or
   * waiting hears that it is playing now. A new start replaces one still waiting.
   */
  playStarted(play: PlayStart): void {
    this.cancelNowPlaying()
    if (this.closed) return
    const track = scrobbleTrackOf(play.track)
    if (track === null) return
    const timer = setTimeout(() => {
      this.nowPlaying = undefined
      this.sendNowPlaying(track)
    }, this.nowPlayingDelayMs)
    this.nowPlaying = { trackId: play.track.id, timer }
  }

  /**
   * A play ended: every connected service whose rules it meets gets its scrobble at the end of
   * its queue, then the queues are sent. Resolves once that flush is over. A now-playing
   * announcement of the same track still waiting is dropped.
   */
  async playEnded(play: ScrobblePlay): Promise<void> {
    if (this.nowPlaying?.trackId === play.track.id) this.cancelNowPlaying()
    if (this.closed) return
    const scrobble = scrobbleOf(play)
    if (scrobble === null) return
    const due = this.options.targets().filter((target) => qualifiesForScrobble(play, target.rules))
    if (due.length === 0) return
    for (const target of due) await this.enqueue(target.service, scrobble)
    this.emit()
    await this.flush()
  }

  /**
   * Sends every queue that is due: connected, not paused, not waiting after a failure, and
   * only while online. Calls during a flush run one more flush after it.
   */
  flush(): Promise<void> {
    if (this.flushing !== undefined) {
      this.again = true
      return this.flushing
    }
    const run = async () => {
      do {
        this.again = false
        const exclusive = this.options.exclusive ?? ((task) => task())
        await exclusive(() => this.flushOnce())
      } while (this.again && !this.closed)
    }
    this.flushing = run().finally(() => {
      this.flushing = undefined
      this.scheduleRetry()
    })
    return this.flushing
  }

  /**
   * Tries again now, e.g. when the device comes back online: ends the waits after temporary
   * failures (not those a service asked for), then flushes.
   */
  retryNow(): Promise<void> {
    for (const state of this.states.values()) {
      if (!state.rateLimited) delete state.retryAt
    }
    this.emit()
    return this.flush()
  }

  /** Empties `service`'s queue and forgets how sending to it went, e.g. on disconnecting. */
  async forget(service: ScrobbleServiceId): Promise<void> {
    this.states.delete(service)
    await this.options.store.clear(service)
    this.emit()
  }

  /** How many scrobbles wait in `service`'s queue. */
  pending(service: ScrobbleServiceId): Promise<number> {
    return this.options.store.count(service)
  }

  /** How sending to `service` is going. */
  status(service: ScrobbleServiceId): ScrobbleServiceStatus {
    const { failures: _failures, rateLimited: _rateLimited, ...status } = this.stateOf(service)
    return status
  }

  /** Calls `listener` whenever a status or a queue changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Stops: no more requests start, and the timers are cleared. */
  close(): void {
    this.closed = true
    this.cancelNowPlaying()
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.listeners.clear()
  }

  private stateOf(service: ScrobbleServiceId): ServiceState {
    let state = this.states.get(service)
    if (state === undefined) {
      state = { service, sent: 0, ignored: 0, dropped: 0, failures: 0, rateLimited: false }
      this.states.set(service, state)
    }
    return state
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A listener's failure is its own business.
      }
    }
  }

  private online(): boolean {
    return this.options.online?.() ?? true
  }

  /** Whether `state` is still waiting after a failure. */
  private waiting(state: ServiceState): boolean {
    return state.retryAt !== undefined && state.retryAt > Date.now()
  }

  private cancelNowPlaying(): void {
    if (this.nowPlaying !== undefined) clearTimeout(this.nowPlaying.timer)
    this.nowPlaying = undefined
  }

  private sendNowPlaying(track: ScrobbleTrack): void {
    if (this.closed || !this.online()) return
    const length = validLengthMs(track.durationMs)
    for (const target of this.options.targets()) {
      if (target.paused || this.waiting(this.stateOf(target.service))) continue
      if (length !== undefined && length <= target.rules.minTrackMs) continue
      target
        .nowPlaying(track, this.options.context())
        .catch((error: unknown) => this.nowPlayingFailed(target, error))
    }
  }

  /** A failed now-playing request is never retried, but a refusal or a rate limit still counts. */
  private nowPlayingFailed(target: ScrobbleTarget, error: unknown): void {
    const failure = scrobbleFailureOf(error)
    const state = this.stateOf(target.service)
    if (failure === 'refused') {
      state.lastError = messageOf(error)
      this.emit()
      this.options.onRefused?.(target.service, error, target)
    } else if (failure === 'rate-limited') {
      this.wait(state, error, true)
      this.emit()
      this.scheduleRetry()
    }
  }

  private async enqueue(service: ScrobbleServiceId, scrobble: Scrobble): Promise<void> {
    const dropped = await this.options.store.add(service, [scrobble], this.maxQueued)
    if (dropped > 0) this.stateOf(service).dropped += dropped
  }

  private async flushOnce(): Promise<void> {
    for (const target of this.options.targets()) {
      if (this.closed || !this.online()) return
      const state = this.stateOf(target.service)
      if (target.paused || this.waiting(state)) continue
      try {
        await this.drain(target, state)
      } catch (error) {
        // The store failed (storage blocked or full): try again later, like any failure.
        this.wait(state, error, false)
        this.emit()
      }
    }
  }

  /** Up to `limit` readable entries from the front of a queue; unreadable ones are dropped. */
  private async peek(
    service: ScrobbleServiceId,
    limit: number,
    state: ServiceState,
  ): Promise<{ id: number; scrobble: Scrobble }[]> {
    for (;;) {
      const entries = await this.options.store.peek(service, limit)
      const valid: { id: number; scrobble: Scrobble }[] = []
      const invalid: number[] = []
      for (const entry of entries) {
        const scrobble = sanitizeScrobble(entry.scrobble)
        if (scrobble === null) invalid.push(entry.id)
        else valid.push({ id: entry.id, scrobble })
      }
      if (invalid.length > 0) {
        await this.options.store.remove(invalid)
        state.dropped += invalid.length
      }
      // When every entry was unreadable, the next ones may not be.
      if (valid.length > 0 || invalid.length === 0) return valid
    }
  }

  /** Sends one service's queue until it is empty or a request fails. */
  private async drain(target: ScrobbleTarget, state: ServiceState): Promise<void> {
    // After a rejected batch, how many scrobbles go one at a time to find the bad one.
    let isolating = 0
    while (!this.closed && this.online()) {
      const entries = await this.peek(target.service, isolating > 0 ? 1 : target.batchSize, state)
      if (entries.length === 0) return
      let report: Awaited<ReturnType<ScrobbleTarget['submit']>>
      try {
        report = await target.submit(
          entries.map((entry) => entry.scrobble),
          this.options.context(),
        )
      } catch (error) {
        const failure = scrobbleFailureOf(error)
        state.lastError = messageOf(error)
        if (failure === 'rejected') {
          if (entries.length > 1) {
            isolating = entries.length
          } else {
            await this.options.store.remove(entries.map((entry) => entry.id))
            state.dropped += 1
            if (isolating > 0) isolating--
          }
          this.emit()
          continue
        }
        if (failure === 'refused') {
          this.emit()
          this.options.onRefused?.(target.service, error, target)
          return
        }
        this.wait(state, error, failure === 'rate-limited')
        this.emit()
        return
      }
      await this.options.store.remove(entries.map((entry) => entry.id))
      state.sent += report.accepted
      state.ignored += report.ignored
      state.lastSentAt = Date.now()
      state.failures = 0
      state.rateLimited = false
      delete state.retryAt
      delete state.lastError
      if (isolating > 0) isolating--
      this.emit()
    }
  }

  /**
   * Sets when `state`'s service is tried next: as long as a rate limit asked, else after an
   * exponential backoff with up to 30 % jitter.
   */
  private wait(state: ServiceState, error: unknown, rateLimited: boolean): void {
    const asked = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
    let delayMs: number
    if (rateLimited && typeof asked === 'number' && Number.isFinite(asked) && asked >= 0) {
      delayMs = asked
    } else {
      state.failures++
      const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (state.failures - 1))
      delayMs = Math.round(backoff * (1 + this.random() * 0.3))
    }
    state.rateLimited = rateLimited
    state.retryAt = Date.now() + delayMs
    state.lastError = messageOf(error)
  }

  /** Arms one timer for the earliest wait still to end, which flushes again. */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.closed) return
    const now = Date.now()
    const due = [...this.states.values()]
      .map((state) => state.retryAt)
      .filter((at): at is number => at !== undefined && at > now)
    if (due.length === 0) return
    const delayMs = Math.min(...due) - now
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.flush()
    }, delayMs)
  }
}
