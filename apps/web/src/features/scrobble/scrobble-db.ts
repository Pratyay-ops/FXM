/**
 * The scrobble queue on disk: an IndexedDB database of its own, `fxm-scrobble`, apart from the
 * library's `fxm`. So the library's schema never changes for it, and library backups never
 * carry it: a queue only means something on the device that played.
 *
 * It survives restarts, as Last.fm asks of a scrobble cache, and every tab shares it. Each
 * store method is one IndexedDB transaction, so tabs never lose or duplicate entries.
 *
 * @module
 */

import type { Scrobble, ScrobbleServiceId, ScrobbleStore } from '@fxm/sources/scrobble'
import { Dexie, type EntityTable } from 'dexie'

/** The database's name. */
export const SCROBBLE_DB_NAME = 'fxm-scrobble'

/** One queued scrobble. */
export interface QueueRecord {
  /** Auto-increments, so IDs grow in the order scrobbles joined the queue. */
  id: number
  /** The service whose queue it is in. */
  service: ScrobbleServiceId
  /** Whose profile it was queued for: the user's name on the service. */
  user?: string
  /** The scrobble. */
  scrobble: Scrobble
}

/** The scrobble database with its typed table. */
export type ScrobbleDatabase = Dexie & { queue: EntityTable<QueueRecord, 'id'> }

/**
 * Version 1: one table. The compound index orders each service's queue by ID, so its front
 * reads straight off it.
 */
export const SCROBBLE_SCHEMA_V1 = { queue: '++id, [service+id]' } as const

/** Opens (lazily, on first use) the scrobble database. Tests pass another name. */
export function openScrobbleDatabase(name: string = SCROBBLE_DB_NAME): ScrobbleDatabase {
  const db = new Dexie(name) as ScrobbleDatabase
  db.version(1).stores(SCROBBLE_SCHEMA_V1)
  return db
}

/** A queue store (`ScrobbleStore` of `@fxm/sources/scrobble`) on the scrobble database. */
export function createDexieScrobbleStore(db: ScrobbleDatabase): ScrobbleStore {
  const queueOf = (service: ScrobbleServiceId) =>
    db.queue.where('[service+id]').between([service, Dexie.minKey], [service, Dexie.maxKey])
  return {
    add(service, scrobbles, max, user) {
      return db.transaction('rw', db.queue, async () => {
        await db.queue.bulkAdd(
          scrobbles.map((scrobble) => ({
            service,
            ...(user === undefined ? {} : { user }),
            scrobble,
          })),
        )
        const excess = (await queueOf(service).count()) - Math.max(0, max)
        if (excess <= 0) return 0
        await db.queue.bulkDelete(await queueOf(service).limit(excess).primaryKeys())
        return excess
      })
    },
    async peek(service, limit) {
      if (limit <= 0) return []
      const records = await queueOf(service).limit(limit).toArray()
      return records.map(({ id, user, scrobble }) =>
        user === undefined ? { id, scrobble } : { id, user, scrobble },
      )
    },
    async remove(ids) {
      await db.queue.bulkDelete([...ids])
    },
    count(service) {
      return queueOf(service).count()
    },
    async clear(service) {
      await queueOf(service).delete()
    },
  }
}
