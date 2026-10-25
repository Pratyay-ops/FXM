/**
 * Matching responses with the requests that wait for them, for ports whose channel delivers
 * answers as separate events (`postMessage`).
 *
 * @module
 */

import { requestIdOf } from './protocol'

/** How long an unanswered request is remembered, in milliseconds; a longer wait has timed out. */
const FORGET_AFTER_MS = 5 * 60_000

/** Requests waiting for their answers. */
export class Inbox {
  readonly #waiting = new Map<
    number,
    { readonly since: number; resolve(value: unknown): void; reject(error: unknown): void }
  >()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Waits for the answer to request `id`. */
  wait(id: number): Promise<unknown> {
    const now = this.#now()
    for (const [key, entry] of this.#waiting) {
      if (now - entry.since > FORGET_AFTER_MS) this.#waiting.delete(key)
    }
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { since: now, resolve, reject })
    })
  }

  /** Hands a message to the request it answers, if one waits for it. */
  deliver(message: unknown): void {
    const id = requestIdOf(message)
    if (id === undefined) return
    const entry = this.#waiting.get(id)
    if (entry === undefined) return
    this.#waiting.delete(id)
    entry.resolve(message)
  }

  /** Rejects every waiting request with `error`. */
  rejectAll(error: unknown): void {
    const entries = [...this.#waiting.values()]
    this.#waiting.clear()
    for (const entry of entries) entry.reject(error)
  }
}
