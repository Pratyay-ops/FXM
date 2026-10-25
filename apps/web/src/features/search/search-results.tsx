import {
  applyModeFilter,
  type EntityId,
  type Page,
  type SearchType,
  type SourceId,
  type Track,
} from '@fxm/core'
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'
import { Search, SearchX } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { placeholderKeys, Skeleton } from '../../components/ui/skeleton'
import { TabPanel, Tabs } from '../../components/ui/tabs'
import { cn } from '../../lib/cn'
import { useSettingsStore } from '../settings/settings-store'
import { useMediaActions } from './actions'
import { AlbumList, ArtistList, PlaylistList } from './catalog/entity-list'
import { uniqueById } from './catalog/format'
import { InlineError, Notice, SourceUnavailable } from './catalog/states'
import { TrackList } from './catalog/track-list'
import { type SearchTarget, useSearchResults, useSuggestions } from './queries'
import { type SearchTab, searchTabs, useSearchView } from './search-view'
import { searchSourceIds, sourceAvailability, sourceLabel } from './sources'
import { useSourcesSnapshot } from './sources-context'

/**
 * The source the search page uses: the one picked last if it is still offered, else YouTube
 * Music (e.g. after Spotify was switched off), with the list to pick from.
 */
export function useSearchSource() {
  const snapshot = useSourcesSnapshot()
  const options = searchSourceIds(snapshot)
  const picked = useSearchView((state) => state.source)
  const source: SourceId = options.includes(picked) ? picked : 'ytm'
  return { source, options, availability: sourceAvailability(snapshot, source) }
}

/**
 * Completions for the query as the user types, as links that search for them. `typed` is the
 * query once it has paused for `searchTiming.suggestionsDelayMs`.
 */
