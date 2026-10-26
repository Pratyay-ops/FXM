/**
 * Test helpers for the Spotify account feature: Spotify tracks and playlists made up for the
 * tests, and a fake Spotify account behind the provider's logged-in calls (the sync's
 * `SyncSpotify`), whose library the tests change between syncs. No network, no real account.
 *
 * @module
 */

import {
  type Artwork,
  type EntityId,
  FxmError,
  type NetworkCapabilities,
  type Platform,
  type Shelf,
  type Track,
} from '@fxm/core'
import type { SpotifyLibraryPlaylist, SpotifyLikedTrack } from '@fxm/sources/spotify'
import type { LockManagerLike } from './locks'
import type { SpotifyAccountServices } from './services'
import type { SyncLibrary, SyncSpotify } from './sync'

/**
 * A made-up Spotify base62 ID: `0`, a letter and 20 digits. The leading `0` keeps it within the
 * 128 bits a real one has, which the provider checks.
 */
export function nativeId(prefix: string, n: number): string {
  return `0${prefix}${String(n).padStart(20, '0')}`
}

/** A made-up Spotify song, "Spotify song n" by "Spotify artist n". */
export function spotifyTrack(n: number, overrides: Partial<Track> = {}): Track {
  const id = nativeId('t', n)
  return {
    id: `spotify:track:${id}` as EntityId<'track'>,
    source: 'spotify',
    title: `Spotify song ${n}`,
    artists: [{ name: `Spotify artist ${n}` }],
    album: { name: `Spotify album ${n}` },
    durationMs: 200_000 + n,
    artwork: [],
    kind: 'song',
    externalIds: { spotify: id },
    ...overrides,
  }
}

/** Songs `from` to `to`, made up. */
export function spotifyTracks(from: number, to: number): Track[] {
  return Array.from({ length: to - from + 1 }, (_, index) => spotifyTrack(from + index))
}

/** A playlist of the fake account. */
export interface FakePlaylist {
  /** Its base62 ID. */
  id: string
  name: string
  description?: string
  artwork?: Artwork[]
  tracks: Track[]
  /** Its revision. Default: one that changes with its name, description and tracks. */
  revision?: string | null
  /** Whether the user may view it. Default yes. */
  canView?: boolean
}

/** The fake account's data, which tests change between syncs. */
export interface FakeAccountData {
  /** The account's user name, `undefined` to leave it out of the profile. */
  username?: string | undefined
  displayName?: string
  /** Liked songs, newest first. */
  liked: { track: Track; addedAt?: string }[]
  /** Liked items that aren't songs (local files): Spotify counts them, FXM can't read them. */
  likedOthers?: number
  playlists: FakePlaylist[]
  home: Shelf[]
}

/** A short hash, for revisions. */
function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function revisionOf(playlist: FakePlaylist): string | undefined {
  if (playlist.revision === null) return undefined
  return (
    playlist.revision ??
    `rev-${hash(JSON.stringify([playlist.name, playlist.description, playlist.tracks.map((t) => t.id)]))}`
  )
}

/** A fake account and the calls the sync made to it. */
export interface FakeAccount {
  /** The sync's view of the account. */
  readonly spotify: SyncSpotify
  /** Change it between syncs. */
  readonly data: FakeAccountData
  /** Every call, e.g. `profile`, `liked 0`, `playlists 50`, `tracks <id> 100`, `home`. */
  readonly calls: string[]
  /** A call that fails, by its name (`profile`, `liked`, `playlists`, `tracks <id>`, `home`). */
  readonly failures: Map<string, unknown>
  /**
   * Calls whose pages hold nothing the provider could read, though Spotify still counts the
   * items (`liked`, `playlists`, `tracks <id>`): as when Spotify changed the shape of its items.
   */
  readonly blank: Set<string>
}

