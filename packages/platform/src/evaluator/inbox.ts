/**
 * Matching responses with the requests that wait for them, for ports whose channel delivers
 * answers as separate events (a `MessagePort`).
 *
 * @module
 */

import { requestIdOf } from './protocol'

/** A request waiting for its answer. */
interface Waiting {
  resolve(value: unknown): void
  reject(error: unknown): void
}

/** Requests waiting for their answers. */
export class Inbox {
  readonly #waiting = new Map<number, Waiting>()

  /** Waits for the answer to request `id`, until `signal` aborts. */
  wait(id: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const waiting: Waiting = {
        resolve(value) {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject(error) {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      const onAbort = () => {
        if (this.#waiting.get(id) !== waiting) return
        this.#waiting.delete(id)
        waiting.reject(signal?.reason)
      }
      this.#waiting.set(id, waiting)
      signal?.addEventListener('abort', onAbort, { once: true })
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
