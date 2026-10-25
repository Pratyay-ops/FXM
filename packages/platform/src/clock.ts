/**
 * Time and timers, injected so that tests can run on a fake clock (see `createFakeClock` in
 * `@fxm/platform/testing`).
 *
 * @module
 */

/** The current time and one-shot timers. */
export interface Clock {
  /** The current time, in epoch milliseconds. */
  now(): number
  /** Calls `callback` once after `delayMs` milliseconds. Returns a handle for `clearTimeout`. */
  setTimeout(callback: () => void, delayMs: number): unknown
  /** Cancels a timer from `setTimeout`. Unknown or finished handles are ignored. */
  clearTimeout(handle: unknown): void
}

/**
 * The real clock: `Date.now` and the global timers. It looks them up on every call, so test
 * frameworks that replace the globals (such as Vitest's fake timers) take effect.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number | undefined),
}
