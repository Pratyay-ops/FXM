import type { QueueContext } from '@fxm/core'
import { ArrowDownUp, HardDrive, Lock, Play, Search, Shuffle, X } from 'lucide-react'
import {
  type RefObject,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSearchParams } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { IconButton } from '../../components/ui/icon-button'
import { placeholderKeys, Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { countLabel, totalDuration } from '../library/format'
import { chipClasses } from '../library/order-controls'
import { Menu } from '../library/ui/menu'
import { AddMusicActions, type Pickers, usePickers } from './add-music'
import { FolderList, type RootAction, rootAction } from './folder-list'
import {
  useBlockedRoots,
  useLocalFiles,
  useLocalRoots,
  useLocalTracks,
  useRootStatuses,
} from './hooks'
import { CHECKING } from './local-files'
import { getLocalPlayer } from './player'
import { isScanning } from './root-status'
import { LocalTrackList } from './track-list'
import { type BlockedRoots, playableTracks, useFailureToasts } from './track-row'
import {
  filterLocalTracks,
  isLocalSort,
  LOCAL_SORTS,
  type LocalSort,
  type LocalTrack,
  sortLocalTracks,
} from './tracks'

/** What the queue says it plays from, for the whole list. */
export const LOCAL_FILES_CONTEXT: QueueContext = {
  type: 'library',
  id: 'local-files',
  title: 'Local files',
}

function ListSkeleton() {
  return (
    <div role="status" className="space-y-3 pt-2">
      <span className="sr-only">Loading…</span>
      {placeholderKeys(6, 'local-row').map((key) => (
        <div key={key} className="flex items-center gap-3">
          <Skeleton className="size-10 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3 max-w-72 rounded-full" />
            <Skeleton className="h-3 w-1/3 max-w-40 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

function Unreadable() {
  return (
    <p role="alert" className="py-10 text-center text-text-muted">
      Your local files can’t be read in this browser window. Private windows and turned-off site
      data can block them.
    </p>
  )
}

/** What the tab shows before any music was added. */
function LocalFilesEmpty({
  pickers,
  containerRef,
}: {
  pickers: Pickers
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const files = useLocalFiles()
  let description: string
  if (files.canKeepFolders()) {
    description =
      'Add a folder of music. FXM reads the files where they are and never uploads them, and lossless files keep their full quality.'
  } else if (files.canChooseFolders()) {
    description =
      'Choose a folder or some music files. FXM reads them where they are and never uploads them. This browser forgets them when FXM reloads, so you choose them again then; in Chrome or Edge, FXM keeps access to a folder.'
  } else {
    description =
      'Choose some music files. FXM reads them where they are and never uploads them. This browser forgets them when FXM reloads, so you choose them again then.'
  }
  return (
    <div ref={containerRef}>
      <EmptyState
        icon={HardDrive}
        title="Play music files from this device"
        description={description}
        action={<AddMusicActions pickers={pickers} />}
        headingLevel={3}
        className="rounded-2xl bg-surface"
      />
    </div>
  )
}

/**
 * Moves focus into the view that replaced the one it was in: to the folders' heading when the
 * first folder arrives (the empty state's button is gone), to the empty state's first button
 * when the last one goes (its row is gone). Focus that is anywhere else stays there.
 */
function useFocusOnSwitch(
  empty: boolean | undefined,
  heading: RefObject<HTMLHeadingElement | null>,
  emptyState: RefObject<HTMLDivElement | null>,
): void {
  const previous = useRef(empty)
  useEffect(() => {
    const before = previous.current
    previous.current = empty
    if (before === undefined || empty === undefined || before === empty) return
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    if (empty) emptyState.current?.querySelector<HTMLElement>('button')?.focus()
    else heading.current?.focus()
  }, [empty, heading, emptyState])
}

/** The songs of local files: play, shuffle, sort, filter, and the list. */
function LocalSongs({
  tracks,
  blocked,
  scanning,
  fixFor,
}: {
  tracks: readonly LocalTrack[]
  blocked: BlockedRoots
  scanning: boolean
  /** What fixes a root whose songs can't play now. */
  fixFor: (rootId: string) => RootAction | undefined
}) {
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState(() => params.get('q') ?? '')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterInput = useRef<HTMLInputElement>(null)
  const deferredFilter = useDeferredValue(filter)
  const requestedSort = params.get('sort')
  const sort: LocalSort = isLocalSort(requestedSort) ? requestedSort : 'artist'
  const headingId = useId()
  const filterId = useId()
  const query = deferredFilter.trim()
  // On phones the filter hides behind a button until it is needed.
  const filterShown = filterOpen || filter !== ''

  useEffect(() => {
    if (filterOpen) filterInput.current?.focus()
  }, [filterOpen])

  // Filtered or not, the songs keep the order the sort chip names.
  const shown = useMemo(
    () => sortLocalTracks(query === '' ? tracks : filterLocalTracks(tracks, query), sort),
    [tracks, sort, query],
  )
  const duration = totalDuration(shown.map(({ track }) => track.durationMs))
  const currentSort = LOCAL_SORTS.find((option) => option.value === sort)?.label ?? ''

  const setParam = (name: string, value: string | undefined) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value === undefined || value === '') next.delete(name)
        else next.set(name, value)
        return next
      },
      { replace: true },
    )

  const playable = useMemo(() => playableTracks(shown, blocked), [shown, blocked])
  const playAll = (shuffle: boolean) =>
    void getLocalPlayer().setQueue(playable, { context: LOCAL_FILES_CONTEXT, shuffle })
  // Nothing can play because of where the songs come from (chosen files after a reload, say):
  // offer what fixes that instead of Play.
  const blockedRoot =
    playable.length === 0 ? shown.find(({ file }) => blocked.has(file.rootId)) : undefined
  const fix = blockedRoot === undefined ? undefined : fixFor(blockedRoot.file.rootId)

  return (
    <section aria-labelledby={headingId} className="space-y-3 sm:space-y-4">
      <h3 id={headingId} className="sr-only">
        Songs
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        {fix !== undefined ? (
          <button type="button" className={buttonClasses()} onClick={fix.run}>
            <Lock aria-hidden="true" />
            {fix.standalone}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={buttonClasses()}
              disabled={playable.length === 0}
              onClick={() => playAll(false)}
            >
              <Play aria-hidden="true" fill="currentColor" />
              Play
            </button>
            <button
              type="button"
              className={buttonClasses({
                variant: 'secondary',
                className: 'max-sm:w-touch max-sm:px-0',
              })}
              disabled={playable.length < 2}
              onClick={() => playAll(true)}
            >
              <Shuffle aria-hidden="true" />
              <span className="max-sm:sr-only">Shuffle</span>
            </button>
          </>
        )}
        <Menu
          label="Sort songs"
          align="start"
          className={chipClasses()}
          items={[
            {
              kind: 'group',
              id: 'sort',
              label: 'Sort by',
              items: LOCAL_SORTS.map((option) => ({
                kind: 'radio',
                id: `sort-${option.value}`,
                label: option.label,
                checked: option.value === sort,
                onSelect: () =>
                  setParam('sort', option.value === 'artist' ? undefined : option.value),
              })),
            },
          ]}
        >
          <ArrowDownUp aria-hidden="true" />
          <span className="sr-only">Sort: </span>
          <span className="max-sm:sr-only">{currentSort}</span>
        </Menu>
        <IconButton
          label={filterShown ? 'Close filter' : 'Filter songs'}
          icon={filterShown ? <X /> : <Search />}
          aria-expanded={filterShown}
          aria-controls={filterId}
          className="sm:hidden"
          onClick={() => {
            if (!filterShown) {
              setFilterOpen(true)
              return
            }
            setFilter('')
            setParam('q', undefined)
            setFilterOpen(false)
          }}
        />
        <div className={cn('relative w-full sm:ml-auto sm:w-64', !filterShown && 'max-sm:hidden')}>
          <label htmlFor={filterId} className="sr-only">
            Filter local files
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
          />
          <input
            ref={filterInput}
            id={filterId}
            type="search"
            value={filter}
            placeholder="Filter local files"
            onChange={(event) => {
              setFilter(event.target.value)
              setParam('q', event.target.value.trim())
            }}
            className="h-touch w-full rounded-full border border-border-strong bg-elevated pr-4 pl-9 text-base placeholder:text-text-muted lg:h-9 lg:text-sm lg:pointer-coarse:h-touch"
          />
        </div>
      </div>
      {/* Announced while filtering; a scan changes the count too often to read it out. */}
      <p className="text-sm text-text-muted" aria-live={query === '' ? 'off' : 'polite'}>
        {query !== '' && shown.length === 0
          ? `No songs match “${query}”`
          : `${countLabel(shown.length, 'song')}${duration ? ` · ${duration}` : ''}`}
      </p>
      {tracks.length === 0 ? (
        scanning ? (
          <ListSkeleton />
        ) : (
          <p className="py-6 text-center text-text-muted">
            No music files were found here. FXM reads MP3, AAC, ALAC, FLAC, WAV, Opus and Vorbis
            files.
          </p>
        )
      ) : (
        <LocalTrackList
          tracks={shown}
          context={LOCAL_FILES_CONTEXT}
          label="Songs in local files"
          blocked={blocked}
        />
      )}
    </section>
  )
}

/**
 * The Library's Local files tab: where the music comes from (folders and chosen files, with
 * what each needs, such as access again) and every song in them.
 */
export function LocalFilesPanel() {
  const files = useLocalFiles()
  const roots = useLocalRoots()
  const tracks = useLocalTracks()
  const statuses = useRootStatuses()
  // Also checks every root once: kept folders, and whether chosen files are still here.
  const blocked = useBlockedRoots()
  const pickers = usePickers()
  const sourcesHeading = useRef<HTMLHeadingElement>(null)
  const emptyState = useRef<HTMLDivElement>(null)
  useFailureToasts()
  useFocusOnSwitch(
    roots.status === 'ready' ? roots.data.length === 0 : undefined,
    sourcesHeading,
    emptyState,
  )

  const songCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (tracks.status === 'ready') {
      for (const { file } of tracks.data)
        counts.set(file.rootId, (counts.get(file.rootId) ?? 0) + 1)
    }
    return counts
  }, [tracks])

  if (roots.status === 'error' || tracks.status === 'error') return <Unreadable />
  if (roots.status === 'loading' || tracks.status === 'loading') return <ListSkeleton />
  const scanning = roots.data.some((root) => isScanning(statuses[root.id] ?? CHECKING))
  const fixFor = (rootId: string) => {
    const root = roots.data.find((each) => each.id === rootId)
    return root && rootAction(root, statuses[rootId] ?? CHECKING, files, pickers)
  }
  return (
    <>
      {roots.data.length === 0 ? (
        <LocalFilesEmpty pickers={pickers} containerRef={emptyState} />
      ) : (
        <div className="space-y-4 sm:space-y-8">
          <FolderList
            roots={roots.data}
            statuses={statuses}
            songCounts={songCounts}
            pickers={pickers}
            headingRef={sourcesHeading}
          />
          <LocalSongs tracks={tracks.data} blocked={blocked} scanning={scanning} fixFor={fixFor} />
        </div>
      )}
      {pickers.inputs}
    </>
  )
}
