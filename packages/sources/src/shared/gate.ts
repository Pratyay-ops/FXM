/**
 * Pacing for one service: requests go one at a time, higher priorities first, with a pause
 * between them, at most a number of them in a rolling window, and none while the service has
 * asked FXM to wait. A call waits for its turn at most `maxWaitMs` in all, counted from when it
 * was made, and then fails with `RateLimited`.
 *
 * @module
 */

import { rateLimited } from './http'

/**
 * What a request is for, highest priority first, in the words of the platform's request budget
 * (stage 1.2), so that a caller can pass its own through:
 *
 * - `current-track`: the track that is playing or about to play
 * - `prefetch`: the next tracks in the queue
 * - `interactive`: search, pages and anything else the user opened (the default)
 * - `bulk`: background work nobody waits for, such as filling the artwork of a list
 */
export type RequestPriority = 'current-track' | 'prefetch' | 'interactive' | 'bulk'

/** Every {@link RequestPriority}, highest first. */
export const REQUEST_PRIORITIES: readonly RequestPriority[] = [
  'current-track',
  'prefetch',
  'interactive',
  'bulk',
]

/** What a paced client's calls take besides their own arguments. */
export interface PacedCallOptions {
  /**
   * What the call is for: it waits behind every call of a higher priority. Default
   * `interactive`; pass `bulk` for background work, so that it never holds up what the user is
   * waiting for.
   */
  priority?: RequestPriority | undefined
}

/** How a {@link RequestGate} paces its service. */
export interface GateOptions {
  /** The service's name, for error messages. */
  service: string
  /** Pause this many milliseconds between the end of one request and the start of the next. */
  minIntervalMs: number
  /** At most `max` requests start in any `ms` milliseconds, e.g. 20 a minute for iTunes. */
  window?: { max: number; ms: number }
  /**
   * The longest a call waits for its turn, in milliseconds, counted from when it was made: for
   * the calls ahead of it and for the pacing. A call whose turn would come later fails with
   * `RateLimited`, at once when the pacing alone says so, whose `retryAfterMs` says when to try
   * again.
   */
  maxWaitMs: number
  /** Random numbers from 0 to 1 for the back-off's jitter. Default `Math.random`. */
  random?: () => number
}

/** Options for one {@link RequestGate.run}. */
export interface GateRunOptions extends PacedCallOptions {
  /** Cancels the call: it leaves the queue, or its wait for the pacing, at once. */
  signal?: AbortSignal | undefined
}

/**
 * Called by a task when it is about to send its request: waits for the pacing (the pause, the
 * window and any back-off). A task that answers without a request, e.g. from a cache, never calls
 * it and takes nothing from the pacing.
 */
export type Ready = () => Promise<void>

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The place of `priority` in {@link REQUEST_PRIORITIES}; an unknown one counts as `interactive`. */
function rankOf(priority: RequestPriority | undefined): number {
  const rank = REQUEST_PRIORITIES.indexOf(priority ?? 'interactive')
  return rank === -1 ? REQUEST_PRIORITIES.indexOf('interactive') : rank
}

/** A call waiting for the gate. */
interface Waiter {
  /** Its priority's place in {@link REQUEST_PRIORITIES}: lower goes first. */
  rank: number
  /** Hands it the gate. */
  wake(): void
}

/**
 * Runs the requests of one client one at a time, higher priorities first and in the order the
 * calls came within a priority, and paces them (see {@link GateOptions}). A cancelled call
 * leaves the queue.
 */
export class RequestGate {
  private busy = false
  private readonly waiting: Waiter[] = []
  /** When the last request finished, in epoch milliseconds. */
  private lastEndAt = Number.NEGATIVE_INFINITY
  /** When the requests of the current window started. */
  private readonly starts: number[] = []
  /** No request starts before this time, which a back-off set. */
  private retryAt = 0
  /** Until this time calls fail at once, which a back-off with `block` set. */
  private blockedUntil = 0
  private readonly random: () => number

