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
import { type ReactNode, useId, useRef } from 'react'
import { flushSync } from 'react-dom'
import { Link } from 'react-router'
import { placeholderKeys, Skeleton } from '../../components/ui/skeleton'
import { TabPanel, Tabs } from '../../components/ui/tabs'
import { cn } from '../../lib/cn'
import { useSettingsStore } from '../settings/settings-store'
import { useMediaActions } from './actions'
import { AlbumList, ArtistList, PlaylistList } from './catalog/entity-list'
import { countLabel, uniqueById } from './catalog/format'
import { ShowMoreButton, useShowMore } from './catalog/show-more'
import { InlineError, Notice, SourceUnavailable } from './catalog/states'
import { TrackList } from './catalog/track-list'
import { type SearchTarget, useSearchResults, useSuggestions } from './queries'
import { type SearchTab, searchTabs, searchTiming, useSearchView } from './search-view'
import { canSuggest, searchSourceIds, sourceAvailability, sourceLabel } from './sources'
import { useSourcesSnapshot } from './sources-context'
import { useDebouncedValue } from './use-debounced-value'

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

/** Widths of the placeholder chips while the first suggestions load. */
const SUGGESTION_PLACEHOLDERS = ['w-28', 'w-36', 'w-24', 'w-32'] as const

/**
 * Completions for the query as the user types, as links that search for them. `typed` is the
 * query once it has paused for `searchTiming.suggestionsDelayMs`. The row keeps its height while
 * they load and when there are none, so the results under it never jump. The link the user picks
 * goes away (it is the query now), so `onPick` moves focus elsewhere first.
 */
