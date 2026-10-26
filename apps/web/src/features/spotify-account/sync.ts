/**
 * The read-only sync of a connected Spotify account into the library (stage 3.5): the account's
 * liked songs and playlists become copies in the library, and its personal home is kept for
 * Home's Spotify sections. FXM only reads from Spotify: nothing is ever written there.
 *
 * - **Copies.** Each playlist in the account's library gets a library playlist of its own, and
 *   its liked songs one more, "Liked songs on Spotify" (FXM's own Liked songs stay the user's).
 *   Their IDs come from what they copy (`ids.ts`), so a copy that came back from a backup or
 *   from another device is adopted, never made twice. New copies go to the end of the list of
 *   playlists, in Spotify's order.
 * - **One way, three ways.** Each sync brings in what changed on Spotify since the last one and
 *   keeps what the user changed in the copy (`merge.ts`): their order, the songs they added or
 *   took out, a new name.
 * - **Never deletes a copy.** A copy the user deleted stays deleted; a playlist that left the
 *   account's library keeps its copy, which the sync stops following.
 * - **Never takes what it can't read for empty.** A list that Spotify counts songs in but that
 *   gives the sync none it can read, or a playlist that Spotify won't give (gone, refused, an
 *   answer this version doesn't understand), is left out of this sync: its copy, and what the
 *   sync knows of it, stay as they were. Only a problem with the account or the session (the
 *   login, a rate limit, the network) stops the sync.
 * - **Little traffic.** A playlist whose revision didn't change isn't read again, and liked
 *   songs whose first page and count didn't change neither. Requests are paced (`pace`): one
 *   is made only to read something, and waits before it. Limits bound one run
 *   ({@link SYNC_LIMITS}), its number of requests too: the playlists it doesn't reach wait for
 *   the next run.
 * - **Another account.** When the browser's Spotify login is another account than the one the
 *   copies follow, the sync stops following the old copies (they stay, as ordinary playlists)
 *   and follows the new account's.
 *
 * Each copied list's state is saved as soon as the list is done (`state.ts`), so a sync that is
 * cut short (a closed tab, an error, its budget of requests) keeps what it did, and the next one
 * goes on from there.
 *
 * @module
 */

import {
  type Artwork,
  type EntityId,
  FxmError,
  isFxmError,
  type JsonValue,
  type Page,
  type PageOptions,
  type ProviderContext,
  type Shelf,
  type Track,
} from '@fxm/core'
import {
  isSpotifyError,
  type SpotifyAccountProfile,
  type SpotifyLibraryPlaylist,
  type SpotifyLikedTrack,
  type SpotifyPlaylistPage,
} from '@fxm/sources/spotify'
import type { LibraryRepo } from '../../db/repo'
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from '../../db/types'
import {
  accountKeyOf,
  HOME_KEY,
  LIKED_LIST,
  LIKED_NAME,
  likedCopyId,
  playlistCopyId,
  spotifyTrackId,
  spotifyTrackIdOf,
} from './ids'
import { adoptedBase, listChanges, mergedField, placeNewTracks } from './merge'
import {
  forgetLists,
  forgetState,
  type ListState,
  readState,
  type StateStore,
  type SyncSummary,
  writeList,
  writeMeta,
} from './state'

