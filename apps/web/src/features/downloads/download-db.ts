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

import {
  type DownloadRecord,
  type DownloadStatus,
  type DownloadStore,
  fileOfRow,
  isDownloadRecord,
  type RecordChange,
} from '@fxm/downloads'
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

/** The statuses of downloads on their way or on their way out: every status but `completed`. */
export const UNFINISHED_STATUSES: readonly DownloadStatus[] = [
  'queued',
  'downloading',
  'paused',
  'failed',
  'removing',
]

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
 * Which downloads are unfinished and where each stands, as one string (`id` and status per
 * line), read from the status index alone: no record is read or checked, so it stays cheap
 * however many downloads are completed.
 */
async function queueSignature(db: DownloadsDatabase): Promise<string> {
  const lines: string[] = []
  await db.downloads
    .where('status')
    .anyOf([...UNFINISHED_STATUSES])
    .eachKey((status, cursor) => {
      lines.push(`${String(cursor.primaryKey)}\t${String(status)}`)
    })
  return lines.sort().join('\n')
}

/**
 * The records of `db` as a `DownloadStore`. Records that don't pass `isDownloadRecord` (written
 * by a newer FXM, or damaged) are ignored, and a change replaces one; `rows` lists them too.
 * `list` with statuses reads through the status index. `subscribe` follows a live query of the
 * status index, so it hears about changes from every tab, and only those the queue cares about:
 * downloads added, deleted, or moved to another status, never a progress save.
 */
export function createDexieDownloadStore(db: DownloadsDatabase): DownloadStore {
  const valid = (value: unknown) => (isDownloadRecord(value) ? value : undefined)
  return {
    async get(id) {
      return valid(await db.downloads.get(id))
    },
    async list(statuses) {
      const rows =
        statuses === undefined
          ? await db.downloads.toArray()
          : statuses.length === 0
            ? []
            : await db.downloads
                .where('status')
                .anyOf([...statuses])
                .toArray()
      return rows.filter(isDownloadRecord)
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
    updateMany(ids, change) {
      return db.transaction('rw', db.downloads, async () => {
        const unique = [...new Set(ids)]
        const stored = await db.downloads.bulkGet(unique)
        const latest = new Map<string, DownloadRecord | undefined>()
        for (const [index, id] of unique.entries()) latest.set(id, valid(stored[index]))
        const changed = new Map<string, RecordChange>()
        const results = ids.map((id) => {
          const current = latest.get(id)
          const next = change(current, id)
          if (next === undefined || next === current) return current
          if (next !== null && next.id !== id) {
            throw new Error(`A change of ${id} returned the record ${next.id}`)
          }
          changed.set(id, next)
          const after = next ?? undefined
          latest.set(id, after)
          return after
        })
        const puts: DownloadRecord[] = []
        const deletes: string[] = []
        for (const [id, next] of changed) {
          if (next === null) deletes.push(id)
          else if (next !== undefined) puts.push(next)
        }
        if (puts.length > 0) await db.downloads.bulkPut(puts)
        if (deletes.length > 0) await db.downloads.bulkDelete(deletes)
        return results
      })
    },
    async rows() {
      const rows: { id: string; file?: string; valid: boolean }[] = []
      for (const row of (await db.downloads.toArray()) as unknown[]) {
        const id = (row as { id?: unknown }).id
        if (typeof id !== 'string') continue
        const file = fileOfRow(row)
        rows.push(
          file === undefined
            ? { id, valid: isDownloadRecord(row) }
            : { id, file, valid: isDownloadRecord(row) },
        )
      }
      return rows
    },
    subscribe(listener) {
      let last: string | undefined
      const subscription = liveQuery(() => queueSignature(db)).subscribe({
        next: (signature) => {
          if (signature === last) return
          last = signature
          listener()
        },
        // The database went away (a private window, a cleared site): nothing more to hear.
        error: () => {},
      })
      return () => subscription.unsubscribe()
    },
  }
}
