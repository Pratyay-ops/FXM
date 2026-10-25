/**
 * Where download records live: an interface the platforms implement (IndexedDB in the web app),
 * and an in-memory store for tests and for platforms without one yet.
 *
 * @module
 */

import type { DownloadRecord } from './types'

/**
 * What a change to one record returns: the new record to store, the same record to leave it as
 * it is, `undefined` to leave it as it is (or absent), or `null` to delete it.
 */
export type RecordChange = DownloadRecord | null | undefined

/**
 * The download records, shared by every tab of the app. The manager drives everything through
 * it: commands from any tab are record changes (pausing is setting the status to `paused`), and
 * the tab that runs the queue reacts to them, so two tabs never download the same file.
 */
export interface DownloadStore {
  /** The record `id`, if any. */
  get(id: string): Promise<DownloadRecord | undefined>
  /** Every record, in no particular order. */
  list(): Promise<DownloadRecord[]>
  /**
   * Changes record `id` atomically: `change` receives the current record (or `undefined`) and
   * returns what to store (see {@link RecordChange}). It must be synchronous, because it runs
   * inside the storage's transaction. Resolves with the record as stored afterwards, `undefined`
   * when there is none.
   */
  update(
    id: string,
    change: (current: DownloadRecord | undefined) => RecordChange,
  ): Promise<DownloadRecord | undefined>
  /**
   * Calls `listener` after records change, from this tab or another one. Several changes may
   * come as one call. Returns a function that stops it.
   */
  subscribe(listener: () => void): () => void
}

/** A {@link DownloadStore} in memory, plus a way to look inside it for tests. */
export interface MemoryDownloadStore extends DownloadStore {
  /** How many records it holds. */
  readonly size: number
  /** Every record, synchronously, oldest first. */
  snapshot(): DownloadRecord[]
}

/**
 * A {@link DownloadStore} in memory: for tests, and for a platform until it has a persistent
 * one. Listeners are called once per microtask, after the changes in it.
 */
export function createMemoryDownloadStore(
  initial: readonly DownloadRecord[] = [],
): MemoryDownloadStore {
  const records = new Map<string, DownloadRecord>(initial.map((record) => [record.id, record]))
  const listeners = new Set<() => void>()
  let notifying = false
  const changed = () => {
    if (notifying) return
    notifying = true
    queueMicrotask(() => {
      notifying = false
      for (const listener of [...listeners]) listener()
    })
  }
  return {
    get size() {
      return records.size
    },
    snapshot() {
      return [...records.values()].sort((a, b) => a.createdAt - b.createdAt)
    },
    async get(id) {
      return records.get(id)
    },
    async list() {
      return [...records.values()]
    },
    async update(id, change) {
      const current = records.get(id)
      const next = change(current)
      if (next === undefined || next === current) return current
      if (next === null) {
        if (records.delete(id)) changed()
        return undefined
      }
      if (next.id !== id) throw new Error(`A change of ${id} returned the record ${next.id}`)
      records.set(id, next)
      changed()
      return next
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