/** What the sync reads from Spotify: the Spotify provider's logged-in calls. */
export interface SyncSpotify {
  getAccountProfile(ctx: ProviderContext): Promise<SpotifyAccountProfile>
  getLibraryTracks(options: PageOptions, ctx: ProviderContext): Promise<Page<SpotifyLikedTrack>>
  getLibraryPlaylists(
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<SpotifyLibraryPlaylist>>
  getLibraryPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<SpotifyPlaylistPage>
  getAccountHome(ctx: ProviderContext): Promise<Shelf[]>
}

/** What the sync writes into: the library repository (stage 2.6). */
export type SyncLibrary = Pick<
  LibraryRepo,
  | 'getPlaylistList'
  | 'getPlaylistView'
  | 'createPlaylist'
  | 'updatePlaylist'
  | 'addTracks'
  | 'removeTracks'
  | 'setOrder'
  | 'deletePlaylist'
  | 'getSetting'
  | 'getSettings'
  | 'putSettings'
>

/** How much one sync reads at most. */
export interface SyncLimits {
  /** Liked songs. */
  readonly likedSongs: number
  /** Playlists in the account's library. */
  readonly playlists: number
  /** Tracks of one playlist (Spotify's own cap is 10,000). */
  readonly playlistTracks: number
  /**
   * Requests to Spotify. Checked before each playlist the sync reads: the playlists it hasn't
   * reached by then wait for the next run, which goes on from there. Liked songs, read first,
   * are read whole, and a playlist once begun too.
   */
  readonly requests: number
}

/**
 * The limits the app uses. Liked songs take at most 201 requests and the list of playlists 52,
 * so one run always gets to some playlists.
 */
export const SYNC_LIMITS: SyncLimits = Object.freeze({
  likedSongs: 10_000,
  playlists: 500,
  playlistTracks: 10_000,
  requests: 300,
})

/** Where a sync stands, for Settings. */
export interface SyncProgress {
  /** What it reads now. */
  readonly step: 'account' | 'liked' | 'playlists' | 'home'
  /** Playlists done, while it copies playlists. */
  readonly done?: number
  /** Playlists in all, while it copies playlists. */
  readonly total?: number
}

/** Options for {@link runSpotifySync}. */
export interface SyncOptions {
  /** A provider context for one call. The sync's signal goes in `signal`, not in here. */
  readonly context: () => ProviderContext
  /** Stops the sync between two requests; what is done stays. */
  readonly signal?: AbortSignal
  /**
   * Whether the sync may still write its state. Asked right before each write of it: once it
   * says no (the account was disconnected), the sync stops there, with an `AbortError`, and
   * writes no more of it. Default: always.
   */
  readonly guard?: () => boolean
  /** Waits before each request that reads something, so a sync never hurries Spotify. */
  readonly pace?: (signal?: AbortSignal) => Promise<void>
  /** Called as the sync moves on. */
  readonly onProgress?: (progress: SyncProgress) => void
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number
  /** Lower limits, for tests. */
  readonly limits?: Partial<SyncLimits>
}

/** What a sync did. */
export interface SyncResult {
  /** The account it synced, as `accountKeyOf` names it. */
  readonly account: string
  /** The account's display name, when Spotify gives one. */
  readonly displayName?: string
  /** What it did. */
  readonly summary: SyncSummary
}

/** The personal home, as the sync keeps it for Home. */
export interface HomeCopy {
  /** The account it belongs to. */
  readonly account: string
  /** When it was read, as epoch milliseconds. */
  readonly at: number
  /** Its sections. */
  readonly shelves: readonly Shelf[]
}

interface Counters {
  created: number
  updated: number
  added: number
  removed: number
  dismissed: number
  departed: number
  skipped: number
  pending: number
  complete: boolean
}

/** What one copied list is, on Spotify, now. */
interface RemoteList {
  /** Its tracks, once each, in Spotify's order. */
  readonly tracks: readonly Track[]
  readonly name: string
  readonly description?: string
  readonly artwork: readonly Artwork[]
  readonly revision?: string
  readonly total?: number
}

/** A copy as the list of playlists shows it, for the checks that need no tracks. */
interface CopySummary {
  readonly updatedAt: number
}

/** A name as the library stores it. */
function cleanName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH).trim()
}

/** A description as the library stores it, or `undefined` for none. */
function cleanDescription(description: string | undefined): string | undefined {
  const clean = description?.trim().slice(0, MAX_DESCRIPTION_LENGTH).trim()
  return clean === '' ? undefined : clean
}

