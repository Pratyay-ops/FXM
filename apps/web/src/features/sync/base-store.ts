/**
 * Where a device keeps the **base** of its sync: the snapshot it and the gist agreed on after
 * its last sync, which the next merge compares both sides with (see `merge.ts`).
 *
 * It lives in an IndexedDB database of its own, `fxm-sync`, apart from the library: backups
 * never include it, and turning sync off on a device keeps it, so turning sync back on with
 * the same gist still knows what was deleted meanwhile.
 *
 * @module
 */

import { Dexie, type DexieOptions, type EntityTable } from 'dexie'
import type { PartRef } from './gist-format'
import type { SyncSnapshot } from './snapshot'

/** The IndexedDB database of sync bases. */
export const SYNC_DB_NAME = 'fxm-sync'

/** What a device knows about its gist after a sync. */
export interface SyncBase {
  /** The gist. */
  gistId: string
  /** The gist's revision after that sync. */
  revision: string
  /** That revision's ancestors, newest first. */
  ancestors: string[]
  /** The library both agreed on. */
  snapshot: SyncSnapshot
  /** The snapshot's fingerprint, to tell quickly whether the library changed since. */
  fingerprint: string
  /** The parts its manifest lists. */
  parts: PartRef[]
  /** Every file the gist holds, the parts of an earlier manifest included. */
  files: string[]
  /** The gist's ETag, for a conditional read. */
  etag?: string
  /** When it was saved, as epoch milliseconds. */
  savedAt: number
}

/** Storage for sync bases, one per gist. */
export interface BaseStore {
  get(gistId: string): Promise<SyncBase | undefined>
  put(base: SyncBase): Promise<void>
  delete(gistId: string): Promise<void>
}

/** Whether a stored value still looks like a base; a damaged one is ignored. */
function isBase(value: unknown): value is SyncBase {
  if (typeof value !== 'object' || value === null) return false
  const base = value as Partial<SyncBase>
  return (
    typeof base.gistId === 'string' &&
    typeof base.revision === 'string' &&
    Array.isArray(base.ancestors) &&
    Array.isArray(base.parts) &&
    Array.isArray(base.files) &&
    typeof base.fingerprint === 'string' &&
    typeof base.snapshot === 'object' &&
    base.snapshot !== null &&
    Array.isArray(base.snapshot.playlists)
  )
}

type SyncDatabase = Dexie & { bases: EntityTable<SyncBase, 'gistId'> }

/** Bases in IndexedDB. Pass another name and Dexie options in tests. */
export function createIndexedDbBaseStore(
  name: string = SYNC_DB_NAME,
  options?: DexieOptions,
): BaseStore & { close(): void } {
  const db = new Dexie(name, options) as SyncDatabase
  db.version(1).stores({ bases: 'gistId' })
  return {
    async get(gistId) {
      const value: unknown = await db.bases.get(gistId)
      return isBase(value) ? value : undefined
    },
    async put(base) {
      await db.bases.put(base)
    },
    async delete(gistId) {
      await db.bases.delete(gistId)
    },
    close() {
      db.close()
    },
  }
}

/** Bases in memory, for tests. */
export function createMemoryBaseStore(): BaseStore & { bases: Map<string, SyncBase> } {
  const bases = new Map<string, SyncBase>()
  return {
    bases,
    async get(gistId) {
      // A deep copy, as IndexedDB would return.
      const base = bases.get(gistId)
      return base === undefined ? undefined : structuredClone(base)
    },
    async put(base) {
      bases.set(base.gistId, structuredClone(base))
    },
    async delete(gistId) {
      bases.delete(gistId)
    },
  }
}
