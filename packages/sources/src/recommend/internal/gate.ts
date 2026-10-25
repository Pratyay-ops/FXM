/**
 * Pacing for one service: requests go one at a time, with a pause between them, at most a
 * number of them in a rolling window, and none while the service has asked FXM to wait.
 *
 * @module
 */

import { rateLimited } from './http'

/** How a {@link RequestGate} paces its service. */
export interface GateOptions {
  /** The service's name, for error messages. */
  service: string
  /** Pause this many milliseconds between the end of one request and the start of the next. */
  minIntervalMs: number
  /** At most `max` requests start in any `ms` milliseconds, e.g. 20 a minute for iTunes. */
  window?: { max: number; ms: number }
  /**
   * The longest a call waits for the pacing. When its turn would come later, it fails at once
   * with `RateLimited`, whose `retryAfterMs` says when to try again.
   */
  maxWaitMs: number
  /** Random numbers from 0 to 1 for the back-off's jitter. Default `Math.random`. */
  random?: () => number
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

/**
 * Runs the requests of one client one at a time, in the order the calls arrive, and paces them
 * (see {@link GateOptions}). A cancelled call leaves the queue.
 */
export class RequestGate {
  private busy = false
  private readonly waiting: Array<() => void> = []
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
   * before it sends its request (see {@link Ready}).
   */
  async run<T>(signal: AbortSignal | undefined, task: (ready: Ready) => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    this.checkBlocked()
    await this.acquire(signal)
    let sent = false
    try {
      return await task(async () => {
        await this.waitTurn(signal)
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

  /** Waits for the pause after the last request, a free slot in the window and any back-off. */
  private async waitTurn(signal: AbortSignal | undefined): Promise<void> {
    this.checkBlocked()
    const now = Date.now()
    const { window } = this.options
    let at = Math.max(this.lastEndAt + this.options.minIntervalMs, this.retryAt)
    if (window !== undefined) {
      while (this.starts.length > 0 && (this.starts[0] ?? 0) <= now - window.ms) this.starts.shift()
      const oldest = this.starts[this.starts.length - window.max]
      if (this.starts.length >= window.max && oldest !== undefined) {
        at = Math.max(at, oldest + window.ms)
      }
    }
    const waitMs = at - now
    if (waitMs > this.options.maxWaitMs) throw rateLimited(this.options.service, waitMs)
    if (waitMs > 0) await sleep(waitMs, signal)
  }

  /** Fails while a back-off blocks calls. */
  private checkBlocked(): void {
    const waitMs = this.blockedUntil - Date.now()
    if (waitMs > 0) throw rateLimited(this.options.service, waitMs)
  }

  /** Takes the gate, after the calls already waiting for it. */
  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(wake)
        if (index !== -1) this.waiting.splice(index, 1)
        reject(signal?.reason)
      }
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      this.waiting.push(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Hands the gate to the next waiting call, or frees it. */
  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) this.busy = false
    else next()
  }
}
