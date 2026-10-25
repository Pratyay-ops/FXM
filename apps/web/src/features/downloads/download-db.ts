/**
 * Where the web app keeps its download records: an IndexedDB database of its own, `fxm-downloads`
 * (Dexie), apart from the library's `fxm` database. Downloads describe files on this device, so
 * they stay out of library backups; the Downloads playlist, which is in the library, holds their
 * order.
 *
 * Every tab reads and writes the same records, and Dexie tells every tab about changes, so a
 * command from any tab reaches the tab that runs the queue (see `runtime.ts`).
 *
 * @module
 */

import { type DownloadRecord, type DownloadStore, isDownloadRecord } from '@fxm/downloads'
import { Dexie, type DexieOptions, type EntityTable, liveQuery } from 'dexie'

/** The name of the downloads database. */
export const DOWNLOADS_DB_NAME = 'fxm-downloads'

/** The downloads database with its typed table. */
export type DownloadsDatabase = Dexie & {
  downloads: EntityTable<DownloadRecord, 'id'>
}

/**
 * Version 1: one table of download records, keyed by `downloadId(track)`, indexed by status and
 * queue time. To change it, add a version; never edit one that shipped.
 */
export const DOWNLOADS_SCHEMA_V1 = { downloads: 'id, status, createdAt' } as const

/** Opens (lazily, on first use) the downloads database. Tests pass another name. */
export function openDownloadsDatabase(
  name: string = DOWNLOADS_DB_NAME,
  options?: DexieOptions,
): DownloadsDatabase {
  const db = new Dexie(name, options) as DownloadsDatabase
  db.version(1).stores(DOWNLOADS_SCHEMA_V1)
  return db
}

/**
 * The records of `db` as a `DownloadStore`. Records that don't pass `isDownloadRecord` (written
 * by a newer FXM, or damaged) are ignored, and a change replaces one. `subscribe` follows a live
 * query, so it hears about changes from every tab.
 */
export function createDexieDownloadStore(db: DownloadsDatabase): DownloadStore {
  const valid = (value: unknown) => (isDownloadRecord(value) ? value : undefined)
  return {
    async get(id) {
      return valid(await db.downloads.get(id))
    },
    async list() {
      return (await db.downloads.toArray()).filter(isDownloadRecord)
    },
    update(id, change) {
      return db.transaction('rw', db.downloads, async () => {
        const current = valid(await db.downloads.get(id))
        const next = change(current)
        if (next === undefined || next === current) return current
        if (next === null) {
          await db.downloads.delete(id)
          return undefined
        }
        if (next.id !== id) throw new Error(`A change of ${id} returned the record ${next.id}`)
        await db.downloads.put(next)
        return next
      })
    },
    subscribe(listener) {
      const subscription = liveQuery(() => db.downloads.toArray()).subscribe({
        next: () => listener(),
        // The database went away (a private window, a cleared site): nothing more to hear.
        error: () => {},
      })
      return () => subscription.unsubscribe()
    },
  }
}
