/**
 * Where the offline queue keeps scrobbles until their service takes them: one first-in,
 * first-out queue per service. The web app keeps it in IndexedDB, so it survives restarts as
 * Last.fm asks; tests and platforms without storage use {@link createMemoryScrobbleStore}.
 *
 * @module
 */

import type { Scrobble, ScrobbleServiceId } from './types'

/** One entry of a queue, as read back from storage. */
export interface StoredScrobble {
  /** The entry's ID. IDs grow in the order entries joined their queue. */
  id: number
  /**
   * Whose profile it was queued for (`ScrobbleTarget.user`), when it was queued for someone.
   * The scrobbler sends it to that user only.
   */
  user?: string
  /**
   * The scrobble as it was stored. Storage may hold anything (an older version, another tab, a
   * bad disk wrote it), so the scrobbler checks it with `sanitizeScrobble` before sending.
   */
  scrobble: unknown
}

/**
 * A queue store. Every method is atomic, so two tabs that share one store never lose or
 * duplicate entries between them.
 */
export interface ScrobbleStore {
  /**
   * Appends `scrobbles` to the end of `service`'s queue, queued for `user` when given (each
   * entry keeps it), then drops the queue's oldest entries beyond `max`. Resolves with how many
   * it dropped.
   */
  add(
    service: ScrobbleServiceId,
    scrobbles: readonly Scrobble[],
    max: number,
    user?: string,
  ): Promise<number>
  /** Up to `limit` entries from the front of `service`'s queue, oldest first, with their user. */
  peek(service: ScrobbleServiceId, limit: number): Promise<StoredScrobble[]>
  /** Removes entries by ID; IDs that are gone already are skipped. */
  remove(ids: readonly number[]): Promise<void>
  /** How many entries `service`'s queue holds. */
  count(service: ScrobbleServiceId): Promise<number>
  /** Empties `service`'s queue. */
  clear(service: ScrobbleServiceId): Promise<void>
}

/** A queue store in memory, which forgets everything when the program ends. */
export function createMemoryScrobbleStore(): ScrobbleStore {
  const queues = new Map<ScrobbleServiceId, StoredScrobble[]>()
  let lastId = 0
  const queueOf = (service: ScrobbleServiceId): StoredScrobble[] => {
    let queue = queues.get(service)
    if (queue === undefined) {
      queue = []
      queues.set(service, queue)
    }
    return queue
  }
  return {
    async add(service, scrobbles, max, user) {
      const queue = queueOf(service)
      for (const scrobble of scrobbles) {
        const entry: StoredScrobble = { id: ++lastId, scrobble: structuredClone(scrobble) }
        if (user !== undefined) entry.user = user
        queue.push(entry)
      }
      const dropped = Math.max(0, queue.length - Math.max(0, max))
      queue.splice(0, dropped)
      return dropped
    },
    async peek(service, limit) {
      return queueOf(service)
        .slice(0, Math.max(0, limit))
        .map((entry) => ({ ...entry, scrobble: structuredClone(entry.scrobble) }))
    },
    async remove(ids) {
      const gone = new Set(ids)
      for (const [service, queue] of queues) {
        queues.set(
          service,
          queue.filter((entry) => !gone.has(entry.id)),
        )
      }
    },
    async count(service) {
      return queueOf(service).length
    },
    async clear(service) {
      queues.delete(service)
    },
  }
}
