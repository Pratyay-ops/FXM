import { FlaskConical } from 'lucide-react'
import { useId } from 'react'
import { Link, useSearchParams } from 'react-router'
import { SearchField } from '../../components/layout/search-field'
import { Artwork } from '../../components/ui/artwork'
import { PageTitle } from '../../components/ui/page'
import { SegmentedControl } from '../../components/ui/segmented-control'
import { seedGradient } from '../../lib/seed'
import { CatalogModeControl } from '../settings/catalog-mode-control'
import { type CatalogMode, useSettingsStore } from '../settings/settings-store'
import { CatalogOverlays } from './catalog/overlays'
import { ONBOARDING_URL } from './onboarding'
import { SearchResults, useSearchSource } from './search-results'
import { searchTiming, useSearchView } from './search-view'
import { isYouTubeSource, sourceLabel } from './sources'
import { useSourcesSnapshot } from './sources-context'
import { useDebouncedValue } from './use-debounced-value'

const MODE_HINTS: Readonly<Record<CatalogMode, string>> = {
  music: 'Songs only, from every source.',
  all: 'Also music videos, covers, live sets and any YouTube video, played as music.',
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

/** Explains the Lite tier where it matters: on YouTube results, which lack downloads and EQ. */
function LiteNote() {
  return (
    <p className="flex items-start gap-2 text-sm text-text-muted">
      <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        Lite mode, experimental: YouTube Music without an install, but no downloads or equalizer.{' '}
        <a
          href={ONBOARDING_URL}
          target="_blank"
          rel="noreferrer"
          className="font-semibold whitespace-nowrap text-text underline underline-offset-2"
        >
          Get FXM Connect
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </span>
    </p>
  )
}

/** The mode chip, the source switch (when there is more than one source) and the tier note. */
function SearchFilters() {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const { capabilities } = useSourcesSnapshot()
  const { source, options } = useSearchSource()
  const setSource = useSearchView((state) => state.setSource)
  const hintId = useId()
  const sourceLabelId = useId()
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <CatalogModeControl variant="chip" describedBy={hintId} />
        <p id={hintId} className="text-sm text-text-muted">
          {MODE_HINTS[catalogMode]}
        </p>
      </div>
      {options.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p id={sourceLabelId} className="text-sm font-semibold text-text-muted">
            Search in
          </p>
          <SegmentedControl
            label="Search in"
            labelledBy={sourceLabelId}
            size="sm"
            value={source}
            options={options.map((option) => ({ value: option, label: sourceLabel(option) }))}
            onChange={setSource}
          />
        </div>
      )}
      {capabilities.youtube === 'simple' && isYouTubeSource(source) && <LiteNote />}
    </div>
  )
}

export function SearchPage() {
  const [params] = useSearchParams()
  const query = (params.get('q') ?? '').trim()
  // Here, not in the results: they mount on the first keystroke, which must not search yet.
  // A query in the URL from the start (a link, Back) is searched at once.
  const typed = useDebouncedValue(query, searchTiming.suggestionsDelayMs)
  const searched = useDebouncedValue(query, searchTiming.resultsDelayMs)

  return (
    <div className="space-y-6 pt-2 md:pt-4">
      <PageTitle hideOnPhone>Search</PageTitle>
      {/* From 768px the search box lives in the top bar. */}
      <SearchField className="md:hidden" />
      <SearchFilters />
      {query ? <SearchResults query={query} typed={typed} searched={searched} /> : <BrowseAll />}
      <CatalogOverlays />
    </div>
  )
}
