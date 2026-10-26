import { create } from 'zustand'

/** How a list of tracks is shown: its saved custom order, or sorted by a field. */
export type TrackSortKey = 'custom' | 'title' | 'artist' | 'album' | 'added' | 'duration'

/** How the list of playlists is shown. */
export type PlaylistSortKey = 'custom' | 'name' | 'added' | 'tracks'

export type SortDirection = 'asc' | 'desc'

/** A sort view. `custom` ignores the direction: it is the saved order. */
export interface SortView<K extends string> {
  key: K
  direction: SortDirection
}

export const CUSTOM_VIEW = { key: 'custom', direction: 'asc' } as const

/** The direction a sort starts in: newest first for dates, A to Z and shortest first otherwise. */
export function defaultDirection(key: string): SortDirection {
  return key === 'added' ? 'desc' : 'asc'
}

interface LibraryViewState {
  /** Sort views of track lists, by playlist ID. Missing means custom order. */
  trackViews: Record<string, SortView<TrackSortKey>>
  /** The sort view of the list of playlists, shared by the sidebar and the Library page. */
  playlistView: SortView<PlaylistSortKey>
  setTrackView: (listId: string, view: SortView<TrackSortKey>) => void
  setPlaylistView: (view: SortView<PlaylistSortKey>) => void
}

/**
 * Sort views are a way of looking at a list, not a change to it: they last for the session,
 * and "Custom order" is where every list starts. "Save as custom order" makes one permanent.
 */
export const useLibraryViewStore = create<LibraryViewState>()((set) => ({
  trackViews: {},
  playlistView: CUSTOM_VIEW,
  setTrackView: (listId, view) =>
    set((state) => ({ trackViews: { ...state.trackViews, [listId]: view } })),
  setPlaylistView: (view) => set({ playlistView: view }),
}))

/** The sort view of one track list. */
export function useTrackView(listId: string): SortView<TrackSortKey> {
  return useLibraryViewStore((state) => state.trackViews[listId] ?? CUSTOM_VIEW)
}
