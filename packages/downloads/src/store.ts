/**
 * Where download records live: an interface the platforms implement (IndexedDB in the web app),
 * and an in-memory store for tests and for platforms without one yet.
 *
 * @module
 */

import { type DownloadRecord, type DownloadStatus, isDownloadRecord } from './types'

/**
 * What a change to one record returns: the new record to store, the same record to leave it as
 * it is, `undefined` to leave it as it is (or absent), or `null` to delete it.
 */
export type RecordChange = DownloadRecord | null | undefined

/** What housekeeping reads about one stored row, valid or not (see {@link DownloadStore.rows}). */
export interface DownloadRow {
  /** The row's ID. */
  readonly id: string
  /**
   * The file the row names, if any: any non-empty string, also from a row that fails
   * `isDownloadRecord`.
   */
  readonly file?: string
  /** Whether the row passes `isDownloadRecord`. `get`, `list` and `update` see only those. */
  readonly valid: boolean
}

/**
 * The download records, shared by every tab of the app. The manager drives everything through
 * it: commands from any tab are record changes (pausing is setting the status to `paused`), and
 * the tab that runs the queue reacts to them, so two tabs never download the same file.
 *
 * Rows that fail `isDownloadRecord` (written by a newer FXM, or damaged) are left out of `get`
 * and `list`, reach `update`'s change as `undefined` (so a change replaces them), and show only
 * in {@link rows}.
 */
export interface DownloadStore {
  /** The record `id`, if any. */
  get(id: string): Promise<DownloadRecord | undefined>
  /**
   * Every record, in no particular order, or only the records whose status is one of
   * `statuses`. The queue reads only the records on their way, so an implementation should make
   * that read cheap (the web app's uses an index).
   */
  list(statuses?: readonly DownloadStatus[]): Promise<DownloadRecord[]>
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
   * Changes several records in one transaction, each as {@link update} would, so a command on
   * a long list (queue a playlist, remove everything) is one change for every tab. `change`
   * receives each current record and its ID; an ID given twice sees its first change. Resolves
   * with the records as stored afterwards, in the order of `ids`.
   */
  updateMany(
    ids: readonly string[],
    change: (current: DownloadRecord | undefined, id: string) => RecordChange,
  ): Promise<(DownloadRecord | undefined)[]>
  /**
   * Every stored row's ID and file name, also of rows that fail `isDownloadRecord`. For
   * housekeeping: the manager never deletes a file that any row names, and "remove all" removes
   * those rows as well.
   */
  rows(): Promise<DownloadRow[]>
  /**
   * Calls `listener` after records change in a way the queue cares about, from this tab or
   * another one: a record added or deleted, or its status changed. Changes of progress alone
   * need not call it (the web app's store doesn't), and several changes may come as one call.
   * Returns a function that stops it.
   */
  subscribe(listener: () => void): () => void
}

/** A {@link DownloadStore} in memory, plus a way to look inside it for tests. */
export interface MemoryDownloadStore extends DownloadStore {
  /** How many rows it holds, valid or not. */
  readonly size: number
  /** Every row, synchronously, oldest first, valid or not. */
  snapshot(): DownloadRecord[]
}

/** The file a stored row names, if it names one: what housekeeping must keep. */
export function fileOfRow(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const { file } = row as { file?: unknown }
  return typeof file === 'string' && file !== '' ? file : undefined
}

/**
 * A {@link DownloadStore} in memory: for tests, and for a platform until it has a persistent
 * one. It treats rows that fail `isDownloadRecord` as the web app's store does (a test may start
 * it with some). Listeners are called once per microtask, after the changes in it, for every
 * change, progress included.
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
  const valid = (value: unknown) => (isDownloadRecord(value) ? value : undefined)
  /** Applies one change; returns the record as stored afterwards. */
  const apply = (id: string, next: RecordChange, current: DownloadRecord | undefined) => {
    if (next === undefined || next === current) return current
    if (next === null) {
      if (records.delete(id)) changed()
      return undefined
    }
    if (next.id !== id) throw new Error(`A change of ${id} returned the record ${next.id}`)
    records.set(id, next)
    changed()
    return next
  }
  return {
    get size() {
      return records.size
    },
    snapshot() {
      return [...records.values()].sort((a, b) => a.createdAt - b.createdAt)
    },
    async get(id) {
      return valid(records.get(id))
    },
    async list(statuses) {
      return [...records.values()].filter(
        (record) =>
          isDownloadRecord(record) && (statuses === undefined || statuses.includes(record.status)),
      )
    },
    async update(id, change) {
      const current = valid(records.get(id))
      return apply(id, change(current), current)
    },
    async updateMany(ids, change) {
      // Every change is worked out first, so a change that throws leaves everything as it was.
      const seen = new Map<string, DownloadRecord | undefined>()
      const planned: [string, RecordChange, DownloadRecord | undefined][] = []
      const results = ids.map((id) => {
        const current = seen.has(id) ? seen.get(id) : valid(records.get(id))
        const next = change(current, id)
        if (next !== null && next !== undefined && next.id !== id) {
          throw new Error(`A change of ${id} returned the record ${next.id}`)
        }
        const after = next === undefined ? current : (next ?? undefined)
        seen.set(id, after)
        planned.push([id, next, current])
        return after
      })
      for (const [id, next, current] of planned) apply(id, next, current)
      return results
    },
    async rows() {
      return [...records.entries()].map(([id, record]) => {
        const file = fileOfRow(record)
        return file === undefined
          ? { id, valid: isDownloadRecord(record) }
          : { id, file, valid: isDownloadRecord(record) }
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
