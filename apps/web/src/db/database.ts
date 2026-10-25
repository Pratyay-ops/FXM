/**
 * The library database: Dexie over IndexedDB, named `fxm`, with a versioned schema.
 *
 * ## Versions
 *
 * - **1**: the library as stage 2.6 first specified it: the track cache, likes, playlists with
 *   their saved order, the order of the playlists list, follows, history, reserved settings and
 *   a match cache with one decision per source track.
 * - **2**: what the research memo of 2026-10-25 (section 11.3) added: the match cache is keyed
 *   by the source track and the catalog mode, with signals, evidence and user pins; and an
 *   import-progress table, so imports can resume. The upgrade rewrites version 1 decisions.
 * - **3**: the listening affinity of stage 3.1: one record per track, artist and tag, indexed by
 *   kind and rank. The upgrade computes it from the history, the likes and the playlists.
 *
 * To change the schema, add a version below with only the tables that change and, when stored
 * records need rewriting, an `upgrade` function. Never edit an existing version: browsers that
 * already have it would never see the change. Then add a case to `database.test.ts`, which
 * opens a database written by the previous version. The README in this folder has the details.
 *
 * Only the repository (`repo.ts`) reads and writes these tables.
 *
 * @module
 */

import { type AudioCandidate, type EntityId, entityKey, isEntityId } from '@fxm/core'
import { Dexie, type DexieOptions, type EntityTable, type Transaction } from 'dexie'
import { rebuildAffinity } from './affinity'
import { matchKey } from './match-cache'
import {
  type AffinityRecord,
  DB_NAME,
  DOWNLOADS_PLAYLIST_ID,
  type FollowRecord,
  type HistoryRecord,
  type ImportProgressRecord,
  LIKED_PLAYLIST_ID,
  type LikeRecord,
  type MatchBand,
  type MatchCacheRecord,
  type OrderRecord,
  PLAYLISTS_ORDER_ID,
  type PlaylistRecord,
  type SettingRecord,
  SYSTEM_PLAYLIST_IDS,
  SYSTEM_PLAYLIST_NAMES,
  type SystemPlaylist,
  type TrackRecord,
} from './types'

/** The newest schema version. Backups record it, and imports accept it or anything older. */
export const SCHEMA_VERSION = 3

/** The library database with its typed tables. Create one with {@link openDatabase}. */
export type FxmDatabase = Dexie & {
  tracks: EntityTable<TrackRecord, 'id'>
  likes: EntityTable<LikeRecord, 'key'>
  playlists: EntityTable<PlaylistRecord, 'id'>
  orders: EntityTable<OrderRecord, 'id'>
  follows: EntityTable<FollowRecord, 'key'>
  history: EntityTable<HistoryRecord, 'id'>
  settings: EntityTable<SettingRecord, 'key'>
  matchCache: EntityTable<MatchCacheRecord, 'key'>
  importProgress: EntityTable<ImportProgressRecord, 'id'>
  affinity: EntityTable<AffinityRecord, 'id'>
}

/**
 * Every table of the newest schema, in the order backups list them. Backups leave out
 * `affinity`, which is derived from the others and rebuilt after an import.
 */
export const TABLE_NAMES = [
  'tracks',
  'likes',
  'playlists',
  'orders',
  'follows',
  'history',
  'settings',
  'matchCache',
  'importProgress',
  'affinity',
] as const

/** The name of a table of the newest schema. */
export type TableName = (typeof TABLE_NAMES)[number]

/**
 * Version 1. The first index of each table is its primary key (`++` auto-increments it);
 * the others are indexes. Only indexed fields can be queried, and booleans can't be indexed.
 */
export const SCHEMA_V1 = {
  tracks: 'id, updatedAt',
  likes: 'key, likedAt',
  playlists: 'id, updatedAt',
  orders: 'id',
  follows: 'key, kind, [kind+followedAt]',
  history: '++id, trackId, playedAt',
  settings: 'key',
  matchCache: 'key, decidedAt',
} as const

/** Version 2: only what changed since version 1. */
export const SCHEMA_V2 = {
  matchCache: 'key, sourceKey, decidedAt, isrc',
  importProgress: 'id, status, updatedAt',
} as const

/**
 * Version 3: the listening affinity (stage 3.1), keyed by `<kind>|<key>`. The compound index
 * orders each kind by `affinityRank`, which orders entries by their affinity at any time, so
 * the top entries of a kind read straight off it.
 */
export const SCHEMA_V3 = {
  affinity: 'id, [kind+rank]',
} as const

/**
 * A version 1 match-cache record: one decision per source track, whatever the catalog mode,
 * keyed by `entityKey(sourceTrackId)`, with `userOverride` set when the user chose the
 * candidate.
 */
