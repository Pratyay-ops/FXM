/**
 * What the sync remembers between runs, in the library's settings (`spotify-account.*`, see
 * `ids.ts`): which account the copies follow, and for each copied list what Spotify held at the
 * last sync (the base of the three-way merge, `merge.ts`). It lives with the library, so
 * clearing or restoring the library takes it along and never leaves it pointing at copies that
 * aren't there. It never holds a token, a cookie or the account's user name, and it never syncs
 * to other devices (no `sync.` prefix): each device keeps its own.
 *
 * Rows come back from backups too, so every read checks them field by field.
 *
 * @module
 */

import type { EntityId, JsonValue } from '@fxm/core'
import {
  isAccountKey,
  isSpotifyCopyId,
  isSpotifyNativeId,
  LIST_PREFIX,
  listKey,
  META_KEY,
} from './ids'

/** The most tracks one copied list remembers: Spotify caps playlists at 10,000. */
export const MAX_REMEMBERED_TRACKS = 20_000

/** What the last sync did, for Settings. */
export interface SyncSummary {
  /** When it ended, as epoch milliseconds. */
  readonly at: number
  /** How many songs the account's liked songs hold. */
  readonly likedCount: number
  /** How many of the account's playlists have a copy that follows them. */
  readonly playlistCount: number
  /** Copies made by this sync. */
  readonly created: number
  /** Copies this sync changed. */
  readonly updated: number
  /** Tracks this sync added to copies. */
  readonly added: number
  /** Tracks this sync took out of copies. */
  readonly removed: number
  /** Copies the user deleted, which the sync leaves deleted. */
  readonly dismissed: number
  /** Playlists that left the account's library since the last sync; their copies stay. */
  readonly departed: number
  /** Lists left out: over the limits, or unreadable. */
  readonly skipped: number
  /** Whether the personal home was read. */
  readonly home: boolean
  /** Whether the sync read everything (no limit reached, nothing skipped). */
  readonly complete: boolean
}

/** The sync's own state. */
export interface SyncMeta {
  /** The account the copies follow, as `accountKeyOf` names it. */
  readonly account: string
  /** When the last sync that ran to the end finished. */
  readonly lastSyncAt?: number
  /** What it did. */
  readonly last?: SyncSummary
}

/** What the sync remembers about one copied list (liked songs, or a playlist). */
export interface ListState {
  /** The copy in the library. */
  readonly local: EntityId<'playlist'>
  /** What Spotify held at the last sync: base62 track IDs, in Spotify's order. */
  readonly base: readonly string[]
  /** Spotify's name for it at the last sync. */
  readonly name: string
  /** Spotify's description at the last sync. */
  readonly description?: string
  /** The URL of Spotify's cover at the last sync. */
  readonly artwork?: string
  /** A playlist's revision at the last sync: unchanged, the sync doesn't read it again. */
  readonly revision?: string
  /** How many items Spotify counted in liked songs at the last sync, local files included. */
  readonly total?: number
  /**
   * The copy's `updatedAt` right after the sync last wrote it. A later one means the user (or
   * library sync from another device) changed the copy since.
   */
  readonly written: number
  /**
   * The copy may hold the user's own changes: they changed it since the sync last wrote it, or
   * the sync found it already there (a backup, another device). Disconnecting never removes it.
   */
  readonly userTouched?: true
  /** The user deleted the copy: the sync doesn't make it again while Spotify keeps the list. */
  readonly dismissed?: true
  /** When the sync last read the list. */
  readonly syncedAt: number
}

/** What the library holds of the sync's state. */
export interface SyncState {
  readonly meta?: SyncMeta
  /** The copied lists, by `liked` or the playlist's Spotify ID. */
  readonly lists: ReadonlyMap<string, ListState>
}

/** The library calls the state needs: the settings rows. */
export interface StateStore {
  getSetting(key: string): Promise<JsonValue | undefined>
  getSettings(prefix: string): Promise<Map<string, JsonValue>>
  putSettings(values: Readonly<Record<string, JsonValue | undefined>>): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function shortText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= max ? value : undefined
}

