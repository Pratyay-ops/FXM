/**
 * A fake {@link Clock} for tests: time stands still until the test moves it, and timers run in
 * order as it does. It leaves the global timers alone, so it works next to libraries that keep
 * using real ones (such as happy-dom's `postMessage`).
 *
 * @module
 */

import type { Clock } from '../clock'

/** A {@link Clock} whose time the test controls. */
export interface FakeClock extends Clock {
  /** Timers that have not run yet. */
  readonly pendingTimers: number
  /** Moves time forward by `ms`, running every timer that falls due, in order. */
  advance(ms: number): void
  /**
   * Like `advance`, but lets pending promise callbacks run before the first timer and after each
   * one, so that code reacting to a timer (and setting new ones) runs as it would for real.
   */
  advanceAsync(ms: number): Promise<void>
}

interface Timer {
  readonly id: number
  readonly at: number
  readonly callback: () => void
}

/** Runs every queued promise callback, using a real macrotask. */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
      .setImmediate
    if (typeof immediate === 'function') immediate(resolve)
    else globalThis.setTimeout(resolve, 0)
  })
}

/** Creates a fake clock starting at `start` epoch milliseconds. */
export function createFakeClock(start = 0): FakeClock {
  let now = start
  let nextId = 1
  const timers = new Map<number, Timer>()

  /** The timer due first (in creation order among equals), if any is due by `limit`. */
  function due(limit: number): Timer | undefined {
    let first: Timer | undefined
    for (const timer of timers.values()) {
      if (timer.at <= limit && (first === undefined || timer.at < first.at)) first = timer
    }
    return first
  }

  function runDue(target: number): boolean {
    const timer = due(target)
    if (timer === undefined) return false
    timers.delete(timer.id)
    now = Math.max(now, timer.at)
    timer.callback()
    return true
  }

  return {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = nextId
      nextId += 1
      timers.set(id, { id, at: now + Math.max(0, delayMs), callback })
      return id
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') timers.delete(handle)
    },
    get pendingTimers() {
      return timers.size
    },
    advance(ms) {
      const target = now + ms
      while (runDue(target)) {
        // Keep going until nothing more is due.
      }
      now = target
    },
    async advanceAsync(ms) {
      const target = now + ms
      await flushPromises()
      while (runDue(target)) await flushPromises()
      now = target
    },
  }
}