/** A fake account with two playlists and three liked songs, unless told otherwise. */
export function fakeAccount(overrides: Partial<FakeAccountData> = {}): FakeAccount {
  const data: FakeAccountData = {
    username: 'fixture-user',
    displayName: 'Fixture User',
    liked: spotifyTracks(1, 3).map((track) => ({ track })),
    playlists: [
      {
        id: nativeId('p', 1),
        name: 'Road trip',
        description: 'Loud',
        tracks: spotifyTracks(11, 14),
      },
      { id: nativeId('p', 2), name: 'Quiet', tracks: spotifyTracks(21, 22) },
    ],
    home: [
      {
        id: 'spotify:section:made-for-you',
        title: 'Made for Fixture User',
        items: [{ type: 'track', track: spotifyTrack(31) }],
      },
    ],
    ...overrides,
  }
  const calls: string[] = []
  const failures = new Map<string, unknown>()
  const blank = new Set<string>()
  const fail = (name: string) => {
    if (failures.has(name)) throw failures.get(name)
  }
  /** The page's items, or none when the call answers blank. */
  const readable = <T>(name: string, items: T[]): T[] => (blank.has(name) ? [] : items)
  const offsetOf = (cursor: string | undefined) => (cursor === undefined ? 0 : Number(cursor))
  const spotify: SyncSpotify = {
    async getAccountProfile() {
      calls.push('profile')
      fail('profile')
      return {
        ...(data.username === undefined ? {} : { username: data.username }),
        ...(data.displayName === undefined ? {} : { displayName: data.displayName }),
      }
    },
    async getLibraryTracks({ cursor, limit = 50 }, ctx) {
      const offset = offsetOf(cursor)
      calls.push(`liked ${offset}`)
      fail('liked')
      ctx.signal?.throwIfAborted()
      const total = data.liked.length + (data.likedOthers ?? 0)
      const items: SpotifyLikedTrack[] = readable('liked', data.liked.slice(offset, offset + limit))
      const next = offset + limit
      return { items, total, ...(next < total ? { nextCursor: String(next) } : {}) }
    },
    async getLibraryPlaylists({ cursor }, ctx) {
      const offset = offsetOf(cursor)
      calls.push(`playlists ${offset}`)
      fail('playlists')
      ctx.signal?.throwIfAborted()
      const visible = data.playlists.filter((p) => p.canView !== false && p.revision !== null)
      const page = readable('playlists', visible.slice(offset, offset + 50))
      const items: SpotifyLibraryPlaylist[] = page.map((p) => {
        const revisionId = revisionOf(p)
        return {
          playlist: {
            id: `spotify:playlist:${p.id}` as EntityId<'playlist'>,
            source: 'spotify',
            name: p.name,
            ...(p.description === undefined ? {} : { description: p.description }),
            artwork: p.artwork ?? [],
            trackCount: p.tracks.length,
          },
          ...(revisionId === undefined ? {} : { revisionId }),
        }
      })
      const next = offset + 50
      return {
        items,
        total: data.playlists.length,
        ...(next < data.playlists.length ? { nextCursor: String(next) } : {}),
      }
    },
    async getLibraryPlaylistTracks(id, { cursor, limit = 100 }, ctx) {
      const native = id.slice('spotify:playlist:'.length)
      const offset = offsetOf(cursor)
      calls.push(`tracks ${native} ${offset}`)
      fail(`tracks ${native}`)
      ctx.signal?.throwIfAborted()
      const playlist = data.playlists.find((p) => p.id === native)
      if (!playlist) throw new FxmError('NotFound', `No playlist ${native}`)
      const next = offset + limit
      const revisionId = revisionOf(playlist)
      return {
        tracks: {
          items: readable(`tracks ${native}`, playlist.tracks.slice(offset, offset + limit)),
          total: playlist.tracks.length,
          ...(next < playlist.tracks.length ? { nextCursor: String(next) } : {}),
        },
        ...(revisionId === undefined ? {} : { revisionId }),
      }
    },
    async getAccountHome() {
      calls.push('home')
      fail('home')
      return structuredClone(data.home)
    },
  }
  return { spotify, data, calls, failures, blank }
}

/** What {@link fakeServices} gives a test: the services and the handles to change them. */
export interface FakeServices {
  readonly services: SpotifyAccountServices
  readonly account: FakeAccount
  /** The provider's account switches, as the runtime called them. */
  readonly switches: string[]
  /** How often the runtime asked to detect FXM Connect again. */
  readonly refreshes: string[]
  /** Whether the browser's Spotify login works: `status` answers so. */
  loggedIn: boolean | Error
  /** Changes the capabilities, as a new detection would. */
  setCapabilities(spotify: NetworkCapabilities['spotify'], platform?: Platform): void
  /** Switches Spotify on or off. */
  setEnabled(enabled: boolean): void
}

/**
 * Services over a fake account and the given library: the web app with FXM Connect and its
 * Spotify login on, Spotify switched on, the user logged in.
 */
export function fakeServices(
  library: SyncLibrary,
  account: FakeAccount = fakeAccount(),
): FakeServices {
  let capabilities: NetworkCapabilities = {
    youtube: 'full',
    spotify: 'account',
    mediaBytes: true,
    fileSystem: false,
  }
  let platform: Platform = 'web'
  let enabled = true
  const listeners = new Set<() => void>()
  const switches: string[] = []
  const refreshes: string[] = []
  const fake: FakeServices = {
    account,
    switches,
    refreshes,
    loggedIn: true,
    setCapabilities(spotify, nextPlatform = platform) {
      capabilities = { ...capabilities, spotify }
      platform = nextPlatform
      for (const listener of [...listeners]) listener()
    },
    setEnabled(next) {
      enabled = next
      for (const listener of [...listeners]) listener()
    },
    services: {
      spotify: {
        ...account.spotify,
        async status() {
          account.calls.push('status')
          if (fake.loggedIn instanceof Error) throw fake.loggedIn
          return fake.loggedIn
            ? {
                connected: true,
                ...(account.data.displayName ? { displayName: account.data.displayName } : {}),
              }
            : { connected: false }
        },
        connect: () => {
          switches.push('connect')
        },
        disconnect: () => {
          switches.push('disconnect')
        },
      },
      library,
      context: (_priority, signal) => ({
        fetch: () => Promise.reject(new Error('The account tests never fetch')),
        platform,
        capabilities,
        mode: 'all',
        ...(signal === undefined ? {} : { signal }),
      }),
      capabilities: () => capabilities,
      refresh: async () => {
        refreshes.push('refresh')
      },
      spotifyEnabled: () => enabled,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
  return fake
}

/** Web Locks for one tab, which a test can hold "in another tab". */
export function fakeLocks() {
  const held = new Set<string>()
  const locks: LockManagerLike & { held: Set<string> } = {
    held,
    async request(name, options, callback) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null)
        await new Promise<void>((resolve, reject) => {
          const timer = setInterval(() => {
            if (!held.has(name)) {
              clearInterval(timer)
              resolve()
            }
          }, 5)
          options.signal?.addEventListener('abort', () => {
            clearInterval(timer)
            reject(options.signal?.reason)
          })
        })
      }
      held.add(name)
      try {
        return await callback({ name })
      } finally {
        held.delete(name)
      }
    },
  }
  return locks
}