function counter(value: unknown): number {
  return time(value) ?? 0
}

/** A summary read back, or `undefined`. */
export function sanitizeSummary(value: unknown): SyncSummary | undefined {
  if (!isRecord(value)) return undefined
  const at = time(value.at)
  if (at === undefined) return undefined
  return {
    at,
    likedCount: counter(value.likedCount),
    playlistCount: counter(value.playlistCount),
    created: counter(value.created),
    updated: counter(value.updated),
    added: counter(value.added),
    removed: counter(value.removed),
    dismissed: counter(value.dismissed),
    departed: counter(value.departed),
    skipped: counter(value.skipped),
    home: value.home === true,
    complete: value.complete === true,
  }
}

/** The sync's own state read back, or `undefined`. */
export function sanitizeMeta(value: unknown): SyncMeta | undefined {
  if (!isRecord(value) || !isAccountKey(value.account)) return undefined
  const lastSyncAt = time(value.lastSyncAt)
  const last = sanitizeSummary(value.last)
  return {
    account: value.account,
    ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
    ...(last === undefined ? {} : { last }),
  }
}

/** A copied list's state read back, or `undefined`. */
export function sanitizeList(value: unknown): ListState | undefined {
  if (!isRecord(value)) return undefined
  const { local } = value
  const name = shortText(value.name, 300)
  const written = time(value.written)
  const syncedAt = time(value.syncedAt)
  if (
    typeof local !== 'string' ||
    !isSpotifyCopyId(local) ||
    name === undefined ||
    written === undefined ||
    syncedAt === undefined ||
    !Array.isArray(value.base) ||
    value.base.length > MAX_REMEMBERED_TRACKS ||
    !value.base.every(isSpotifyNativeId)
  ) {
    return undefined
  }
  const description = shortText(value.description, 2000)
  const artwork = shortText(value.artwork, 2048)
  const revision = shortText(value.revision, 256)
  const total = time(value.total)
  return {
    local: local as EntityId<'playlist'>,
    base: [...new Set(value.base as string[])],
    name,
    written,
    syncedAt,
    ...(description === undefined ? {} : { description }),
    ...(artwork?.startsWith('https://') ? { artwork } : {}),
    ...(revision === undefined ? {} : { revision }),
    ...(total === undefined ? {} : { total }),
    ...(value.userTouched === true ? { userTouched: true as const } : {}),
    ...(value.dismissed === true ? { dismissed: true as const } : {}),
  }
}

/** Reads the sync's state from the library. Rows that can't be read count as missing. */
export async function readState(store: StateStore): Promise<SyncState> {
  const [meta, rows] = await Promise.all([
    store.getSetting(META_KEY),
    store.getSettings(LIST_PREFIX),
  ])
  const lists = new Map<string, ListState>()
  for (const [key, value] of rows) {
    const list = sanitizeList(value)
    if (list) lists.set(key.slice(LIST_PREFIX.length), list)
  }
  const sanitized = sanitizeMeta(meta)
  return sanitized === undefined ? { lists } : { meta: sanitized, lists }
}

/** Saves one copied list's state. */
export async function writeList(store: StateStore, list: string, state: ListState): Promise<void> {
  await store.putSettings({ [listKey(list)]: state as unknown as JsonValue })
}

/** Saves the sync's own state. */
export async function writeMeta(store: StateStore, meta: SyncMeta): Promise<void> {
  await store.putSettings({ [META_KEY]: meta as unknown as JsonValue })
}

/**
 * Forgets the copied lists named in `lists` (all when absent), so the sync no longer follows
 * them. Their copies stay in the library, as ordinary playlists.
 */
export async function forgetLists(store: StateStore, lists?: Iterable<string>): Promise<void> {
  const names = lists ?? [...(await store.getSettings(LIST_PREFIX)).keys()].map(stripListPrefix)
  const removals: Record<string, undefined> = {}
  for (const name of names) removals[listKey(name)] = undefined
  if (Object.keys(removals).length > 0) await store.putSettings(removals)
}

function stripListPrefix(key: string): string {
  return key.slice(LIST_PREFIX.length)
}