export interface MatchCacheRecordV1 {
  key: string
  sourceTrackId: EntityId<'track'>
  candidate?: AudioCandidate
  alternatives: AudioCandidate[]
  band: MatchBand
  decidedAt: number
  userOverride: boolean
}

/**
 * Rewrites a version 1 decision for version 2, or `null` when it is unusable. Version 1 did not
 * record the catalog mode, so a decision whose audio is a song (or that has none) becomes a
 * Music decision, and one whose audio is a video becomes a Music + Video decision, the only
 * mode that may play it. An override becomes a pin. A `suggest` decision stays unconfirmed.
 */
export function upgradeMatchRecord(value: unknown): MatchCacheRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const old = value as Partial<MatchCacheRecordV1>
  if (!isEntityId(old.sourceTrackId, 'track')) return null
  if (old.band !== 'auto' && old.band !== 'suggest' && old.band !== 'none') return null
  const decidedAt = typeof old.decidedAt === 'number' ? old.decidedAt : 0
  const candidate = old.candidate
  const mode = candidate === undefined || candidate.kind === 'song' ? 'music' : 'all'
  const record: MatchCacheRecord = {
    key: matchKey(old.sourceTrackId, mode),
    sourceKey: entityKey(old.sourceTrackId),
    sourceTrackId: old.sourceTrackId,
    mode,
    band: old.band,
    alternatives: Array.isArray(old.alternatives) ? old.alternatives : [],
    evidence: candidate?.evidence ?? [],
    userPinned: old.userOverride === true && candidate !== undefined,
    decidedAt,
  }
  if (candidate !== undefined) record.candidate = candidate
  if (candidate?.signals !== undefined) record.signals = candidate.signals
  return record
}

async function upgradeToV2(tx: Transaction): Promise<void> {
  const table = tx.table('matchCache')
  const rows: unknown[] = await table.toArray()
  await table.clear()
  const upgraded = rows.map(upgradeMatchRecord).filter((row) => row !== null)
  // Two version 1 rows can't collide: each had its own source key, and gets one mode.
  await table.bulkPut(upgraded)
}

/** Computes the affinity of a library that predates it from its history, likes and playlists. */
async function upgradeToV3(tx: Transaction): Promise<void> {
  await rebuildAffinity({
    affinity: tx.table('affinity'),
    history: tx.table('history'),
    likes: tx.table('likes'),
    playlists: tx.table('playlists'),
    tracks: tx.table('tracks'),
  })
}

/** The order a new library lists its playlists in. */
export const DEFAULT_PLAYLIST_ORDER: readonly EntityId<'playlist'>[] = [
  LIKED_PLAYLIST_ID,
  DOWNLOADS_PLAYLIST_ID,
]

/** A built-in playlist as a new library has it. */
export function newSystemPlaylist(system: SystemPlaylist, now: number): PlaylistRecord {
  return {
    id: SYSTEM_PLAYLIST_IDS[system],
    system,
    name: SYSTEM_PLAYLIST_NAMES[system],
    createdAt: now,
    updatedAt: now,
    trackIds: [],
    addedAt: {},
  }
}

/**
 * Creates the built-in playlists and the order of the playlists list when they are missing:
 * on a new database, and after anything that wiped them, such as restoring a backup that lacks
 * them. Safe to run any number of times.
 */
export async function ensureSystemRecords(db: FxmDatabase, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.playlists, db.orders, async () => {
    for (const system of ['liked', 'downloads'] as const) {
      const id = SYSTEM_PLAYLIST_IDS[system]
      const existing = await db.playlists.get(id)
      if (existing === undefined) await db.playlists.add(newSystemPlaylist(system, now))
      else if (existing.system !== system) await db.playlists.update(id, { system })
    }
    if ((await db.orders.get(PLAYLISTS_ORDER_ID)) === undefined) {
      await db.orders.add({
        id: PLAYLISTS_ORDER_ID,
        order: [...DEFAULT_PLAYLIST_ORDER],
        updatedAt: now,
      })
    }
  })
}

/**
 * Opens (lazily, on first use) the library database, and makes sure the built-in playlists
 * exist every time it opens. Pass another name for tests, and Dexie options such as a fake
 * `indexedDB`.
 */
export function openDatabase(name: string = DB_NAME, options?: DexieOptions): FxmDatabase {
  const db = new Dexie(name, options) as FxmDatabase
  db.version(1).stores(SCHEMA_V1)
  db.version(2).stores(SCHEMA_V2).upgrade(upgradeToV2)
  db.version(3).stores(SCHEMA_V3).upgrade(upgradeToV3)
  // Sticky: runs on every open, also after a close, before any other query sees the database.
  db.on('ready', (vip) => ensureSystemRecords(vip as FxmDatabase), true)
  return db
}