function Suggestions({
  query,
  typed,
  target,
  onPick,
}: {
  query: string
  typed: string
  target: SearchTarget
  onPick: () => void
}) {
  const suggestions = useSuggestions(target, typed)
  const current = query.toLocaleLowerCase()
  const items = (suggestions.data ?? [])
    .filter((suggestion) => suggestion.toLocaleLowerCase() !== current)
    .slice(0, 6)
  return (
    <div className="-mx-gutter min-h-12 overflow-x-auto px-gutter scrollbar-none">
      {suggestions.isPending ? (
        <ul aria-hidden="true" className="flex gap-2 py-1.5">
          {SUGGESTION_PLACEHOLDERS.map((width) => (
            <li key={width} className="shrink-0">
              <Skeleton className={cn('h-9 rounded-full', width)} />
            </li>
          ))}
        </ul>
      ) : (
        items.length > 0 && (
          <nav aria-label="Search suggestions">
            <ul className="flex gap-2 py-1.5">
              {items.map((suggestion) => (
                <li key={suggestion} className="shrink-0">
                  <Link
                    to={`/search?q=${encodeURIComponent(suggestion)}`}
                    replace
                    preventScrollReset
                    onClick={onPick}
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
      )}
    </div>
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
  )
}

type ResultsQuery<T> = UseInfiniteQueryResult<InfiniteData<Page<T>, unknown>, unknown>

/**
 * The states of one tab of results: loading, failed, empty, or the list with "Show more", with a
 * polite status line that tells screen readers what happened ("Searching…", "9 songs for
 * “harbor”", "No songs found", "20 more songs loaded …"). While a newer query is on its way
 * (typed but not searched yet, or loading), the results before it stay, dimmed.
 */
function ResultsFrame<T extends { readonly id: EntityId }>({
  results,
  source,
  query,
  noun,
  stale,
  filter,
  skeleton,
  children,
}: {
  results: ResultsQuery<T>
  source: SourceId
  /** The query the results are for. */
  query: string
  /** What the tab lists, in the singular: `song`, `album` … */
  noun: string
  /** A newer query has been typed and is not searched yet. */
  stale: boolean
  /** Leaves out what the list doesn't show, e.g. what the catalog mode hides. */
  filter?: (items: T[]) => T[]
  skeleton: ReactNode
  children: (items: T[]) => ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  const loadedItems = results.data && uniqueById(results.data.pages.flatMap((page) => page.items))
  const items = loadedItems && filter ? filter(loadedItems) : loadedItems
  const { showMore, loaded } = useShowMore({
    count: items?.length ?? 0,
    isFetching: results.isFetchingNextPage,
    failed: results.isFetchNextPageError,
    fetchNextPage: results.fetchNextPage,
    list: frame,
    listKey: query,
  })
  const busy = stale || results.isPlaceholderData
  const plural = `${noun}s`
  const error = (
    <InlineError error={results.error} source={source} onRetry={() => void results.refetch()} />
  )

  let status = ''
  let content: ReactNode
  if (items === undefined) {
    if (!results.isError) status = 'Searching…'
    content = results.isError ? error : skeleton
  } else if (items.length === 0 && results.isError) {
    content = error
  } else {
    if (busy) status = 'Searching…'
    else if (items.length === 0) status = `No ${plural} found`
    else if (loaded && loaded.total === items.length) {
      status = `${loaded.added} more ${loaded.added === 1 ? noun : plural} loaded, ${items.length} in all`
    } else status = `${countLabel(items.length, noun)} for “${query}”`
    content = (
      <div aria-busy={busy} className={cn('space-y-4 transition-opacity', busy && 'opacity-60')}>
        {items.length === 0 ? (
          <Notice icon={SearchX} headingLevel={3} title={`No ${plural} found`} spacing="compact">
            <p>
              Nothing on {sourceLabel(source)} matches “{query}”. Check the spelling, or try another
              tab.
            </p>
          </Notice>
        ) : (
          <>
            {children(items)}
            {results.isFetchNextPageError ? (
              <InlineError error={results.error} source={source} onRetry={showMore} />
            ) : (
              results.hasNextPage && (
                <ShowMoreButton loading={results.isFetchingNextPage} onClick={showMore}>
                  {`Show more ${plural}`}
                </ShowMoreButton>
              )
            )}
          </>
        )}
      </div>
    )
  }
  return (
    <div ref={frame}>
      <p role="status" className="sr-only">
        {status}
      </p>
      {content}
    </div>
  )
}

/** What every tab of results gets. */
interface TabProps {
  target: SearchTarget
  /** The query to search for. */
  query: string
  /** A newer query has been typed and is not searched yet. */
  stale: boolean
  /** Whether results may be fetched (results fetched before show anyway). */
  fetchEnabled: boolean
}

function TrackResults({
  target,
  query,
  stale,
  fetchEnabled,
  type,
}: TabProps & { type: Extract<SearchType, 'track' | 'video'> }) {
  const results = useSearchResults(target, type, query, fetchEnabled)
  const mode = useSettingsStore((state) => state.catalogMode)
  const { playback } = useMediaActions()
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun={type === 'track' ? 'song' : 'video'}
      stale={stale}
      filter={(items: Track[]) => applyModeFilter(items, mode)}
      skeleton={<RowsSkeleton wide={type === 'video'} />}
    >
      {(tracks: Track[]) => (
        <TrackList
          tracks={tracks}
          label={type === 'track' ? 'Songs' : 'Videos'}
          showAlbum
          onPlay={
            playback
              ? (index) =>
                  playback.play(tracks, {
                    startIndex: index,
                    context: { type: 'search', query, title: query },
                  })
              : undefined
          }
        />
      )}
    </ResultsFrame>
  )
}

function AlbumResults({ target, query, stale, fetchEnabled }: TabProps) {
  const results = useSearchResults(target, 'album', query, fetchEnabled)
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun="album"
      stale={stale}
      skeleton={<RowsSkeleton />}
    >
      {(albums) => <AlbumList albums={albums} />}
    </ResultsFrame>
  )
}

function ArtistResults({ target, query, stale, fetchEnabled }: TabProps) {
  const results = useSearchResults(target, 'artist', query, fetchEnabled)
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun="artist"
      stale={stale}
      skeleton={<RowsSkeleton shape="circle" />}
    >
      {(artists) => <ArtistList artists={artists} />}
    </ResultsFrame>
  )
}

function PlaylistResults({ target, query, stale, fetchEnabled }: TabProps) {
  const results = useSearchResults(target, 'playlist', query, fetchEnabled)
  return (
    <ResultsFrame
      results={results}
      source={target.source}
      query={query}
      noun="playlist"
      stale={stale}
      skeleton={<RowsSkeleton />}
    >
      {(playlists) => <PlaylistList playlists={playlists} />}
    </ResultsFrame>
  )
}

function TabResults({ tab, ...props }: TabProps & { tab: SearchTab }) {
  switch (tab) {
    case 'songs':
      return <TrackResults {...props} type="track" />
    case 'videos':
      return <TrackResults {...props} type="video" />
    case 'albums':
      return <AlbumResults {...props} />
    case 'artists':
      return <ArtistResults {...props} />
    case 'playlists':
      return <PlaylistResults {...props} />
  }
}

/**
 * The results of a query: suggestions, then a tab per type. Typing updates the URL, and so
 * `query`, at once; `typed` and `searched` follow once the query has paused (see
 * `searchTiming`), so suggestions and results are fetched only then. A tab is fetched once it
 * has stayed selected for a moment, so arrowing across the tabs searches only the last one.
 *
 * When the source can't be used (no YouTube in the Free-only tier), the onboarding entry point
 * takes the place of the results and their tabs, which would all say the same.
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
  const { source, options, availability } = useSearchSource()
  const tabs = searchTabs(catalogMode, source)
  const picked = useSearchView((state) => state.tab)
  const setTab = useSearchView((state) => state.setTab)
  const setSource = useSearchView((state) => state.setSource)
  // Switching to Music mode while on Videos falls back to Songs.
  const tab = tabs.some((item) => item.value === picked) ? picked : 'songs'
  const settledTab = useDebouncedValue(tab, searchTiming.tabDelayMs)
  const tabsId = useId()
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)

  if (availability.status !== 'available') {
    return (
      <SourceUnavailable
        availability={availability}
        source={source}
        alternatives={options.filter((option) => option !== source)}
        onPickSource={(other) => {
          // The button goes away with the notice: the results' heading takes the focus.
          flushSync(() => setSource(other))
          heading.current?.focus()
        }}
      />
    )
  }
  const target: SearchTarget = { source, provider: availability.provider }
  return (
    <>
      {canSuggest(availability.provider) && (
        // A key per source: one source's completions never show while another's load.
        <Suggestions
          key={source}
          query={query}
          typed={typed}
          target={target}
          onPick={() => heading.current?.focus()}
        />
      )}
      <section aria-labelledby={headingId} className="space-y-2 sm:space-y-4">
        {/* Phones: for screen readers only, as the query is in the search box right above. */}
        <h2
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="text-xl font-bold tracking-tight break-words max-sm:sr-only md:text-2xl"
        >
          Results for “{query}”
        </h2>
        <Tabs label="Result type" items={tabs} value={tab} onChange={setTab} id={tabsId} />
        <TabPanel id={tabsId} value={tab} className="min-h-40">
          <TabResults
            key={`${source}:${tab}`}
            tab={tab}
            target={target}
            query={searched}
            stale={searched !== query}
            fetchEnabled={settledTab === tab}
          />
        </TabPanel>
      </section>
    </>
  )
}
