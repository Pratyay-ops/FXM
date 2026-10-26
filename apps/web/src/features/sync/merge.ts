/**
 * The sync merge: combines this device's library with the gist's, as pure functions over
 * snapshots (see `snapshot.ts`).
 *
 * It is a three-way merge. Besides the two libraries it takes the **base**, the snapshot both
 * agreed on after this device's last sync, so it can tell who changed what:
 *
 * - A change made on one side only wins.
 * - A deletion made on one side only (the record is in the base, and the other side still has
 *   it unchanged) is kept: a deleted playlist or an unliked song doesn't come back.
 * - When both sides changed the same record, the **backup import's merge rules** decide
 *   (`db/merge.ts`): local likes, follows and plays stay; the most recently saved track
 *   metadata wins; a pin wins, then the newer decision. A playlist changed on both sides is
 *   combined when its changes don't collide (songs added on both sides, a rename on one side
 *   and a reorder on the other), and **kept twice** when they do (two renames, two reorders):
 *   this device's version stays and the other becomes a copy, "… (other version)", so nothing
 *   is lost and the user decides which to keep.
 * - A playlist deleted on one side and changed on the other is kept, with a notice. Only its
 *   content counts as a change: saving it unchanged, which only moves `updatedAt`, doesn't.
 *
 * Without a base (the first sync on a device) every record in both libraries counts as changed
 * on both sides, which is exactly a backup import's merge, plus the copies.
 *
 * Deletions on the gist's side count only when the gist was made from this device's base
 * (`remoteFromBase`). After a race in which another device overwrote a push, or after the gist
 * was rewritten, what the gist lacks may never have been deleted on purpose, so it is kept.
 *
 * What a merge removes from this device can be counted ({@link countRemovals}); the engine asks
 * the user before it removes a lot ({@link exceedsRemovalLimits}).
 *
 * @module
 */

import {
  type EntityId,
  entityKey,
  formatId,
  type JsonObject,
  type JsonValue,
  parseId,
} from '@fxm/core'
import {
  MAX_NAME_LENGTH,
  type OrderRecord,
  PLAYLISTS_ORDER_ID,
  type PlaylistRecord,
} from '../../db/types'
import { canonicalJson, hashHex, sameJson } from './canonical'
import { historyKey, normalizeSnapshot, type SyncSnapshot } from './snapshot'

/** What a merge needs. */
export interface MergeInput {
  /** The snapshot of the last sync, when this device has synced with this gist before. */
  base?: SyncSnapshot | undefined
  /** This device's library. */
  local: SyncSnapshot
  /** The gist's library. */
  remote: SyncSnapshot
  /**
   * Whether the gist's snapshot was made from the base, directly or through later syncs, so
   * that what it lacks was deleted on purpose.
   */
  remoteFromBase: boolean
  /**
   * The app settings' defaults. Without a base, a setting still at its default counts as
   * unchanged, so a new device takes the synced settings instead of overriding them.
   */
  appSettingsDefaults?: JsonObject | undefined
  /**
   * Plays that started before this are never taken as deleted on the gist's side: near the
   * start of the history window, the device that wrote the gist may have cut it a little later.
   */
  historyDeletionsSince?: number | undefined
}

/** A playlist both sides changed in ways that collide: the other side's version, kept as a copy. */
export interface ConflictCopy {
  /** The playlist, which keeps this device's version. */
  originalId: EntityId<'playlist'>
  /** The copy with the other side's version. */
  copyId: EntityId<'playlist'>
  /** The copy's name. */
  name: string
}

/** Something the merge kept that one side had deleted, for a notice. */
export interface MergeNotice {
  /**
   * - `kept-here`: deleted on another device, but changed here, so it stays
   * - `restored`: deleted here, but changed on another device, so it is back
   */
  kind: 'kept-here' | 'restored'
  playlistId: EntityId<'playlist'>
  name: string
}

/** What a merge gives. */
export interface MergeResult {
  /** The merged library: what both sides hold after the sync. */
  snapshot: SyncSnapshot
  /** Playlists kept twice, created by this merge. */
  copies: ConflictCopy[]
  /** Deleted playlists the merge kept. */
  notices: MergeNotice[]
}

/** What a conflict copy's name ends with. */
export const COPY_SUFFIX = ' (other version)'

