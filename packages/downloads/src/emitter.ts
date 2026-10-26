/**
 * A minimal typed event emitter, like the player's.
 *
 * @module
 */

/** A listener for one event type, receiving the event's payload. */
export type Listener<T> = (payload: T) => void

/**
 * Typed events: `M` maps each event type to its payload. Listeners run synchronously in the
 * order they were added; one that throws is reported and doesn't stop the others, so a faulty
 * listener can't break the queue.
 */
export class Emitter<M> {
  readonly #listeners = new Map<keyof M, Set<Listener<never>>>()

  /** Adds `listener` for `type`. Returns a function that removes it again. */
  on<K extends keyof M>(type: K, listener: Listener<M[K]>): () => void {
    let listeners = this.#listeners.get(type)
    if (listeners === undefined) {
      listeners = new Set()
      this.#listeners.set(type, listeners)
    }
    const entry = listener as Listener<never>
    listeners.add(entry)
    return () => {
      listeners.delete(entry)
    }
  }

  /** Calls every listener for `type` with `payload`. */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const listeners = this.#listeners.get(type)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        ;(listener as Listener<M[K]>)(payload)
      } catch (error) {
        console.error(error)
      }
    }
  }

  /** Removes every listener. */
  clear(): void {
    this.#listeners.clear()
  }
}
