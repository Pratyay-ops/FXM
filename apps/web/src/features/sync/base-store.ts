/**
 * Where a device keeps the **base** of its sync: the snapshot it and the gist agreed on after
 * its last sync, which the next merge compares both sides with (see `merge.ts`).
 *
 * It lives in an IndexedDB database of its own, `fxm-sync`, apart from the library: backups
 * never include it. It exists only while sync is on: turning sync off deletes every base, so
 * nothing synced stays behind on the device where the user can't see it. A base that can't be
 * read (damaged, or written by a newer FXM) is deleted too, and the next sync is a first sync,
 * which keeps everything on both sides.
 *
 * @module
 */

import { Dexie, type DexieOptions, type EntityTable } from 'dexie'
import { isPartFile, type PartRef } from './gist-format'
import {
  isSyncTable,
  type SyncSnapshot,
  snapshotFingerprint,
  snapshotFromRows,
  snapshotRows,
} from './snapshot'

/** The IndexedDB database of sync bases. */
export const SYNC_DB_NAME = 'fxm-sync'

/** The version of the base's shape. A base of another version is dropped. */
export const BASE_VERSION = 1

/** What a device knows about its gist after a sync. */
export interface SyncBase {
  /** {@link BASE_VERSION}. */
  version: number
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
  /** The parts of the manifest before it, which the gist still holds (`previous`). */
  previous: string[]
  /** Every file the gist holds. */
  files: string[]
  /**
   * Part files in the gist that neither list names, with when this device first saw each (0
   * for files an earlier manifest listed): another device's push still uploading, or what a
   * failed push left behind. A push deletes them once they are old enough (see `engine.ts`).
   */
  strays: Record<string, number>
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
  /** Deletes every base. */
  clear(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function readPart(value: unknown): PartRef | null {
  if (
    !isRecord(value) ||
    typeof value.file !== 'string' ||
    !isPartFile(value.file) ||
    !isSyncTable(value.table) ||
    typeof value.hash !== 'string' ||
    !isTime(value.rows) ||
    !isTime(value.bytes)
  ) {
    return null
  }
  return {
    file: value.file,
    table: value.table,
    rows: value.rows,
    bytes: value.bytes,
    hash: value.hash,
  }
}

/** The lists a snapshot holds, by their names in it. */
const SNAPSHOT_LISTS = ['tracks', 'likes', 'playlists', 'follows', 'history', 'settings', 'pins']

/**
 * A stored base, checked as closely as anything from outside: its snapshot goes through the
 * library's guards again, as a gist's does. `undefined` when it can't be one, or comes from
 * another version.
 */
export function readBase(value: unknown): SyncBase | undefined {
  if (!isRecord(value) || value.version !== BASE_VERSION) return undefined
  const { gistId, revision, ancestors, previous, files, savedAt, etag, snapshot } = value
  if (
    typeof gistId !== 'string' ||
    typeof revision !== 'string' ||
    !isStrings(ancestors) ||
    !isStrings(previous) ||
    !isStrings(files) ||
    !isTime(savedAt) ||
    (etag !== undefined && typeof etag !== 'string') ||
    !Array.isArray(value.parts) ||
    !isRecord(value.strays) ||
    !isRecord(snapshot) ||
    !SNAPSHOT_LISTS.every((list) => Array.isArray(snapshot[list])) ||
    (snapshot.order !== undefined && !isRecord(snapshot.order))
  ) {
    return undefined
  }
  const parts = value.parts.map(readPart)
  if (parts.some((part) => part === null)) return undefined
  const strays: Record<string, number> = {}
  for (const [file, since] of Object.entries(value.strays)) {
    if (!isPartFile(file) || !isTime(since)) return undefined
    strays[file] = since
  }
  const read = snapshotFromRows(
    snapshotRows(snapshot as unknown as SyncSnapshot),
    snapshot.appSettings,
  )
  const base: SyncBase = {
    version: BASE_VERSION,
    gistId,
    revision,
    ancestors,
    snapshot: read.snapshot,
    fingerprint: snapshotFingerprint(read.snapshot),
    parts: parts as PartRef[],
    previous,
    files,
    strays,
    savedAt,
  }
  if (etag !== undefined) base.etag = etag
  return base
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
      if (value === undefined) return undefined
      const base = readBase(value)
      // Unreadable: the next sync is a first sync, which keeps everything on both sides.
      if (base === undefined) await db.bases.delete(gistId)
      return base
    },
    async put(base) {
      await db.bases.put(base)
    },
    async delete(gistId) {
      await db.bases.delete(gistId)
    },
    async clear() {
      await db.bases.clear()
    },
    close() {
      db.close()
    },
  }
}

/** Bases in memory, for tests. They are read back as the IndexedDB store reads them. */
export function createMemoryBaseStore(): BaseStore & { bases: Map<string, SyncBase> } {
  const bases = new Map<string, SyncBase>()
  return {
    bases,
    async get(gistId) {
      const stored = bases.get(gistId)
      if (stored === undefined) return undefined
      // A deep copy, as IndexedDB would return.
      const base = readBase(structuredClone(stored))
      if (base === undefined) bases.delete(gistId)
      return base
    },
    async put(base) {
      bases.set(base.gistId, structuredClone(base))
    },
    async delete(gistId) {
      bases.delete(gistId)
    },
    async clear() {
      bases.clear()
    },
  }
}
