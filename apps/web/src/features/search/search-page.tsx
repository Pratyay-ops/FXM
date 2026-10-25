import { Info } from 'lucide-react'
import { useId, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { SearchField } from '../../components/layout/search-field'
import { CardGrid, SongList, VideoGrid } from '../../components/media/placeholders'
import { Artwork } from '../../components/ui/artwork'
import { PageTitle } from '../../components/ui/page'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { seedGradient } from '../../lib/seed'
import { CatalogModeControl } from '../settings/catalog-mode-control'
import { type CatalogMode, useSettingsStore } from '../settings/settings-store'

export type SearchTab = 'songs' | 'albums' | 'artists' | 'playlists' | 'videos'

const MUSIC_TABS: readonly TabItem<SearchTab>[] = [
  { value: 'songs', label: 'Songs' },
  { value: 'albums', label: 'Albums' },
  { value: 'artists', label: 'Artists' },
  { value: 'playlists', label: 'Playlists' },
]

/** Result tabs per catalog mode: videos exist only in Music + Video mode. */
export const SEARCH_TABS: Readonly<Record<CatalogMode, readonly TabItem<SearchTab>[]>> = {
  music: MUSIC_TABS,
  all: [...MUSIC_TABS, { value: 'videos', label: 'Videos' }],
}

const MODE_HINTS: Readonly<Record<CatalogMode, string>> = {
  music: 'Songs from the YouTube Music catalog only.',
  all: 'Also covers, live sets, remixes and any YouTube video.',
}

const GENRES = [
  'Pop',
  'Hip-hop',
  'Rock',
  'Indie',
  'Electronic',
  'R&B',
  'Lo-fi',
  'Jazz',
  'Classical',
  'K-pop',
  'Bollywood',
  'Latin',
] as const

function BrowseAll() {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="text-xl font-bold tracking-tight md:text-2xl">
        Browse all
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-6">
        {GENRES.map((genre) => (
          <li key={genre}>
            <Link
              to={`/search?q=${encodeURIComponent(genre)}`}
              className="relative flex aspect-[16/10] overflow-hidden rounded-lg p-3 shadow-md transition-transform duration-200 hover:scale-[1.02] motion-reduce:transform-none sm:p-4"
              style={{ backgroundImage: seedGradient(`genre:${genre}`, 0.48) }}
            >
              <span className="relative z-10 text-lg font-extrabold text-white text-shadow-sm sm:text-xl">
                {genre}
              </span>
              <Artwork
                seed={`genre-art:${genre}`}
                className="absolute -right-3 -bottom-2 size-16 rotate-[25deg] shadow-lg sm:size-20"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ResultsPlaceholder({ tab }: { tab: SearchTab }) {
  switch (tab) {
    case 'songs':
      return <SongList count={8} />
    case 'artists':
      return <CardGrid count={10} shape="circle" />
    case 'videos':
      return <VideoGrid count={6} />
    default:
      return <CardGrid count={10} />
  }
}

function Results({ query, catalogMode }: { query: string; catalogMode: CatalogMode }) {
  const [tab, setTab] = useState<SearchTab>('songs')
  const tabsId = useId()
  const headingId = useId()
  const tabs = SEARCH_TABS[catalogMode]
  // Switching to Music mode while on Videos falls back to Songs.
  const activeTab = tabs.some((item) => item.value === tab) ? tab : 'songs'

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="text-xl font-bold tracking-tight break-words md:text-2xl">
        Results for “{query}”
      </h2>
      <Tabs label="Result type" items={tabs} value={activeTab} onChange={setTab} id={tabsId} />
      <TabPanel id={tabsId} value={activeTab} className="space-y-4">
        <p className="flex items-start gap-2 text-sm text-text-muted">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Results appear here once FXM's music sources are connected.
        </p>
        <ResultsPlaceholder tab={activeTab} />
      </TabPanel>
    </section>
  )
}

export function SearchPage() {
  const [params] = useSearchParams()
  const query = (params.get('q') ?? '').trim()
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const hintId = useId()

  return (
    <div className="space-y-6 pt-2 md:pt-4">
      <PageTitle hideOnPhone>Search</PageTitle>
      {/* From 768px the search box lives in the top bar. */}
      <SearchField className="md:hidden" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <CatalogModeControl variant="chip" describedBy={hintId} />
        <p id={hintId} className="text-sm text-text-muted">
          {MODE_HINTS[catalogMode]}
        </p>
      </div>
      {query ? <Results query={query} catalogMode={catalogMode} /> : <BrowseAll />}
    </div>
  )
}