/** `tracks` once each, by ID, keeping the first. Only Spotify's tracks count. */
function uniqueSpotifyTracks(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    const id = spotifyTrackIdOf(track.id)
    if (id === undefined || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Whether `items` are the first of `base`, in its order. */
function startsWith(base: readonly string[], items: readonly string[]): boolean {
  return items.length <= base.length && items.every((id, index) => base[index] === id)
}

/**
 * Whether a list the sync read no song from is one it couldn't read, rather than an empty one:
 * Spotify counts items in it, or, when it doesn't count them, the copy followed songs before.
 * The sync then leaves the copy as it is, instead of taking every song out of it.
 */
function unreadable(readable: number, total: number | undefined, before: number): boolean {
  return readable === 0 && (total === undefined ? before > 0 : total > 0)
}

/**
 * Whether an error is about one playlist only, so the sync goes on without it: it went away,
 * Spotify refused it, or answered for it in a way this version can't read. Errors about the
 * account or the session (the login, a rate limit, the network, a changed operation, an
 * unexpected HTTP status) stop the sync instead.
 */
function isAboutOnePlaylist(error: unknown): boolean {
  return (
    isFxmError(error, 'NotFound') ||
    isSpotifyError(error, 'graphql') ||
    isSpotifyError(error, 'bad-response') ||
    isSpotifyError(error, 'forbidden')
  )
}

/** The error the sync stops with once its guard says it may no longer write. */
function disconnected(): DOMException {
  return new DOMException('The Spotify account was disconnected', 'AbortError')
}

/** The library's settings, with the guard asked right before each write. */
function guardedStore(library: SyncLibrary, guard: (() => boolean) | undefined): StateStore {
  return {
    getSetting: (key) => library.getSetting(key),
    getSettings: (prefix) => library.getSettings(prefix),
    putSettings(values) {
      if (guard !== undefined && !guard()) return Promise.reject(disconnected())
      return library.putSettings(values)
    },
  }
}

/** `spotify`, counting its calls: each is one request (or none, when the provider has it). */
function counting(spotify: SyncSpotify): { spotify: SyncSpotify; used: () => number } {
  let used = 0
  return {
    used: () => used,
    spotify: {
      getAccountProfile(ctx) {
        used += 1
        return spotify.getAccountProfile(ctx)
      },
      getLibraryTracks(options, ctx) {
        used += 1
        return spotify.getLibraryTracks(options, ctx)
      },
      getLibraryPlaylists(options, ctx) {
        used += 1
        return spotify.getLibraryPlaylists(options, ctx)
      },
      getLibraryPlaylistTracks(id, options, ctx) {
        used += 1
        return spotify.getLibraryPlaylistTracks(id, options, ctx)
      },
      getAccountHome(ctx) {
        used += 1
        return spotify.getAccountHome(ctx)
      },
    },
  }
}

/**
 * Syncs the connected account into the library (see the module documentation).
 *
 * @throws The Spotify provider's errors about the account or the session (`SpotifyError`: not
 * logged in, the account not usable, paused, a changed operation, the network), the library's
 * (`LibraryError`, a full disk), an `FxmError` `Parse` when Spotify doesn't say which account is
 * logged in, the signal's reason when it was aborted, and an `AbortError` once the guard says no.
 * What was done until then stays.
 */
export async function runSpotifySync(
  provider: SyncSpotify,
  library: SyncLibrary,
  options: SyncOptions,
): Promise<SyncResult> {
  const { signal } = options
  const now = options.now ?? Date.now
  const limits: SyncLimits = { ...SYNC_LIMITS, ...options.limits }
  const ctx = () => {
    const context = options.context()
    return signal === undefined ? context : { ...context, signal }
  }
  const check = () => signal?.throwIfAborted()
  const pace = async () => {
    check()
    await options.pace?.(signal)
    check()
  }
  const progress = (step: SyncProgress) => options.onProgress?.(step)
  const { spotify, used } = counting(provider)
  const store = guardedStore(library, options.guard)
  const reader: Reader = { ctx, pace, limits, used, aborted: () => signal?.aborted === true }

  progress({ step: 'account' })
  const profile = await spotify.getAccountProfile(ctx())
  if (profile.username === undefined) {
    throw new FxmError('Parse', "Spotify didn't say which account is logged in")
  }
  const account = await accountKeyOf(profile.username)
  check()
  let state = await readState(library)
  if (state.meta?.account !== account) {
    // Another account (or the first): the copies of the one before stay, as ordinary
    // playlists, and the sync follows this account's from now on.
    await forgetState(store)
    await writeMeta(store, { account })
    state = { meta: { account }, lists: new Map() }
  }

  const counters: Counters = {
    created: 0,
    updated: 0,
    added: 0,
    removed: 0,
    dismissed: 0,
    departed: 0,
    skipped: 0,
    pending: 0,
    complete: true,
  }
  const copies = await copySummaries(library)
  const sync: ListSync = {
    library,
    store,
    lists: new Map(state.lists),
    copies,
    counters,
    tried: 0,
    read: 0,
  }

  // Liked songs.
  progress({ step: 'liked' })
  await syncLiked(spotify, sync, likedCopyId(account), reader)

  // Playlists.
  progress({ step: 'playlists' })
  const listing = await listPlaylists(spotify, reader, counters)
  const { listed } = listing
  const seen = new Set<string>()
  for (const [index, item] of listed.entries()) {
    check()
    progress({ step: 'playlists', done: index, total: listed.length })
    const spotifyId = item.playlist.id.slice('spotify:playlist:'.length)
    seen.add(spotifyId)
    await syncPlaylist(spotify, sync, item, spotifyId, reader)
  }
  progress({ step: 'playlists', done: listed.length, total: listed.length })
  if (listing.complete) {
    // Playlists that left the account's library: the sync stops following them, and their
    // copies stay. Only a listing read to its end can tell, whatever else this run left out.
    const departed = [...sync.lists.keys()].filter((list) => list !== LIKED_LIST && !seen.has(list))
    await forgetLists(store, departed)
    for (const list of departed) sync.lists.delete(list)
    counters.departed = departed.length
  }

  // The personal home, for Home's Spotify sections.
  progress({ step: 'home' })
  check()
  let home = true
  try {
    const shelves = await spotify.getAccountHome(ctx())
    await writeHome(store, { account, at: now(), shelves })
  } catch (error) {
    // The copies are done: a home that can't be read now leaves Home's sections as they were.
    if (signal?.aborted || (error as { name?: unknown })?.name === 'AbortError') throw error
    home = false
  }

  const liked = sync.lists.get(LIKED_LIST)
  const likedCopy = liked !== undefined && liked.dismissed !== true
  const summary: SyncSummary = {
    at: now(),
    likedCopy,
    likedCount: likedCopy ? liked.base.length : 0,
    playlistCount: [...sync.lists].filter(
      ([list, entry]) => list !== LIKED_LIST && entry.dismissed !== true,
    ).length,
    ...counters,
    // A budget spent on playlists that all failed: going on soon would only fail again, so the
    // next sync comes at the usual time, and the summary says what couldn't be read.
    pending: sync.tried > 0 && sync.read === 0 ? 0 : counters.pending,
    home,
  }
  await writeMeta(store, { account, lastSyncAt: summary.at, last: summary })
  return profile.displayName === undefined
    ? { account, summary }
    : { account, displayName: profile.displayName, summary }
}

/** The library's playlists that could be copies, by ID. */
async function copySummaries(library: SyncLibrary): Promise<Map<string, CopySummary>> {
  const { items } = await library.getPlaylistList()
  return new Map(
    items
      .filter((item) => item.origin === 'local')
      .map((item) => [item.id, { updatedAt: item.updatedAt }]),
  )
}

/** What syncing one list needs. */
interface ListSync {
  /** The library, for the copies. */
  readonly library: SyncLibrary
  /** The library's settings, for the sync's state: guarded. */
  readonly store: StateStore
  /** The copied lists, as this run leaves them so far. */
  readonly lists: Map<string, ListState>
  readonly copies: ReadonlyMap<string, CopySummary>
  readonly counters: Counters
  /** Playlists this run set out to read. */
  tried: number
  /** Playlists this run read and brought into their copies. */
  read: number
}

interface Reader {
  readonly ctx: () => ProviderContext
  readonly pace: () => Promise<void>
  readonly limits: SyncLimits
  /** Requests made so far in this run. */
  readonly used: () => number
  readonly aborted: () => boolean
}

/** Saves a copied list's state, and keeps it for the rest of the run. */
async function remember(sync: ListSync, list: string, state: ListState): Promise<void> {
  await writeList(sync.store, list, state)
  sync.lists.set(list, state)
}

/** Leaves a list out of this run: its copy and its state stay as they were. */
function skip(sync: ListSync): void {
  sync.counters.skipped += 1
  sync.counters.complete = false
}

async function syncLiked(
  spotify: SyncSpotify,
  sync: ListSync,
  local: EntityId<'playlist'>,
  { ctx, pace, limits }: Reader,
): Promise<void> {
  const known = sync.lists.get(LIKED_LIST)
  const following = known !== undefined && known.local === local
  if (following && known.dismissed === true && !sync.copies.has(local)) {
    // The user deleted the copy: it stays deleted, and the liked songs needn't be read.
    sync.counters.dismissed += 1
    return
  }
  const first = await spotify.getLibraryTracks({ limit: 50 }, ctx())
  const firstIds = first.items.flatMap(({ track }) => spotifyTrackIdOf(track.id) ?? [])
  if (
    following &&
    known.dismissed !== true &&
    first.total !== undefined &&
    known.total === first.total &&
    startsWith(known.base, firstIds)
  ) {
    // Unchanged on Spotify: the newest likes and the count are the same. Only a check that the
    // copy is still there, and whether the user changed it.
    if (first.total > limits.likedSongs) sync.counters.complete = false
    await checkUnchanged(sync, LIKED_LIST, known)
    return
  }
  const liked: Track[] = first.items.map(({ track }) => track)
  let cursor = first.nextCursor
  // Not one of the newest likes readable: Spotify answered in a way this version can't read,
  // and the rest would be the same.
  if (liked.length === 0 && (first.total ?? 0) > 0) cursor = undefined
  for (let pages = 1; cursor !== undefined && liked.length < limits.likedSongs; pages++) {
    if (pages > Math.ceil(limits.likedSongs / 50)) break
    await pace()
    const page = await spotify.getLibraryTracks({ limit: 50, cursor }, ctx())
    liked.push(...page.items.map(({ track }) => track))
    cursor = page.nextCursor
  }
  const tracks = uniqueSpotifyTracks(liked).slice(0, limits.likedSongs)
  const before = following && known.dismissed !== true ? known.base.length : 0
  if (unreadable(tracks.length, first.total, before)) {
    skip(sync)
    return
  }
  if (cursor !== undefined || liked.length > limits.likedSongs) sync.counters.complete = false
  await applyList(sync, LIKED_LIST, local, {
    tracks,
    name: LIKED_NAME,
    artwork: [],
    ...(first.total === undefined ? {} : { total: first.total }),
  })
}

/**
 * The playlists of the account's library, once each, up to the limit, and whether the listing
 * was read to its end, so that it tells which playlists left the library.
 */
async function listPlaylists(
  spotify: SyncSpotify,
  { ctx, pace, limits }: Reader,
  counters: Counters,
): Promise<{ listed: SpotifyLibraryPlaylist[]; complete: boolean }> {
  const listed: SpotifyLibraryPlaylist[] = []
  const ids = new Set<string>()
  let complete = true
  let total: number | undefined
  let cursor: string | undefined
  for (let pages = 0; pages === 0 || cursor !== undefined; pages++) {
    if (pages > limits.playlists / 10 + 1 || listed.length >= limits.playlists) {
      complete = false
      break
    }
    if (pages > 0) await pace()
    const page = await spotify.getLibraryPlaylists(cursor === undefined ? {} : { cursor }, ctx())
    total ??= page.total
    for (const item of page.items) {
      if (ids.has(item.playlist.id)) continue
      ids.add(item.playlist.id)
      listed.push(item)
    }
    cursor = page.nextCursor
  }
  if (listed.length > limits.playlists) {
    complete = false
    counters.skipped += listed.length - limits.playlists
  }
  // Items Spotify counts, but not one playlist the sync can read: they may all be playlists in
  // a shape this version doesn't understand, so the listing can't tell which ones left.
  if (listed.length === 0 && (total ?? 0) > 0) complete = false
  if (!complete) counters.complete = false
  return { listed: listed.slice(0, limits.playlists), complete }
}

async function syncPlaylist(
  spotify: SyncSpotify,
  sync: ListSync,
  item: SpotifyLibraryPlaylist,
  spotifyId: string,
  reader: Reader,
): Promise<void> {
  const local = playlistCopyId(spotifyId)
  const known = sync.lists.get(spotifyId)
  const following = known !== undefined && known.local === local
  if (following && known.dismissed === true && !sync.copies.has(local)) {
    // The user deleted the copy: it stays deleted, and the playlist needn't be read.
    sync.counters.dismissed += 1
    return
  }
  if (
    following &&
    known.dismissed !== true &&
    item.revisionId !== undefined &&
    known.revision === item.revisionId
  ) {
    // Unchanged on Spotify since the last sync.
    await checkUnchanged(sync, spotifyId, known)
    return
  }
  if (reader.used() >= reader.limits.requests) {
    // This run made as many requests as one may: the next one reads this playlist.
    sync.counters.pending += 1
    return
  }
  sync.tried += 1
  let read: PlaylistRead
  try {
    read = await readPlaylist(spotify, item, reader)
  } catch (error) {
    if (reader.aborted() || !isAboutOnePlaylist(error)) throw error
    // Gone since it was listed, refused, or unreadable: the other playlists go on.
    skip(sync)
    return
  }
  const { limits } = reader
  const tracks = uniqueSpotifyTracks(read.tracks).slice(0, limits.playlistTracks)
  const before = following && known.dismissed !== true ? known.base.length : 0
  if (unreadable(tracks.length, read.total, before)) {
    skip(sync)
    return
  }
  if (!read.complete) sync.counters.complete = false
  const { name, description, artwork } = item.playlist
  await applyList(sync, spotifyId, local, {
    tracks,
    name,
    ...(description === undefined ? {} : { description }),
    artwork,
    ...(read.revision === undefined ? {} : { revision: read.revision }),
  })
  sync.read += 1
}

/** What reading a playlist's pages got. */
interface PlaylistRead {
  /** Its tracks, in Spotify's order, up to the limit. */
  readonly tracks: readonly Track[]
  /** Its revision, from the listing or its first page. */
  readonly revision?: string
  /** How many items Spotify counts in it, from its first page. */
  readonly total?: number
  /** Whether every page was read. */
  readonly complete: boolean
}

/** Reads a playlist's pages, each after a pause. */
async function readPlaylist(
  spotify: SyncSpotify,
  item: SpotifyLibraryPlaylist,
  { ctx, pace, limits }: Reader,
): Promise<PlaylistRead> {
  const tracks: Track[] = []
  let revision = item.revisionId
  let total: number | undefined
  let complete = true
  let cursor: string | undefined
  for (let pages = 0; pages === 0 || cursor !== undefined; pages++) {
    if (tracks.length >= limits.playlistTracks || pages >= Math.ceil(limits.playlistTracks / 100)) {
      complete = false
      break
    }
    await pace()
    const page = await spotify.getLibraryPlaylistTracks(
      item.playlist.id,
      cursor === undefined ? {} : { cursor },
      ctx(),
    )
    tracks.push(...page.tracks.items)
    revision ??= page.revisionId
    if (pages === 0) total = page.tracks.total
    cursor = page.tracks.nextCursor
    // Not one of its first songs readable: Spotify answered in a way this version can't read,
    // and the rest would be the same.
    if (pages === 0 && tracks.length === 0 && (total ?? 0) > 0) cursor = undefined
  }
  return {
    tracks,
    ...(revision === undefined ? {} : { revision }),
    ...(total === undefined ? {} : { total }),
    complete,
  }
}

/**
 * A list Spotify didn't change: the copy is left alone, but a copy the user deleted is marked so,
 * and one the user changed since the sync last wrote it is remembered as theirs too. Nothing is
 * written when nothing changed.
 */
async function checkUnchanged(sync: ListSync, list: string, known: ListState): Promise<void> {
  const copy = sync.copies.get(known.local)
  if (copy === undefined) {
    sync.counters.dismissed += 1
    await remember(sync, list, { ...known, dismissed: true })
    return
  }
  if (known.userTouched !== true && copy.updatedAt > known.written) {
    await remember(sync, list, { ...known, userTouched: true })
  }
}

/** Brings a list's changes on Spotify into its copy, making the copy when there is none. */
async function applyList(
  sync: ListSync,
  list: string,
  local: EntityId<'playlist'>,
  remote: RemoteList,
): Promise<void> {
  const { library, counters } = sync
  const known = sync.lists.get(list)
  const name = cleanName(remote.name) || LIKED_NAME
  const description = cleanDescription(remote.description)
  const cover = remote.artwork[0]?.url
  const remoteIds = remote.tracks.flatMap((track) => spotifyTrackIdOf(track.id) ?? [])
  const keep = (fields: Omit<ListState, 'local' | 'name' | 'base'>) =>
    remember(sync, list, {
      local,
      base: remoteIds,
      name,
      ...(description === undefined ? {} : { description }),
      ...(cover === undefined ? {} : { artwork: cover }),
      ...(remote.revision === undefined ? {} : { revision: remote.revision }),
      ...(remote.total === undefined ? {} : { total: remote.total }),
      ...fields,
    })

  const following = known !== undefined && known.local === local
  if (!sync.copies.has(local)) {
    if (following && known.dismissed !== true) {
      // The user deleted the copy since the last sync: it stays deleted.
      counters.dismissed += 1
      await remember(sync, list, { ...known, dismissed: true })
      return
    }
    if (following) {
      counters.dismissed += 1
      return
    }
    await library.createPlaylist({
      id: local,
      name,
      ...(description === undefined ? {} : { description }),
      tracks: remote.tracks,
      artwork: remote.artwork,
      position: 'bottom',
    })
    counters.created += 1
    counters.added += remote.tracks.length
    await keep({ written: await updatedAt(library, local) })
    return
  }

  const view = await library.getPlaylistView(local)
  if (view === undefined) {
    // Deleted in the moment since the list of playlists was read: next time.
    skip(sync)
    return
  }
  const { playlist } = view
  // A copy the sync finds without a record (a backup, another device or account) is adopted.
  const adopted = !following || known.dismissed === true
  // Read now, not when the run began: the user may have changed the copy since.
  const touched = adopted || known.userTouched === true || playlist.updatedAt > known.written
  const localIds = playlist.trackIds.flatMap((id) => spotifyTrackIdOf(id) ?? [])
  const base = adopted ? adoptedBase(remoteIds, localIds) : known.base
  const { added, removed } = listChanges(base, remoteIds, localIds)
  let wrote = false
  if (removed.length > 0) {
    counters.removed += await library.removeTracks(local, removed.map(spotifyTrackId))
    wrote = true
  }
  if (added.length > 0) {
    const fresh = new Set(added)
    const byId = new Map(remote.tracks.map((track) => [spotifyTrackIdOf(track.id), track]))
    const tracks = added.flatMap((id) => byId.get(id) ?? [])
    counters.added += (await library.addTracks(local, tracks)).added
    const removing = new Set(removed.map(spotifyTrackId) as string[])
    const order = placeNewTracks(
      [...playlist.trackIds.filter((id) => !removing.has(id)), ...added.map(spotifyTrackId)],
      remoteIds.map(spotifyTrackId),
      new Set([...fresh].map(spotifyTrackId)),
    )
    await library.setOrder(local, order)
    wrote = true
  }
  // Details: Spotify's change wins unless the user changed the copy's too.
  const nextName = mergedField(known?.name, name, playlist.name, adopted)
  const nextDescription = mergedField(
    known?.description,
    description,
    playlist.description,
    adopted,
  )
  const localCover = playlist.artwork?.[0]?.url
  const nextCover = mergedField(known?.artwork, cover, localCover, adopted)
  const details: { name?: string; description?: string; artwork?: readonly Artwork[] } = {}
  if (nextName !== playlist.name) details.name = nextName
  if (nextDescription !== playlist.description) details.description = nextDescription ?? ''
  if (nextCover !== localCover) details.artwork = nextCover === cover ? remote.artwork : []
  if (Object.keys(details).length > 0) {
    await library.updatePlaylist(local, details)
    wrote = true
  }
  if (wrote) counters.updated += 1
  await keep({
    written: wrote ? await updatedAt(library, local) : (known?.written ?? 0),
    ...(touched ? { userTouched: true as const } : {}),
  })
}

/** When a playlist last changed. */
async function updatedAt(library: SyncLibrary, id: EntityId<'playlist'>): Promise<number> {
  return (await library.getPlaylistView(id))?.playlist.updatedAt ?? 0
}

/** Keeps the account's personal home for Home. */
export async function writeHome(
  store: Pick<StateStore, 'putSettings'>,
  home: HomeCopy,
): Promise<void> {
  await store.putSettings({ [HOME_KEY]: home as unknown as JsonValue })
}

/** What {@link forgetSync} did to the copies. */
export interface ForgetResult {
  /** Copies it deleted. */
  readonly removed: number
  /** Copies that stay in the library. */
  readonly kept: number
}

/**
 * Stops following the account (Settings → Disconnect): forgets the sync's state and the
 * personal home. The copies stay in the library, as ordinary playlists. With `removeCopies`,
 * the copies the sync made and nobody changed since are deleted; a copy the user changed, or
 * that the sync found already there, always stays.
 */
export async function forgetSync(
  library: SyncLibrary,
  { removeCopies = false }: { removeCopies?: boolean } = {},
): Promise<ForgetResult> {
  const state = await readState(library)
  let removed = 0
  let kept = 0
  const copies = await copySummaries(library)
  for (const list of state.lists.values()) {
    const copy = copies.get(list.local)
    if (copy === undefined) continue
    if (removeCopies && list.userTouched !== true && copy.updatedAt <= list.written) {
      await library.deletePlaylist(list.local)
      removed += 1
    } else {
      kept += 1
    }
  }
  await forgetState(library)
  return { removed, kept }
}
