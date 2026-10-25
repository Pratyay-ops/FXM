/**
 * The library's seams (stage 2.6), wired through the interfaces the other stages defined:
 *
 * - **Add to playlist** on the catalog pages: 2.4's `LibraryActions`, from the repository's
 *   playlists ({@link libraryActionsFrom});
 * - **the match cache** under the playback policy: 2.3's `MatchStore`, from the repository's
 *   match cache, with the lossless decisions, which it has no key for, in memory
 *   ({@link matchStoreFrom}).
 *
 * {@link LibraryRepository} is the part of 2.6's `LibraryRepo` (`getLibrary()` in `src/db/`)
 * these use, declared by shape so this module builds before 2.6 is on `develop`; its repository
 * then fits as it is. Likes (2.5's like button), the listening history (3.1's play recorder) and
 * the Downloads playlist (4.1) connect to the repository directly, not through here.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  isEntityId,
  type MatchSignals,
  type Track,
} from '@fxm/core'
import {
  createMemoryMatchStore,
  type MatchKey,
  type MatchStore,
  sanitizeStoredMatch,
} from '@fxm/player'
import type { LibraryActions, LibraryPlaylist } from '../../features/search/actions'

/** One playlist as the library lists it (2.6's `PlaylistSummary`, as far as needed here). */
export interface LibraryPlaylistSummary {
  readonly id: EntityId<'playlist'>
  /** `local`: one of the library's own; `followed`: another source's playlist. */
  readonly origin: 'local' | 'followed'
  /** Set on the built-in playlists. */
  readonly system?: 'liked' | 'downloads'
  readonly name: string
  readonly trackCount?: number
}

/** A matching decision as the library stores it (2.6's `MatchDecision`). */
export interface LibraryMatchDecision {
  sourceTrackId: EntityId<'track'>
  mode: CatalogMode
  band: 'auto' | 'suggest' | 'none'
  candidate?: AudioCandidate
  alternatives?: AudioCandidate[]
  signals?: MatchSignals
  evidence?: string[]
}

/** The part of stage 2.6's library repository that the seams here use. */
export interface LibraryRepository {
  /** Every playlist, in the saved custom order. */
  getPlaylistList(): Promise<{ readonly items: readonly LibraryPlaylistSummary[] }>
  /** Appends tracks to a playlist (Liked songs likes them; Downloads refuses). */
  addTracks(playlistId: EntityId<'playlist'>, tracks: readonly Track[]): Promise<unknown>
  /** Creates a playlist with `tracks`, at the top of the list. Returns its ID. */
  createPlaylist(input: { name: string; tracks?: readonly Track[] }): Promise<EntityId<'playlist'>>
  /** The cached decision for a source track in `mode`, a guess included. */
  getMatch(sourceTrackId: EntityId<'track'>, mode: CatalogMode): Promise<unknown>
  /** Stores the engine's decision; a pin always wins. */
  recordMatch(decision: LibraryMatchDecision): Promise<boolean>
  /** Pins the user's choice. */
  pinMatch(
    sourceTrackId: EntityId<'track'>,
    mode: CatalogMode,
    candidate: AudioCandidate,
  ): Promise<void>
  /** Removes the user's pin. */
  unpinMatch(sourceTrackId: EntityId<'track'>, mode: CatalogMode): Promise<void>
  /** Forgets an engine decision, never a pin. */
  forgetMatch(sourceTrackId: EntityId<'track'>, mode: CatalogMode): Promise<boolean>
}

/**
 * 2.4's add-to-playlist actions over the library: the library's own playlists, Liked songs
 * included (adding there likes the tracks). Downloads is left out: only the download manager
 * fills it. Followed playlists belong to their source.
 */
export function libraryActionsFrom(
  library: Pick<LibraryRepository, 'getPlaylistList' | 'addTracks' | 'createPlaylist'>,
): LibraryActions {
  return {
    async playlists() {
      const { items } = await library.getPlaylistList()
      return items
        .filter((playlist) => playlist.origin === 'local' && playlist.system !== 'downloads')
        .map(
          (playlist): LibraryPlaylist => ({
            id: playlist.id,
            name: playlist.name,
            ...(playlist.trackCount === undefined ? {} : { trackCount: playlist.trackCount }),
          }),
        )
    },
    async addToPlaylist(playlistId, tracks) {
      if (!isEntityId(playlistId, 'playlist')) throw new RangeError(`No playlist ${playlistId}`)
      await library.addTracks(playlistId, tracks)
    },
    async createPlaylist(name, tracks) {
      const id = await library.createPlaylist({ name, tracks })
      return { id, name, trackCount: tracks.length }
    },
  }
}

/**
 * 2.3's match store over the library's match cache. The song decision is the cache's record
 * for the track and mode; a pin goes through `pinMatch`, an engine decision through
 * `recordMatch`, and removing one through `unpinMatch` (a pin, which only the user removes) or
 * `forgetMatch`. Lossless decisions have no key there, so they stay in `lossless`.
 */
export function matchStoreFrom(
  library: Pick<
    LibraryRepository,
    'getMatch' | 'recordMatch' | 'pinMatch' | 'unpinMatch' | 'forgetMatch'
  >,
  lossless: MatchStore = createMemoryMatchStore(),
): MatchStore {
  const read = async ({ sourceTrackId, mode }: MatchKey) =>
    sanitizeStoredMatch(await library.getMatch(sourceTrackId, mode))
  return {
    async get(key) {
      return key.target === 'song' ? read(key) : lossless.get(key)
    },
    async put(key, match) {
      if (key.target !== 'song') return lossless.put(key, match)
      const { sourceTrackId, mode } = key
      if (match.userPinned && match.candidate !== undefined) {
        await library.pinMatch(sourceTrackId, mode, match.candidate)
        return
      }
      await library.recordMatch({
        sourceTrackId,
        mode,
        band: match.band,
        ...(match.candidate === undefined ? {} : { candidate: match.candidate }),
        alternatives: [...match.alternatives],
        ...(match.signals === undefined ? {} : { signals: match.signals }),
        evidence: [...match.evidence],
      })
    },
    async delete(key) {
      if (key.target !== 'song') return lossless.delete(key)
      const { sourceTrackId, mode } = key
      const stored = await read(key)
      if (stored?.userPinned) await library.unpinMatch(sourceTrackId, mode)
      else await library.forgetMatch(sourceTrackId, mode)
    },
  }
}
