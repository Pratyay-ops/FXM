/**
 * TanStack Query hooks over the registered providers: search, suggestions, and the album,
 * artist and playlist pages. Every call gets a `ProviderContext` from the sources (the
 * platform's `fetch`, the capabilities, the catalog mode, the user's locale) with the query's
 * abort signal, so a search the user typed past is cancelled.
 *
 * Query keys hold the source, the catalog mode and the tier (with the platform's revision), so
 * a mode switch, a new tier or a new platform never shows results made for the other.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type EntityId,
  isFxmError,
  type MetadataProvider,
  type Page,
  type Playlist,
  type ProviderContext,
  type SearchResults,
  type SearchType,
  type SourceId,
  type Track,
} from '@fxm/core'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useSettingsStore } from '../settings/settings-store'
import { canSuggest, type SourcesSnapshot } from './sources'
import { useSources, useSourcesSnapshot } from './sources-context'

/** Results per search page. */
export const SEARCH_PAGE_SIZE = 20

/** Tracks per further playlist page. */
export const PLAYLIST_PAGE_SIZE = 100

/** A provider to call, with the source it answers for. */
export interface SearchTarget {
  readonly source: SourceId
  readonly provider: MetadataProvider
}

/** The items each search type returns. */
export interface SearchItems {
  track: Track
  video: Track
  album: Album
  artist: Artist
  playlist: Playlist
}

const PAGE_OF: { [K in SearchType]: (results: SearchResults) => Page<SearchItems[K]> | undefined } =
  {
    track: (results) => results.tracks,
    video: (results) => results.videos,
    album: (results) => results.albums,
    artist: (results) => results.artists,
    playlist: (results) => results.playlists,
  }

/** The page of `type` in `results`, or an empty page when the provider left it out. */
export function pageOf<K extends SearchType>(
  results: SearchResults,
  type: K,
): Page<SearchItems[K]> {
  return PAGE_OF[type](results) ?? { items: [] }
}

/** Retry once, and only after a network error: the other errors would just repeat. */
function retryNetworkOnce(failures: number, error: unknown): boolean {
  return failures < 1 && isFxmError(error, 'Network')
}

/** The user's language and region, e.g. `en-IN` and `IN`, for `hl` and `gl`. */
function userLocale(): { locale?: string; region?: string } {
  const locale = typeof navigator === 'undefined' ? undefined : navigator.language
  if (!locale) return {}
  try {
    const region = new Intl.Locale(locale).region
    return region ? { locale, region } : { locale }
  } catch {
    return {}
  }
}

/**
 * A tier label for query keys: the platform's revision, then YouTube and Spotify reach, e.g.
 * `1:simple/unreachable`.
 */
function tierKey({ platformRevision, capabilities }: SourcesSnapshot): string {
  return `${platformRevision}:${capabilities.youtube}/${capabilities.spotify}`
}

/** Builds the context for one provider call, in the current catalog mode. */
function useCallContext(): {
  context: (signal: AbortSignal) => ProviderContext
  mode: ProviderContext['mode']
  tier: string
} {
  const sources = useSources()
  const snapshot = useSourcesSnapshot()
  const mode = useSettingsStore((state) => state.catalogMode)
  return {
    context: (signal) => sources.context({ mode, signal, ...userLocale() }),
    mode,
    tier: tierKey(snapshot),
  }
}

/**
 * One type of search results, a page at a time (`fetchNextPage` loads more). While `enabled` is
 * false nothing is fetched, but results fetched before still show.
 */