/** Merges two libraries. Pure: the inputs are never changed. */
export function mergeSnapshots(input: MergeInput): MergeResult {
  const { base, local, remote, remoteFromBase } = input
  const playlists = mergePlaylists(input)
  const snapshot: SyncSnapshot = {
    tracks: mergeKeyed(base?.tracks, local.tracks, remote.tracks, remoteFromBase, {
      keyOf: (row) => row.id,
      // The most recently saved metadata wins, as in a backup import.
      resolve: (here, there) => (there.updatedAt > here.updatedAt ? there : here),
      // A cache: tracks lists show. Sync never deletes one.
      unionOnly: true,
    }),
    likes: mergeKeyed(base?.likes, local.likes, remote.likes, remoteFromBase, {
      keyOf: (row) => row.key,
      resolve: (here) => here,
    }),
    playlists: playlists.playlists,
    follows: mergeKeyed(base?.follows, local.follows, remote.follows, remoteFromBase, {
      keyOf: (row) => row.key,
      resolve: (here) => here,
    }),
    history: mergeKeyed(base?.history, local.history, remote.history, remoteFromBase, {
      keyOf: historyKey,
      resolve: (here) => here,
      deletableThere: (row) => row.playedAt >= (input.historyDeletionsSince ?? 0),
    }),
    settings: mergeKeyed(base?.settings, local.settings, remote.settings, remoteFromBase, {
      keyOf: (row) => row.key,
      resolve: (here) => here,
    }),
    pins: mergeKeyed(base?.pins, local.pins, remote.pins, remoteFromBase, {
      keyOf: (row) => row.key,
      // Both are pins: the newer decision wins, as in a backup import.
      resolve: (here, there) => (there.decidedAt > here.decidedAt ? there : here),
    }),
    appSettings: mergeAppSettings(
      base?.appSettings ?? input.appSettingsDefaults,
      local.appSettings,
      remote.appSettings,
    ),
  }
  const order = mergeOrders(input, playlists.copies)
  if (order !== undefined) snapshot.order = order
  return {
    snapshot: normalizeSnapshot(snapshot),
    copies: playlists.copies,
    notices: playlists.notices,
  }
}

// --- Keyed tables ------------------------------------------------------------------------

interface Indexed<T> {
  row: T
  json: string
}

function indexRows<T>(rows: readonly T[] | undefined, keyOf: (row: T) => string) {
  const map = new Map<string, Indexed<T>>()
  for (const row of rows ?? []) map.set(keyOf(row), { row, json: canonicalJson(row) })
  return map
}

interface KeyedOptions<T> {
  keyOf: (row: T) => string
  /** The row that stays when both sides changed it, or both added it. */
  resolve: (local: T, remote: T) => T
  /** The table is a cache: deletions never propagate, and both sides' rows are kept. */
  unionOnly?: boolean
  /** Whether the other side's lack of this row may count as a deletion (default: yes). */
  deletableThere?: (row: T) => boolean
}

/** The three-way merge of a table of records with keys (see the module documentation). */
function mergeKeyed<T>(
  baseRows: readonly T[] | undefined,
  localRows: readonly T[],
  remoteRows: readonly T[],
  remoteFromBase: boolean,
  options: KeyedOptions<T>,
): T[] {
  const { keyOf, resolve, unionOnly = false, deletableThere = () => true } = options
  const base = indexRows(baseRows, keyOf)
  const local = indexRows(localRows, keyOf)
  const remote = indexRows(remoteRows, keyOf)
  const result: T[] = []
  for (const [key, here] of local) {
    const there = remote.get(key)
    const before = base.get(key)
    if (there === undefined) {
      // The other side lacks it. It deleted the row only if it had it: the row is in the base,
      // and the gist descends from that base. Keep it if it changed here meanwhile.
      const deletedThere =
        !unionOnly &&
        before !== undefined &&
        remoteFromBase &&
        here.json === before.json &&
        deletableThere(here.row)
      if (!deletedThere) result.push(here.row)
      continue
    }
    if (here.json === there.json) result.push(here.row)
    else if (before !== undefined && there.json === before.json) result.push(here.row)
    else if (before !== undefined && here.json === before.json) result.push(there.row)
    else result.push(resolve(here.row, there.row))
  }
  for (const [key, there] of remote) {
    if (local.has(key)) continue
    // Only the gist has it: new there, unless this side deleted it since the base and the
    // other side didn't change it since.
    const before = base.get(key)
    const deletedHere = !unionOnly && before !== undefined && there.json === before.json
    if (!deletedHere) result.push(there.row)
  }
  return result
}

