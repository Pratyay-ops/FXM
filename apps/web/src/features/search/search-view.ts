import type { CatalogMode, SourceId } from '@fxm/core'
import { create } from 'zustand'
import type { TabItem } from '../../components/ui/tabs'
import { hasVideos } from './sources'

/** The result tabs of the search page. */
export type SearchTab = 'songs' | 'albums' | 'artists' | 'playlists' | 'videos'

/** The search type each tab asks the provider for. */
export const TAB_TYPES = {
  songs: 'track',
  albums: 'album',
  artists: 'artist',
  playlists: 'playlist',
  videos: 'video',
} as const satisfies Record<SearchTab, string>

const BASE_TABS: readonly TabItem<SearchTab>[] = [
  { value: 'songs', label: 'Songs' },
  { value: 'albums', label: 'Albums' },
  { value: 'artists', label: 'Artists' },
  { value: 'playlists', label: 'Playlists' },
]

const WITH_VIDEOS: readonly TabItem<SearchTab>[] = [
  ...BASE_TABS,
  { value: 'videos', label: 'Videos' },
]

/** The tabs for a mode and source: Videos only in Music + Video, for sources that have videos. */
export function searchTabs(mode: CatalogMode, source: SourceId): readonly TabItem<SearchTab>[] {
  return mode === 'all' && hasVideos(source) ? WITH_VIDEOS : BASE_TABS
}

/** Timing of the search page, in milliseconds. Tests may slow it down. */
export const searchTiming = {
  /** How long the query must stay unchanged before it is searched. */
  resultsDelayMs: 300,
  /** The same for suggestions, which are cheaper. */
  suggestionsDelayMs: 150,
  /**
   * How long a tab must stay selected before its results are fetched. Selection follows focus
   * in the tabs, so arrowing from Songs to Videos would otherwise search every tab on the way,
   * one provider call each from the shared request budget.
   */
  tabDelayMs: 250,
}

interface SearchViewState {
  /** The tab picked last. */
  tab: SearchTab
  /** The source picked last. */
  source: SourceId
  setTab: (tab: SearchTab) => void
  setSource: (source: SourceId) => void
}

/**
 * The search page's tab and source, kept for the session. The page's URL holds only the query
 * (the search box rewrites it on every keystroke), so this is what brings the user back to the
 * same tab after opening a result and going Back. A tab or source that no longer applies (Videos
 * in Music mode, Spotify switched off) falls back to Songs and YouTube Music without being
 * forgotten.
 */
export const useSearchView = create<SearchViewState>()((set) => ({
  tab: 'songs',
  source: 'ytm',
  setTab: (tab) => set({ tab }),
  setSource: (source) => set({ source }),
}))
