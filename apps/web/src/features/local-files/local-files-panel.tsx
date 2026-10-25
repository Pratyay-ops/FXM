import type { QueueContext } from '@fxm/core'
import { ArrowDownUp, HardDrive, Play, Search, Shuffle } from 'lucide-react'
import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { placeholderKeys, Skeleton } from '../../components/ui/skeleton'
import { countLabel, totalDuration } from '../library/format'
import { chipClasses } from '../library/order-controls'
import { Menu } from '../library/ui/menu'
import { AddMusicActions } from './add-music'
import { FolderList } from './folder-list'
import { useLocalFiles, useLocalRoots, useLocalTracks, useRootStatuses } from './hooks'
import { getLocalPlayer } from './player'
import { LocalTrackList } from './track-list'
import { playableTracks, useFailureToasts } from './track-row'
import {
  isLocalSort,
  LOCAL_SORTS,
  type LocalSort,
  type LocalTrack,
  searchLocalTracks,
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
function LocalFilesEmpty() {
  const files = useLocalFiles()
  return (
    <EmptyState
      icon={HardDrive}
      title="Play music files from this device"
      description={
        files.canKeepFolders()
          ? 'Add a folder of music. FXM reads the files where they are and never uploads them, and lossless files keep their full quality.'
          : 'Choose a folder or some music files. FXM reads them where they are and never uploads them. This browser forgets them when FXM reloads, so you choose them again then; in Chrome or Edge, FXM keeps access to a folder.'
      }
      action={<AddMusicActions />}
      headingLevel={3}
      className="rounded-2xl border border-dashed border-border"
    />
  )
}

/** The songs of local files: play, shuffle, sort, filter, and the list. */
function LocalSongs({
  tracks,
  unavailableRoots,
  scanning,
}: {
  tracks: readonly LocalTrack[]
  unavailableRoots: ReadonlySet<string>
  scanning: boolean
}) {
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState(() => params.get('q') ?? '')
  const deferredFilter = useDeferredValue(filter)
  const requestedSort = params.get('sort')
  const sort: LocalSort = isLocalSort(requestedSort) ? requestedSort : 'artist'
  const headingId = useId()
  const filterId = useId()

  const shown = useMemo(() => {
    const query = deferredFilter.trim()
    return query === '' ? sortLocalTracks(tracks, sort) : searchLocalTracks(tracks, query)
  }, [tracks, sort, deferredFilter])
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

  const playable = useMemo(() => playableTracks(shown), [shown])
  const playAll = (shuffle: boolean) =>
    void getLocalPlayer().setQueue(playable, { context: LOCAL_FILES_CONTEXT, shuffle })

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h3 id={headingId} className="sr-only">
        Songs
      </h3>
      <div className="flex flex-wrap items-center gap-2">
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
          className={buttonClasses({ variant: 'secondary' })}
          disabled={playable.length < 2}
          onClick={() => playAll(true)}
        >
          <Shuffle aria-hidden="true" />
          Shuffle
        </button>
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
          {currentSort}
        </Menu>
        <div className="relative w-full sm:ml-auto sm:w-64">
          <label htmlFor={filterId} className="sr-only">
            Filter local files
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
          />
          <input
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
      <p
        className="text-sm text-text-muted"
        aria-live={deferredFilter.trim() === '' ? 'off' : 'polite'}
      >
        {deferredFilter.trim() !== '' && shown.length === 0
          ? `No songs match “${deferredFilter.trim()}”`
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
          unavailableRoots={unavailableRoots}
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
  useFailureToasts()

  useEffect(() => {
    // A database the browser blocks shows as the error state below.
    files.checkRoots().catch(() => {})
  }, [files])

  const songCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (tracks.status === 'ready') {
      for (const { file } of tracks.data)
        counts.set(file.rootId, (counts.get(file.rootId) ?? 0) + 1)
    }
    return counts
  }, [tracks])

  const unavailableRoots = useMemo(
    () =>
      new Set(
        Object.entries(statuses).flatMap(([id, status]) =>
          status.state === 'unavailable' || status.state === 'missing' ? [id] : [],
        ),
      ),
    [statuses],
  )

  if (roots.status === 'error' || tracks.status === 'error') return <Unreadable />
  if (roots.status === 'loading' || tracks.status === 'loading') return <ListSkeleton />
  if (roots.data.length === 0) return <LocalFilesEmpty />
  const scanning = Object.values(statuses).some((status) => status.state === 'scanning')
  return (
    <div className="space-y-8">
      <FolderList roots={roots.data} songCounts={songCounts} />
      <LocalSongs tracks={tracks.data} unavailableRoots={unavailableRoots} scanning={scanning} />
    </div>
  )
}