  constructor(private readonly options: GateOptions) {
    this.random = options.random ?? Math.random
  }

  /**
   * Runs `task` in its turn and holds the gate until it settles. The task calls `ready` right
   * before it sends its request (see {@link Ready}). Rejects with `RateLimited` when the turn
   * would come more than `maxWaitMs` after the call, and with the signal's reason when it is
   * cancelled.
   */
  async run<T>(task: (ready: Ready) => Promise<T>, options: GateRunOptions = {}): Promise<T> {
    const { signal } = options
    signal?.throwIfAborted()
    this.checkBlocked()
    const deadline = Date.now() + Math.max(0, this.options.maxWaitMs)
    await this.acquire(signal, rankOf(options.priority), deadline)
    let sent = false
    try {
      return await task(async () => {
        await this.waitTurn(signal, deadline)
        sent = true
        if (this.options.window !== undefined) this.starts.push(Date.now())
      })
    } finally {
      if (sent) this.lastEndAt = Date.now()
      this.release()
    }
  }

  /**
   * Holds every request back for `delayMs`, plus up to 30 % jitter so that clients do not all
   * come back at once. With `block`, calls fail at once until then instead of waiting. Returns
   * how long requests are now held back.
   */
  backOff(delayMs: number, block: boolean): number {
    const now = Date.now()
    const until = now + Math.round(delayMs * (1 + this.random() * 0.3))
    this.retryAt = Math.max(this.retryAt, until)
    if (block) this.blockedUntil = Math.max(this.blockedUntil, until)
    return this.retryAt - now
  }

  /** When the pacing lets the next request start: the pause, the window and any back-off. */
  private nextStartAt(now: number): number {
    const { window } = this.options
    let at = Math.max(this.lastEndAt + this.options.minIntervalMs, this.retryAt)
    if (window !== undefined) {
      while (this.starts.length > 0 && (this.starts[0] ?? 0) <= now - window.ms) this.starts.shift()
      const oldest = this.starts[this.starts.length - window.max]
      if (this.starts.length >= window.max && oldest !== undefined) {
        at = Math.max(at, oldest + window.ms)
      }
    }
    return at
  }

  /** Waits for the pacing, or fails when it would end after the call's deadline. */
  private async waitTurn(signal: AbortSignal | undefined, deadline: number): Promise<void> {
    this.checkBlocked()
    const now = Date.now()
    const at = this.nextStartAt(now)
    if (at > deadline) throw rateLimited(this.options.service, at - now)
    if (at > now) await sleep(at - now, signal)
  }

  /** Fails while a back-off blocks calls. */
  private checkBlocked(): void {
    const waitMs = this.blockedUntil - Date.now()
    if (waitMs > 0) throw rateLimited(this.options.service, waitMs)
  }

  /**
   * Takes the gate, after the calls of the same or a higher priority already waiting for it.
   * A call still waiting at its deadline leaves the queue and fails with `RateLimited`.
   */
  private acquire(signal: AbortSignal | undefined, rank: number, deadline: number): Promise<void> {
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const leave = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiting.indexOf(waiter)
        if (index !== -1) this.waiting.splice(index, 1)
      }
      const onAbort = () => {
        leave()
        reject(signal?.reason)
      }
      const waiter: Waiter = {
        rank,
        wake: () => {
          leave()
          resolve()
        },
      }
      const after = this.waiting.findIndex((other) => other.rank > rank)
      this.waiting.splice(after === -1 ? this.waiting.length : after, 0, waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => {
          leave()
          // The calls ahead of it took the time; the pacing's next start is the best estimate.
          const now = Date.now()
          const retryMs = Math.max(this.nextStartAt(now) - now, this.options.minIntervalMs, 1_000)
          reject(rateLimited(this.options.service, retryMs))
        },
        Math.max(0, deadline - Date.now()),
      )
    })
  }

  /** Hands the gate to the next waiting call, or frees it. */
  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) this.busy = false
    else next.wake()
  }
}
