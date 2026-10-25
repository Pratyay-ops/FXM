/**
 * Sliding-window rate limiter: at most `max` acquisitions in any `windowMs` window. Its state
 * is a list of timestamps, so the background can keep it in `storage.session` and survive the
 * service worker being stopped between requests.
 */
export class RateLimiter {
  readonly max: number
  readonly windowMs: number
  #times: number[] = []

  constructor(max: number, windowMs: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`max must be a positive integer: ${max}`)
    if (!(windowMs > 0)) throw new Error(`windowMs must be positive: ${windowMs}`)
    this.max = max
    this.windowMs = windowMs
  }

  /** Drops timestamps outside the window, including any from the future (a changed clock). */
  #prune(now: number): void {
    this.#times = this.#times.filter((time) => time <= now && now - time < this.windowMs)
  }

  /** Takes a slot if one is free and reports whether it did. */
  tryAcquire(now: number): boolean {
    this.#prune(now)
    if (this.#times.length >= this.max) return false
    this.#times.push(now)
    return true
  }

  /** Milliseconds until a slot frees up (0 when one is free now). */
  retryAfter(now: number): number {
    this.#prune(now)
    if (this.#times.length < this.max) return 0
    const oldest = this.#times[this.#times.length - this.max] ?? now
    return oldest + this.windowMs - now
  }

  /** The timestamps to persist. */
  snapshot(): number[] {
    return [...this.#times]
  }

  /** Restores persisted timestamps, ignoring anything that is not a finite number. */
  restore(times: readonly unknown[]): void {
    const valid = times.filter((time): time is number => Number.isFinite(time))
    this.#times = valid.sort((a, b) => a - b).slice(-this.max)
  }
}
