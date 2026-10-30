/**
 * What search and the album, artist and playlist pages can do with tracks: play them, queue
 * them, add them to a playlist, download them, open the equalizer. Each group comes from a stage
 * that is built in parallel, so this module is their adapter: an interface per group, and
 * `fake-actions.ts` as the fake that tests and the dev fake catalog use.
 *
 * - `playback`: the player facade of stage 2.2 (`playbackFromPlayer`), which plays once 2.3's
 *   playback policy resolves its streams
 * - `library`: the user's playlists, stage 2.6
 * - `downloads`: the download manager, stage 4.1
 * - `equalizer`: the audio effects, stage 8.1
 *
 * Every group is optional. The UI offers an action only when its group is there, so the app
 * shows no buttons that do nothing; wiring a stage in makes its actions appear.
 *
 * @module
 */

import type { QueueContext, Track } from '@fxm/core'
import type { Player } from '@fxm/player'
import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from 'react'

/**
 * Options for {@link PlaybackActions.play}: the subset of the player facade's `setQueue`
 * options that the catalog pages use.
 */
export interface PlayOptions {
  /** Index in `tracks` of the track to start with. Default: the first. */
  readonly startIndex?: number
  /** Play in shuffled order (the shuffle button). */
  readonly shuffle?: boolean
  /** What the tracks come from, shown as "Playing from …" and linked back to. */
  readonly context?: QueueContext
}

/**
 * Playback, as the player facade of stage 2.2 does it. Call these straight from the click or
 * key press that asked for them: the browser lets audio start only from a user gesture.
 */
export interface PlaybackActions {
  /** Replaces the queue with `tracks` and plays. */
  play(tracks: readonly Track[], options?: PlayOptions): void
  /** Inserts `tracks` after the current track. */
  playNext(tracks: readonly Track[]): void
  /** Appends `tracks` to the queue. */
  addToQueue(tracks: readonly Track[]): void
}

/** The part of the player facade (`Player` in `@fxm/player`) that playback uses. */
export type QueuePlayer = Pick<Player, 'setQueue' | 'playNext' | 'addToQueue'>

/**
 * Playback through the app's player facade, e.g.
 * `appActions.set({ ...appActions.get(), playback: playbackFromPlayer(player) })`.
 */
export function playbackFromPlayer(player: QueuePlayer): PlaybackActions {
  return {
    // The facade never rejects: failures show up in its state and events.
    play: (tracks, options = {}) => void player.setQueue(tracks, options),
    playNext: (tracks) => player.playNext(tracks),
    addToQueue: (tracks) => player.addToQueue(tracks),
  }
}

/** One of the user's playlists, as the add-to-playlist dialog lists it. */
export interface LibraryPlaylist {
  /** The playlist's ID in the library. */
  readonly id: string
  /** Its name. */
  readonly name: string
  /** How many tracks it holds, when known. */
  readonly trackCount?: number
}

/** The user's playlists: the library of stage 2.6. */
export interface LibraryActions {
  /** The user's playlists, in their saved order. */
  playlists(): Promise<LibraryPlaylist[]>
  /** Appends `tracks` to a playlist. */
  addToPlaylist(playlistId: string, tracks: readonly Track[]): Promise<void>
  /** Creates a playlist holding `tracks`. */
  createPlaylist(name: string, tracks: readonly Track[]): Promise<LibraryPlaylist>
}

/** Downloads: the download manager of stage 4.1. */
export interface DownloadActions {
  /**
   * Downloads `tracks`: the Download dialog, which also saves a file, or an offline copy only,
   * as Settings says. Call it straight from the click. `title` names a collection (an album, a
   * playlist) in the dialog.
   */
  download(tracks: readonly Track[], title?: string): void
}

/** The equalizer: the audio effects of stage 8.1. */
export interface EqualizerActions {
  /** Opens the equalizer, for `track` when given. */
  open(track?: Track): void
}

/** Everything the catalog pages can do with tracks. Each group is there once its stage is. */
export interface MediaActions {
  /** Play, play next, add to queue. */
  readonly playback?: PlaybackActions
  /** Add to playlist. */
  readonly library?: LibraryActions
  /** Download. */
  readonly downloads?: DownloadActions
  /** Equalizer. */
  readonly equalizer?: EqualizerActions
}

/** Holds the current {@link MediaActions}, so they can be wired in after the app started. */
export interface MediaActionsStore {
  /** The current actions. The same object until {@link MediaActionsStore.set} is called. */
  get(): MediaActions
  /** Replaces the actions. */
  set(actions: MediaActions): void
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** Creates a {@link MediaActionsStore}. */
export function createMediaActionsStore(initial: MediaActions = {}): MediaActionsStore {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(actions) {
      current = actions
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * The app's actions. Empty until the player (2.2, 2.3), the library (2.6), downloads (4.1) and
 * the equalizer (8.1) are wired in with `appActions.set({ playback, library, … })`.
 */
export const appActions: MediaActionsStore = createMediaActionsStore()

const MediaActionsContext = createContext<MediaActionsStore>(appActions)

/** Provides other actions to the pages below it: tests pass the fake ones. */
export function MediaActionsProvider({
  actions,
  children,
}: {
  actions: MediaActions | MediaActionsStore
  children: ReactNode
}) {
  const [store] = useState(() =>
    'subscribe' in actions ? actions : createMediaActionsStore(actions),
  )
  return <MediaActionsContext value={store}>{children}</MediaActionsContext>
}

/** The actions available here; re-renders when they change. */
export function useMediaActions(): MediaActions {
  const store = useContext(MediaActionsContext)
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