function Suggestions({
  query,
  typed,
  target,
}: {
  query: string
  typed: string
  target: SearchTarget
}) {
  const suggestions = useSuggestions(target, typed)
  const current = query.toLocaleLowerCase()
  const items = (suggestions.data ?? [])
    .filter((suggestion) => suggestion.toLocaleLowerCase() !== current)
    .slice(0, 6)
  if (items.length === 0) return null
  return (
    <nav
      aria-label="Search suggestions"
      className="-mx-gutter overflow-x-auto px-gutter scrollbar-none"
    >
      <ul className="flex gap-2 py-1.5">
        {items.map((suggestion) => (
          <li key={suggestion} className="shrink-0">
            <Link
              to={`/search?q=${encodeURIComponent(suggestion)}`}
              replace
              preventScrollReset
              className="relative inline-flex h-9 items-center gap-2 rounded-full border border-border-strong/60 px-3.5 text-sm whitespace-nowrap transition-colors after:absolute after:inset-x-0 after:-inset-y-1 hover:border-border-strong hover:bg-text/6"
            >
              <Search aria-hidden="true" className="size-4 text-text-muted" />
              {suggestion}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** Placeholder rows while the first page of results loads. */
function RowsSkeleton({
  shape = 'square',
  wide = false,
}: {
  shape?: 'square' | 'circle'
  wide?: boolean
}) {
  return (
    <div>
      <span className="sr-only">Loading results…</span>
      <ul aria-hidden="true" className="space-y-0.5">
        {placeholderKeys(6, 'result').map((key) => (
          <li key={key} className="flex min-h-16 items-center gap-3 px-2 py-1.5 sm:gap-4">
            <Skeleton
              className={cn(
                'shrink-0',
                wide ? 'aspect-video w-24 rounded-sm sm:w-28' : 'size-12',
                !wide && (shape === 'circle' ? 'rounded-full' : 'rounded-sm'),
              )}
            />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-3/5 max-w-72 rounded-full" />
              <Skeleton className="h-3 w-2/5 max-w-48 rounded-full" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

type ResultsQuery<T> = UseInfiniteQueryResult<InfiniteData<Page<T>, unknown>, unknown>

/**
 * The states of one tab of results: loading, failed, empty, or the list with "Show more".
 * While a newer query loads, the previous results stay, dimmed.
 */
function ResultsFrame<T extends { readonly id: EntityId }>({
  results,
  source,
  query,
  noun,
  skeleton,
  children,
}: {
  results: ResultsQuery<T>
  source: SourceId
  query: string
  /** What the tab lists, in the plural: `songs`, `albums` … */
  noun: string
  skeleton: ReactNode
  children: (items: T[]) => ReactNode
}) {
  if (results.data === undefined) {
    return results.isError ? (
      <InlineError error={results.error} source={source} onRetry={() => void results.refetch()} />
    ) : (
      skeleton
    )
  }
  const items = uniqueById(results.data.pages.flatMap((page) => page.items))
  if (items.length === 0) {
    return results.isError ? (
      <InlineError error={results.error} source={source} onRetry={() => void results.refetch()} />
    ) : (
      <Notice icon={SearchX} headingLevel={3} title={`No ${noun} found`} className="py-10">
        <p>
          Nothing on {sourceLabel(source)} matches “{query}”. Check the spelling, or try another
          tab.
        </p>
      </Notice>
    )
  }
  return (
    <div
      aria-busy={results.isPlaceholderData}
      className={cn('space-y-4 transition-opacity', results.isPlaceholderData && 'opacity-60')}
    >
      {children(items)}
      {results.isFetchNextPageError ? (
        <InlineError
          error={results.error}
          source={source}
          onRetry={() => void results.fetchNextPage()}
        />
      ) : (
        results.hasNextPage && (
          <div className="flex justify-center">
            <button
              type="button"
              disabled={results.isFetchingNextPage}
              onClick={() => void results.fetchNextPage()}
              className={buttonClasses({ variant: 'secondary' })}
            >
              {results.isFetchingNextPage ? 'Loading…' : `Show more ${noun}`}
            </button>
          </div>
        )
      )}
    </div>
  )
}

function TrackResults({
  target,
  query,
  type,
}: {
  target: SearchTarget
  query: string
  type: Extract<SearchType, 'track' | 'video'>
}) {
  const results = useSearchResults(target, type, query)
  const mode = useSettingsStore((state) => state.catalogMode)
  const { playback } = useMediaActions()
  const noun = type === 'track' ? 'songs' : 'videos'
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun={noun}
      skeleton={<RowsSkeleton wide={type === 'video'} />}
    >
      {(items: Track[]) => {
        const tracks = applyModeFilter(items, mode)
        return (
          <TrackList
            tracks={tracks}
            label={type === 'track' ? 'Songs' : 'Videos'}
            showAlbum
            onPlay={
              playback
                ? (index) =>
                    playback.play(tracks, {
                      startIndex: index,
                      context: { type: 'search', id: query, title: query },
                    })
                : undefined
            }
          />
        )
      }}
    </ResultsFrame>
  )
}

function AlbumResults({ target, query }: { target: SearchTarget; query: string }) {
  const results = useSearchResults(target, 'album', query)
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun="albums"
      skeleton={<RowsSkeleton />}
    >
      {(albums) => <AlbumList albums={albums} />}
    </ResultsFrame>
  )
}

function ArtistResults({ target, query }: { target: SearchTarget; query: string }) {
  const results = useSearchResults(target, 'artist', query)
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun="artists"
      skeleton={<RowsSkeleton shape="circle" />}
    >
      {(artists) => <ArtistList artists={artists} />}
    </ResultsFrame>
  )
}

function PlaylistResults({ target, query }: { target: SearchTarget; query: string }) {
  const results = useSearchResults(target, 'playlist', query)
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun="playlists"
      skeleton={<RowsSkeleton />}
    >
      {(playlists) => <PlaylistList playlists={playlists} />}
    </ResultsFrame>
  )
}

function TabResults({
  tab,
  target,
  query,
}: {
  tab: SearchTab
  target: SearchTarget
  query: string
}) {
  switch (tab) {
    case 'songs':
      return <TrackResults target={target} query={query} type="track" />
    case 'videos':
      return <TrackResults target={target} query={query} type="video" />
    case 'albums':
      return <AlbumResults target={target} query={query} />
    case 'artists':
      return <ArtistResults target={target} query={query} />
    case 'playlists':
      return <PlaylistResults target={target} query={query} />
  }
}

/**
 * The results of a query: suggestions, then a tab per type. Typing updates the URL, and so
 * `query`, at once; `typed` and `searched` follow once the query has paused (see
 * `searchTiming`), so suggestions and results are fetched only then. When the source can't be
 * reached (no YouTube in the Free-only tier), the onboarding entry point takes the place of the
 * results.
 */
export function SearchResults({
  query,
  typed,
  searched,
}: {
  /** The query as it is now, which the heading shows. */
  query: string
  /** The query to suggest completions for. */
  typed: string
  /** The query to search for. Empty until the first one has paused. */
  searched: string
}) {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const { source, availability } = useSearchSource()
  const tabs = searchTabs(catalogMode, source)
  const picked = useSearchView((state) => state.tab)
  const setTab = useSearchView((state) => state.setTab)
  // Switching to Music mode while on Videos falls back to Songs.
  const tab = tabs.some((item) => item.value === picked) ? picked : 'songs'
  const tabsId = useId()
  const headingId = useId()

  return (
    <>
      {availability.status === 'available' && (
        <Suggestions
          query={query}
          typed={typed}
          target={{ source, provider: availability.provider }}
        />
      )}
      <section aria-labelledby={headingId} className="space-y-4">
        <h2 id={headingId} className="text-xl font-bold tracking-tight break-words md:text-2xl">
          Results for “{query}”
        </h2>
        <Tabs label="Result type" items={tabs} value={tab} onChange={setTab} id={tabsId} />
        <TabPanel id={tabsId} value={tab} className="min-h-40">
          {availability.status === 'available' ? (
            <TabResults
              key={`${source}:${tab}`}
              tab={tab}
              target={{ source, provider: availability.provider }}
              query={searched}
            />
          ) : (
            <SourceUnavailable availability={availability} source={source} />
          )}
        </TabPanel>
      </section>
    </>
  )
}
