/**
 * Fake {@link MediaActions}: a player that records what it was asked to do, an in-memory list
 * of playlists, and stand-ins for downloads and the equalizer. Tests use them, and so does the
 * development-only fake mode. The real ones come from stages 2.2/2.3, 2.6, 4.1 and 8.1.
 *
 * @module
 */

import type { Track } from '@fxm/core'
import type { LibraryPlaylist, MediaActions, PlayOptions } from './actions'

/** One recorded action. */
export type FakeAction =
  | { readonly action: 'play'; readonly tracks: readonly Track[]; readonly options: PlayOptions }
  | {
      readonly action: 'playNext' | 'addToQueue' | 'download'
      readonly tracks: readonly Track[]
    }
  | {
      readonly action: 'addToPlaylist'
      readonly playlistId: string
      readonly tracks: readonly Track[]
    }
  | { readonly action: 'createPlaylist'; readonly name: string; readonly tracks: readonly Track[] }
  | { readonly action: 'equalizer'; readonly track?: Track }

/** Fake actions, with every group present and a log of what was asked. */
export interface FakeMediaActions extends Required<MediaActions> {
  /** Every action so far, oldest first. */
  readonly log: FakeAction[]
}

/** Options for {@link createFakeMediaActions}. */
export interface FakeMediaActionsOptions {
  /** The user's playlists to start with. */
  playlists?: readonly LibraryPlaylist[]
  /** Called with a short description of every action, e.g. to show it in development. */
  onAction?: (description: string) => void
}

/** The playlists of the sidebar's placeholders, so the fake mode matches the shell. */
export const FAKE_LIBRARY_PLAYLISTS: readonly LibraryPlaylist[] = [
  { id: 'chill-mix', name: 'Chill mix', trackCount: 24 },
  { id: 'focus-flow', name: 'Focus flow', trackCount: 41 },
  { id: 'workout', name: 'Workout', trackCount: 18 },
  { id: 'road-trip', name: 'Road trip', trackCount: 57 },
]

const songs = (count: number) => `${count} ${count === 1 ? 'song' : 'songs'}`

/** Creates fake actions; see the module documentation. */
export function createFakeMediaActions(options: FakeMediaActionsOptions = {}): FakeMediaActions {
  const log: FakeAction[] = []
  const playlists = (options.playlists ?? FAKE_LIBRARY_PLAYLISTS).map((playlist) => ({
    ...playlist,
  }))
  const record = (action: FakeAction, description: string) => {
    log.push(action)
    options.onAction?.(description)
  }

  return {
    log,
    playback: {
      play(tracks, playOptions = {}) {
        const first = tracks[playOptions.startIndex ?? 0]
        record(
          { action: 'play', tracks: [...tracks], options: playOptions },
          `${playOptions.shuffle ? 'shuffling' : 'playing'} ${first?.title ?? songs(tracks.length)}`,
        )
      },
      playNext(tracks) {
        record({ action: 'playNext', tracks: [...tracks] }, `${songs(tracks.length)} next`)
      },
      addToQueue(tracks) {
        record({ action: 'addToQueue', tracks: [...tracks] }, `${songs(tracks.length)} queued`)
      },
    },
    library: {
      playlists: async () => playlists.map((playlist) => ({ ...playlist })),
      async addToPlaylist(playlistId, tracks) {
        const index = playlists.findIndex((playlist) => playlist.id === playlistId)
        const playlist = playlists[index]
        if (!playlist) throw new Error(`No playlist ${playlistId}`)
        playlists[index] = { ...playlist, trackCount: (playlist.trackCount ?? 0) + tracks.length }
        record(
          { action: 'addToPlaylist', playlistId, tracks: [...tracks] },
          `added to ${playlist.name}`,
        )
      },
      async createPlaylist(name, tracks) {
        const playlist = { id: `fake-${playlists.length + 1}`, name, trackCount: tracks.length }
        playlists.push(playlist)
        record({ action: 'createPlaylist', name, tracks: [...tracks] }, `created ${name}`)
        return { ...playlist }
      },
    },
    downloads: {
      download(tracks) {
        record({ action: 'download', tracks: [...tracks] }, `downloading ${songs(tracks.length)}`)
      },
    },
    equalizer: {
      open(track) {
        record({ action: 'equalizer', ...(track ? { track } : {}) }, 'equalizer opened')
      },
    },
  }
}