// --- Ordered lists -------------------------------------------------------------------------

interface ListOptions {
  /** Whether the local list was saved more recently. */
  localNewer: boolean
  /**
   * When both sides reordered the same items differently: report a conflict, or let the
   * newer order lead.
   */
  onReorder: 'conflict' | 'newer'
  /** Without a base, which list leads: the newer one, or the local one. */
  leaderWithoutBase: 'newer' | 'local'
}

interface ListResult<T> {
  order: T[]
  conflict: boolean
}

/** `first`, then the items of `second` it lacks (by key), as a backup import merges orders. */
function unionOrder<T>(first: readonly T[], second: readonly T[], keyOf: (item: T) => string) {
  const seen = new Set(first.map(keyOf))
  return [
    ...first,
    ...second.filter((item) => {
      const key = keyOf(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ]
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/**
 * `primary` with the items of `secondary` it lacks that are new since the base, each placed
 * right after the item that precedes it in `secondary` (or first), so songs added at the top
 * stay at the top and songs added at the end stay at the end.
 */
function insertAdditions<T>(
  primary: readonly T[],
  secondary: readonly T[],
  keyOf: (item: T) => string,
  baseKeys: ReadonlySet<string>,
): T[] {
  const result = [...primary]
  const placed = new Set(result.map(keyOf))
  secondary.forEach((item, index) => {
    const key = keyOf(item)
    if (placed.has(key) || baseKeys.has(key)) return
    let at = 0
    for (let back = index - 1; back >= 0; back--) {
      const anchor = keyOf(secondary[back] as T)
      if (placed.has(anchor)) {
        at = result.findIndex((other) => keyOf(other) === anchor) + 1
        break
      }
    }
    result.splice(at, 0, item)
    placed.add(key)
  })
  return result
}

/**
 * The three-way merge of an ordered list without repeats: items removed on either side go,
 * items added on either side come in, and the order is the one that changed. When both
 * reordered the same items differently, `options.onReorder` decides.
 */
function mergeList<T>(
  base: readonly T[] | undefined,
  local: readonly T[],
  remote: readonly T[],
  keyOf: (item: T) => string,
  options: ListOptions,
): ListResult<T> {
  if (base === undefined) {
    const remoteKeys = new Set(remote.map(keyOf))
    const localKeys = new Set(local.map(keyOf))
    const compatible = sameSequence(
      local.map(keyOf).filter((key) => remoteKeys.has(key)),
      remote.map(keyOf).filter((key) => localKeys.has(key)),
    )
    if (!compatible && options.onReorder === 'conflict')
      return { order: [...local], conflict: true }
    const localLeads = options.leaderWithoutBase === 'local' || options.localNewer
    return {
      order: localLeads ? unionOrder(local, remote, keyOf) : unionOrder(remote, local, keyOf),
      conflict: false,
    }
  }
  const baseKeys = new Set(base.map(keyOf))
  const localKeys = new Set(local.map(keyOf))
  const remoteKeys = new Set(remote.map(keyOf))
  const removed = new Set(
    [...baseKeys].filter((key) => !localKeys.has(key) || !remoteKeys.has(key)),
  )
  const localKept = local.filter((item) => !removed.has(keyOf(item)))
  const remoteKept = remote.filter((item) => !removed.has(keyOf(item)))
  // The items all three hold: their relative order says who reordered.
  const inAll = (key: string) => baseKeys.has(key) && !removed.has(key)
  const sequence = (list: readonly T[]) => list.map(keyOf).filter(inAll)
  const baseSequence = sequence(base)
  const localSequence = sequence(localKept)
  const remoteSequence = sequence(remoteKept)
  const localMoved = !sameSequence(localSequence, baseSequence)
  const remoteMoved = !sameSequence(remoteSequence, baseSequence)
  let localLeads = true
  if (localMoved && remoteMoved && !sameSequence(localSequence, remoteSequence)) {
    if (options.onReorder === 'conflict') return { order: [...local], conflict: true }
    localLeads = options.localNewer
  } else if (remoteMoved && !localMoved) {
    localLeads = false
  }
  const [primary, secondary] = localLeads ? [localKept, remoteKept] : [remoteKept, localKept]
  return { order: insertAdditions(primary, secondary, keyOf, baseKeys), conflict: false }
}

// --- Playlists -------------------------------------------------------------------------------

/** A value of a playlist field after a three-way pick, or a conflict. */
function pick<T>(
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  hasBase: boolean,
): { value: T | undefined; conflict: boolean } {
  if (sameJson(local, remote)) return { value: local, conflict: false }
  if (hasBase && sameJson(local, base)) return { value: remote, conflict: false }
  if (hasBase && sameJson(remote, base)) return { value: local, conflict: false }
  return { value: local, conflict: true }
}

/** The earliest date each track was added on either side, under the merged spelling. */
function mergedAddedAt(
  trackIds: readonly EntityId<'track'>[],
  sides: readonly PlaylistRecord[],
): Record<string, number> {
  const earliest = new Map<string, number>()
  for (const side of sides) {
    for (const [id, at] of Object.entries(side.addedAt)) {
      const key = entityKey(id as EntityId)
      const known = earliest.get(key)
      if (known === undefined || at < known) earliest.set(key, at)
    }
  }
  const result: Record<string, number> = {}
  for (const id of trackIds) {
    const at = earliest.get(entityKey(id))
    if (at !== undefined) result[id] = at
  }
  return result
}

/**
 * A playlist both sides changed: the combined record, or `null` when the changes collide
 * (both renamed it, or both reordered it, differently). Liked songs never collides: when both
 * reordered it, the newer order leads.
 */
function combinePlaylist(
  base: PlaylistRecord | undefined,
  local: PlaylistRecord,
  remote: PlaylistRecord,
): PlaylistRecord | null {
  const hasBase = base !== undefined
  const builtIn = local.system !== undefined
  const name = pick(base?.name, local.name, remote.name, hasBase)
  const description = pick(base?.description, local.description, remote.description, hasBase)
  const artwork = pick(base?.artwork, local.artwork, remote.artwork, hasBase)
  const tracks = mergeList(base?.trackIds, local.trackIds, remote.trackIds, entityKey, {
    localNewer: local.updatedAt >= remote.updatedAt,
    onReorder: builtIn ? 'newer' : 'conflict',
    leaderWithoutBase: 'newer',
  })
  if (!builtIn && (name.conflict || description.conflict || artwork.conflict || tracks.conflict)) {
    return null
  }
  const record: PlaylistRecord = {
    id: local.id,
    name: builtIn ? local.name : (name.value ?? local.name),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    trackIds: tracks.order,
    addedAt: mergedAddedAt(tracks.order, [local, remote]),
  }
  if (local.system !== undefined) record.system = local.system
  if (description.value !== undefined) record.description = description.value
  if (artwork.value !== undefined && artwork.value.length > 0) record.artwork = artwork.value
  return record
}

/**
 * What a playlist holds, without when it was saved: what tells whether it changed since the
 * base when the other side deleted it. Renaming a playlist to the same name still moves its
 * `updatedAt`, and that alone mustn't keep a playlist another device deleted.
 */
function contentOf(record: PlaylistRecord): string {
  const { updatedAt: _updatedAt, ...content } = record
  return canonicalJson(content)
}

/** Matches a conflict copy's native ID: the original's, `~`, and 10 hex digits. */
const COPY_ID = /^(local:playlist:.+)~[0-9a-f]{10}$/

/**
 * The copy that keeps `version` of a playlist next to this device's version. Its ID derives
 * from the original's and the version's content, so the same conflict always makes the same
 * copy: a sync that is retried, or two devices that meet the same conflict, never make two.
 */
export function conflictCopyOf(version: PlaylistRecord): PlaylistRecord {
  const { nativeId } = parseId(version.id)
  const fingerprint = hashHex(canonicalJson(version)).slice(-10)
  const room = MAX_NAME_LENGTH - COPY_SUFFIX.length
  return {
    ...version,
    id: formatId('local', 'playlist', `${nativeId}~${fingerprint}`),
    name: `${version.name.slice(0, room).trimEnd()}${COPY_SUFFIX}`,
  }
}

/** The playlist a conflict copy (see {@link conflictCopyOf}) was made for, if `id` is one. */
export function conflictOriginalOf(id: string): EntityId<'playlist'> | undefined {
  const match = COPY_ID.exec(id)
  return match ? (match[1] as EntityId<'playlist'>) : undefined
}

/** The name a conflict copy had before it became one. */
export function nameBeforeCopy(name: string): string {
  return name.endsWith(COPY_SUFFIX) ? name.slice(0, -COPY_SUFFIX.length) : name
}

function mergePlaylists(input: MergeInput): {
  playlists: PlaylistRecord[]
  copies: ConflictCopy[]
  notices: MergeNotice[]
} {
  const keyOf = (row: PlaylistRecord) => row.id
  const base = indexRows(input.base?.playlists, keyOf)
  const local = indexRows(input.local.playlists, keyOf)
  const remote = indexRows(input.remote.playlists, keyOf)
  const result = new Map<string, PlaylistRecord>()
  const versions: PlaylistRecord[] = []
  const notices: MergeNotice[] = []

  for (const [id, here] of local) {
    const there = remote.get(id)
    const before = base.get(id)
    if (there === undefined) {
      if (before !== undefined && input.remoteFromBase && here.row.system === undefined) {
        // Deleted on the other side: gone too, unless it changed here meanwhile.
        if (contentOf(here.row) === contentOf(before.row)) continue
        notices.push({ kind: 'kept-here', playlistId: here.row.id, name: here.row.name })
      }
      result.set(id, here.row)
      continue
    }
    if (here.json === there.json) {
      result.set(id, here.row)
      continue
    }
    const changedHere = before === undefined || here.json !== before.json
    const changedThere = before === undefined || there.json !== before.json
    if (!changedThere) result.set(id, here.row)
    else if (!changedHere) result.set(id, there.row)
    else {
      const combined = combinePlaylist(before?.row, here.row, there.row)
      if (combined === null) {
        // Keep both: this device's version stays, the other side's becomes a copy.
        result.set(id, here.row)
        versions.push(there.row)
      } else {
        result.set(id, combined)
      }
    }
  }
  for (const [id, there] of remote) {
    if (local.has(id)) continue
    const before = base.get(id)
    if (before !== undefined && there.row.system === undefined) {
      // Deleted here: it stays deleted, unless the other side changed it meanwhile.
      if (contentOf(there.row) === contentOf(before.row)) continue
      notices.push({ kind: 'restored', playlistId: there.row.id, name: there.row.name })
    }
    result.set(id, there.row)
  }

  const copies: ConflictCopy[] = []
  for (const version of versions) {
    const copy = conflictCopyOf(version)
    // An earlier, unfinished sync may have made this copy already.
    if (result.has(copy.id)) continue
    result.set(copy.id, copy)
    copies.push({ originalId: version.id, copyId: copy.id, name: copy.name })
  }
  return { playlists: [...result.values()], copies, notices }
}

// --- The list of playlists ------------------------------------------------------------------

function mergeOrders(input: MergeInput, copies: readonly ConflictCopy[]): OrderRecord | undefined {
  const here = input.local.order
  const there = input.remote.order
  const before = input.base?.order
  if (here === undefined && there === undefined) return undefined
  // A change on one side only wins whole, as for any record; the list merge is for both.
  let chosen: OrderRecord
  if (here !== undefined && (there === undefined || sameJson(here, there))) chosen = here
  else if (there !== undefined && here === undefined) chosen = there
  else if (before !== undefined && sameJson(here, before) && there !== undefined) chosen = there
  else if (before !== undefined && sameJson(there, before) && here !== undefined) chosen = here
  else {
    const local = here?.order ?? []
    const remote = there?.order ?? []
    const merged = mergeList(before?.order, local, remote, (id) => id, {
      localNewer: (here?.updatedAt ?? 0) >= (there?.updatedAt ?? 0),
      // The list of playlists is no data of its own: the newer order leads.
      onReorder: 'newer',
      // As a backup import does: this device's order, then the gist's other playlists.
      leaderWithoutBase: 'local',
    }).order
    const updatedAt = Math.max(here?.updatedAt ?? 0, there?.updatedAt ?? 0)
    if (here !== undefined && sameSequence(merged, local)) chosen = here
    else if (there !== undefined && sameSequence(merged, remote)) chosen = there
    else chosen = { id: PLAYLISTS_ORDER_ID, order: merged, updatedAt }
  }
  // Each conflict copy goes right after its original.
  const missing = copies.filter((copy) => !chosen.order.includes(copy.copyId))
  if (missing.length === 0) return chosen
  const order = [...chosen.order]
  for (const copy of missing) order.splice(order.indexOf(copy.originalId) + 1, 0, copy.copyId)
  return {
    id: PLAYLISTS_ORDER_ID,
    order,
    updatedAt: Math.max(here?.updatedAt ?? 0, there?.updatedAt ?? 0),
  }
}

// --- What a merge removes --------------------------------------------------------------------

/** How many of this device's records a merge removes, because the gist's side deleted them. */
export interface RemovalCounts {
  /** The user's playlists that held songs. */
  playlists: number
  likes: number
  follows: number
  plays: number
}

/** The records of `local` that `merged` lacks: what the merge removes from this device. */
export function countRemovals(local: SyncSnapshot, merged: SyncSnapshot): RemovalCounts {
  const gone = <T>(
    before: readonly T[],
    after: readonly T[],
    keyOf: (row: T) => string,
    counts: (row: T) => boolean = () => true,
  ) => {
    const kept = new Set(after.map(keyOf))
    return before.filter((row) => !kept.has(keyOf(row)) && counts(row)).length
  }
  return {
    playlists: gone(
      local.playlists,
      merged.playlists,
      (row) => row.id,
      (row) => row.system === undefined && row.trackIds.length > 0,
    ),
    likes: gone(local.likes, merged.likes, (row) => row.key),
    follows: gone(local.follows, merged.follows, (row) => row.key),
    plays: gone(local.history, merged.history, historyKey),
  }
}

/**
 * How many records of a kind a merge may remove without asking: a tenth of what this device
 * holds, but at least `least` and at most `most`.
 */
const REMOVAL_LIMITS: Readonly<Record<keyof RemovalCounts, { least: number; most: number }>> = {
  playlists: { least: 1, most: 5 },
  likes: { least: 5, most: 100 },
  follows: { least: 5, most: 100 },
  plays: { least: 25, most: 500 },
}

/**
 * Whether a merge removes so much of this device's library that the user should decide first:
 * more than one playlist with songs (or a tenth of them, up to 5), or more than a tenth of the
 * likes, follows or plays (at least 5 likes or follows, 25 plays; at most 100 likes or follows,
 * 500 plays). Deleting a playlist or unliking songs on one device then syncs as usual, but a
 * device wiped by mistake, an old backup restored with Replace, or a gist changed outside FXM
 * can't empty every device's library unnoticed.
 */
export function exceedsRemovalLimits(removed: RemovalCounts, local: SyncSnapshot): boolean {
  const held: RemovalCounts = {
    playlists: local.playlists.filter((row) => row.system === undefined && row.trackIds.length > 0)
      .length,
    likes: local.likes.length,
    follows: local.follows.length,
    plays: local.history.length,
  }
  return (Object.keys(REMOVAL_LIMITS) as (keyof RemovalCounts)[]).some((kind) => {
    const { least, most } = REMOVAL_LIMITS[kind]
    const limit = Math.min(most, Math.max(least, Math.floor(held[kind] / 10)))
    return removed[kind] > limit
  })
}

// --- App settings ----------------------------------------------------------------------------

function own(object: JsonObject | undefined, key: string): JsonValue | undefined {
  return object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined
}

/**
 * The app settings, setting by setting: a change on one side wins; when both changed one,
 * this device's choice stays. A setting this device doesn't know (from a newer FXM) is kept.
 */
function mergeAppSettings(
  base: JsonObject | undefined,
  local: JsonObject,
  remote: JsonObject,
): JsonObject {
  const result: Record<string, JsonValue> = {}
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const here = own(local, key)
    const there = own(remote, key)
    const before = own(base, key)
    if (here === undefined) {
      if (there !== undefined) result[key] = there
    } else if (there === undefined || sameJson(here, there)) {
      result[key] = here
    } else if (base !== undefined && sameJson(here, before)) {
      result[key] = there
    } else {
      result[key] = here
    }
  }
  return result
}
