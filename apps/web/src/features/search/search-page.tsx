import type { SourceId } from '@fxm/core'
import {
  type CSSProperties,
  lazy,
  type RefObject,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { Link, useNavigationType, useSearchParams } from 'react-router'
import { SearchField } from '../../components/layout/search-field'
import { Artwork } from '../../components/ui/artwork'
import { PageTitle } from '../../components/ui/page'
import { cn } from '../../lib/cn'
import { seedGradient } from '../../lib/seed'
import { CatalogModeControl } from '../settings/catalog-mode-control'
import { type CatalogMode, useSettingsStore } from '../settings/settings-store'
import { LiteNote } from './catalog/lite-note'
import { CatalogOverlays } from './catalog/overlays'
import { OnboardingBanner } from './onboarding'
import { SearchResults, useSearchSource } from './search-results'
import { searchTiming, useSearchView } from './search-view'
import { isYouTubeSource, sourceLabel } from './sources'
import { useSourcesSnapshot } from './sources-context'
import { useDebouncedValue } from './use-debounced-value'

// Local files (stage 4.4) bring their database: loaded after the page, not with the shell.
const LocalSearchSection = lazy(() =>
  import('../local-files/search-section').then((m) => ({ default: m.LocalSearchSection })),
)

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

/**
 * "Search in": a chip per source, as native radio buttons (arrow keys, focus and screen reader
 * semantics come from the browser). Chips take only the width of their name and wrap, so any
 * number of sources fits: YouTube Music and Spotify today, Internet Archive and Jamendo too once
 * they are wired in. Each radio covers its whole chip, so focusing one scrolls all of it into
 * view in the phone's scrolling row.
 */
function SourcePicker({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string
  value: SourceId
  options: readonly SourceId[]
  onChange: (source: SourceId) => void
}) {
  const name = useId()
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex gap-2 sm:flex-wrap">
      {options.map((option) => {
        const checked = option === value
        return (
          <label
            key={option}
            className={cn(
              // Forced colors (Windows High Contrast) drop the fills: outline every chip and mark
              // the selected one in system colors (adjust-none keeps HighlightText readable).
              'relative flex h-9 shrink-0 cursor-pointer items-center rounded-full px-3.5 text-xs font-semibold whitespace-nowrap transition-colors duration-150 select-none after:absolute after:inset-x-0 after:-inset-y-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus forced-colors:border',
              checked
                ? 'bg-accent text-on-accent forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none forced-colors:has-[:focus-visible]:outline-[CanvasText]'
                : 'bg-elevated text-text-muted hover:text-text',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={checked}
              onChange={() => onChange(option)}
              className="absolute inset-0 cursor-pointer appearance-none rounded-full opacity-0"
            />
            {sourceLabel(option)}
          </label>
        )
      })}
    </div>
  )
}

/** How far the faded edge of a sideways scrolling row reaches. */
const EDGE_FADE = '2.5rem'

/**
 * A mask that fades the edges of a sideways scrolling box where more of it is out of view, so a
 * row that happens to end at the screen's edge still shows that it scrolls. `content` names what
 * the box holds: when it changes, so may the box's scroll width, without a resize.
 */
function useScrollFade(box: RefObject<HTMLElement | null>, content: string): CSSProperties {
  const [edges, setEdges] = useState({ before: false, after: false })
  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` changes the scroll width
  useEffect(() => {
    const element = box.current
    if (!element) return
    const update = () => {
      const before = element.scrollLeft > 1
      const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      setEdges((current) =>
        current.before === before && current.after === after ? current : { before, after },
      )
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    resize?.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      resize?.disconnect()
    }
  }, [box, content])
  if (!edges.before && !edges.after) return {}
  const start = edges.before ? `transparent, #000 ${EDGE_FADE}` : '#000'
  const end = edges.after ? `#000 calc(100% - ${EDGE_FADE}), transparent` : '#000'
  const mask = `linear-gradient(to right, ${start}, ${end})`
  return { maskImage: mask, WebkitMaskImage: mask }
}

/**
 * The mode chip, the source switch (when there is more than one source) and the tier note.
 * Phones get them in one row that scrolls sideways, with the labels for screen readers only, so
 * the results start high on the screen; wider screens show the mode's hint and "Search in".
 */
function SearchFilters() {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const { capabilities } = useSourcesSnapshot()
  const { source, options } = useSearchSource()
  const setSource = useSearchView((state) => state.setSource)
  const hintId = useId()
  const sourceLabelId = useId()
  const row = useRef<HTMLDivElement>(null)
  const fade = useScrollFade(row, options.join())
  const several = options.length > 1
  return (
    <div className="space-y-3">
      {/* py-1 and px-gutter: the scroll box clips, so leave room for the focus rings. */}
      <div
        ref={row}
        style={fade}
        className="-mx-gutter flex items-center gap-3 overflow-x-auto px-gutter py-1 scroll-px-gutter scrollbar-none sm:mx-0 sm:flex-col sm:items-start sm:overflow-visible sm:px-0 sm:py-0"
      >
        <div className="flex shrink-0 items-center gap-x-4 gap-y-2 sm:flex-wrap">
          <CatalogModeControl variant="chip" describedBy={hintId} />
          <p id={hintId} className="text-sm text-text-muted max-sm:sr-only">
            {MODE_HINTS[catalogMode]}
          </p>
        </div>
        {several && (
          <>
            <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border sm:hidden" />
            <div className="flex shrink-0 items-center gap-x-3 gap-y-2 sm:flex-wrap">
              <p
                id={sourceLabelId}
                className="text-sm font-semibold text-text-muted max-sm:sr-only"
              >
                Search in
              </p>
              <SourcePicker
                labelledBy={sourceLabelId}
                value={source}
                options={options}
                onChange={setSource}
              />
            </div>
          </>
        )}
      </div>
      {capabilities.youtube === 'simple' && isYouTubeSource(source) && <LiteNote />}
    </div>
  )
}

export function SearchPage() {
  const [params] = useSearchParams()
  const query = (params.get('q') ?? '').trim()
  // Both waits live here, not in the results: those mount on the first keystroke. A query that
  // was in the URL when the page opened (a reload, Back or Forward) is searched at once. One
  // typed elsewhere opened the page with its first letter (the top bar's search box pushes
  // /search?q=<letter>): that one waits like every keystroke after it, so a single letter is
  // never searched.
  const initial = useNavigationType() === 'POP' ? query : ''
  const typed = useDebouncedValue(query, searchTiming.suggestionsDelayMs, initial)
  const searched = useDebouncedValue(query, searchTiming.resultsDelayMs, initial)
  const { source, availability } = useSearchSource()
  // While FXM Connect is still answering, the install pitch would most likely be wrong.
  const { detecting = false } = useSourcesSnapshot()

  return (
    // Phones: tight spacing, as the rows of controls carry their own padding (room for focus
    // rings), so that three results fit above the mini player on a 375 × 667 screen.
    <div className="space-y-2 sm:space-y-6 md:pt-4">
      <PageTitle hideOnPhone>Search</PageTitle>
      {/* From 768px the search box lives in the top bar. */}
      <SearchField className="md:hidden" />
      <SearchFilters />
      {query && (
        <Suspense fallback={null}>
          <LocalSearchSection query={query} />
        </Suspense>
      )}
      {query ? (
        <SearchResults query={query} typed={typed} searched={searched} />
      ) : (
        <div className="space-y-6 pt-2 sm:pt-0">
          {availability.status === 'needs-youtube' && !detecting && (
            <OnboardingBanner name={sourceLabel(source)} />
          )}
          <BrowseAll />
        </div>
      )}
      <CatalogOverlays />
    </div>
  )
}