export function useSearchResults<K extends SearchType>(
  target: SearchTarget,
  type: K,
  query: string,
  enabled = true,
) {
  const { context, mode, tier } = useCallContext()
  const active = enabled && query !== ''
  return useInfiniteQuery({
    queryKey: ['catalog', 'search', target.source, tier, mode, type, query],
    queryFn: async ({ pageParam, signal }) => {
      const results = await target.provider.search(
        query,
        {
          types: [type],
          limit: SEARCH_PAGE_SIZE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        context(signal),
      )
      return pageOf(results, type)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: active,
    // While the next query loads, keep showing the results of the one before it. Only then:
    // TanStack Query also shows placeholder data for a query that is switched off.
    placeholderData: (previous) => (active ? previous : undefined),
    retry: retryNetworkOnce,
    retryDelay: 800,
  })
}

/**
 * Completions for what the user is typing, from the source's provider, if it has any and may be
 * asked as the user types (`canSuggest`).
 */
export function useSuggestions(target: SearchTarget | undefined, query: string) {
  const { context, mode, tier } = useCallContext()
  const suggest =
    target && canSuggest(target.provider)
      ? target.provider.suggest?.bind(target.provider)
      : undefined
  const active = suggest !== undefined && query !== ''
  return useQuery({
    queryKey: ['catalog', 'suggest', target?.source, tier, mode, query],
    queryFn: ({ signal }) => (suggest ? suggest(query, context(signal)) : Promise.resolve([])),
    enabled: active,
    // The completions before stay while the next ones load, but never for a provider that has
    // none: placeholder data shows for a switched-off query too.
    placeholderData: (previous) => (active ? previous : undefined),
    staleTime: 10 * 60_000,
    retry: false,
  })
}

/** An album with its tracks. */
export function useAlbum(id: EntityId<'album'>, provider: MetadataProvider) {
  const { context, mode, tier } = useCallContext()
  return useQuery({
    queryKey: ['catalog', 'album', id, tier, mode],
    queryFn: ({ signal }) => provider.getAlbum(id, context(signal)),
    retry: retryNetworkOnce,
    retryDelay: 800,
  })
}

/** An artist's page: top tracks, releases and, from some sources, similar artists. */
export function useArtist(id: EntityId<'artist'>, provider: MetadataProvider) {
  const { context, mode, tier } = useCallContext()
  return useQuery({
    queryKey: ['catalog', 'artist', id, tier, mode],
    queryFn: ({ signal }) => provider.getArtist(id, context(signal)),
    retry: retryNetworkOnce,
    retryDelay: 800,
  })
}

/**
 * Similar artists, for sources that list them apart from the artist page. Only runs when
 * `enabled`, i.e. when the artist page had none.
 */
export function useRelatedArtists(
  id: EntityId<'artist'>,
  provider: MetadataProvider,
  enabled: boolean,
) {
  const { context, mode, tier } = useCallContext()
  const related = provider.getRelatedArtists?.bind(provider)
  return useQuery({
    queryKey: ['catalog', 'related-artists', id, tier, mode],
    queryFn: ({ signal }) => (related ? related(id, context(signal)) : Promise.resolve([])),
    enabled: enabled && related !== undefined,
    retry: false,
  })
}

/** One page of a playlist: the first also holds the playlist itself. */
export interface PlaylistPage {
  readonly playlist?: Playlist
  readonly tracks: Page<Track>
}

/** A playlist and its tracks, a page at a time (`fetchNextPage` loads more). */
export function usePlaylist(id: EntityId<'playlist'>, provider: MetadataProvider) {
  const { context, mode, tier } = useCallContext()
  return useInfiniteQuery({
    queryKey: ['catalog', 'playlist', id, tier, mode],
    queryFn: async ({ pageParam, signal }): Promise<PlaylistPage> => {
      if (pageParam === undefined) {
        const playlist = await provider.getPlaylist(id, context(signal))
        return { playlist, tracks: playlist.tracks ?? { items: [] } }
      }
      if (!provider.getPlaylistTracks) return { tracks: { items: [] } }
      const tracks = await provider.getPlaylistTracks(
        id,
        { cursor: pageParam, limit: PLAYLIST_PAGE_SIZE },
        context(signal),
      )
      return { tracks }
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.tracks.nextCursor,
    retry: retryNetworkOnce,
    retryDelay: 800,
  })
}
