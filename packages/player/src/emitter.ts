/**
 * A minimal typed event emitter, shared by the engines and the player facade.
 *
 * @module
 */

/** A listener for one event type, receiving the event's payload. */
export type Listener<T> = (payload: T) => void

/**
 * Calls `listener` and reports, instead of throwing, an error it raises, so one faulty listener
 * can't break the caller's own state handling or stop the other listeners.
 */
export function callSafely<A extends unknown[]>(listener: (...args: A) => void, ...args: A): void {
  try {
    listener(...args)
  } catch (error) {
    console.error(error)
  }
}

/**
 * Typed events: `M` maps each event type to its payload (`undefined` for events that carry
 * none). Listeners run synchronously in the order they were added.
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
    for (const listener of [...listeners]) callSafely(listener as Listener<M[K]>, payload)
  }

  /** Removes every listener. */
  clear(): void {
    this.#listeners.clear()
  }
}
