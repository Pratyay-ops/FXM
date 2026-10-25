import type { QueueContext } from '@fxm/core'
import { useId, useMemo } from 'react'
import { Link } from 'react-router'
import { countLabel } from '../library/format'
import { StatusToast } from '../library/status'
import { useBlockedRoots, useLocalTracks } from './hooks'
import { LocalTrackList } from './track-list'
import { useFailureToasts } from './track-row'
import { searchLocalTracks } from './tracks'

/** How many matches the search page shows; the Library's Local files tab has the rest. */
export const SEARCH_LIMIT = 5

/**
 * "On this device" on the search page: the local files that match the query, best first, ready
 * to play. Songs whose files can't be read right now (chosen files after a reload) say so, as in
 * the Library. Renders nothing when none match, or when no music files were added.
 */
export function LocalSearchSection({ query }: { query: string }) {
  const tracks = useLocalTracks()
  const blocked = useBlockedRoots()
  const headingId = useId()
  const matches = useMemo(
    () => (tracks.status === 'ready' ? searchLocalTracks(tracks.data, query) : []),
    [tracks, query],
  )
  const context: QueueContext = useMemo(() => ({ type: 'search', query, title: query }), [query])

  useFailureToasts()

  if (matches.length === 0) return null
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <h2 id={headingId} className="text-xl font-bold tracking-tight md:text-2xl">
            On this device
          </h2>
          <p className="text-sm text-text-muted">Music files you added to FXM</p>
        </div>
        {matches.length > SEARCH_LIMIT && (
          <Link
            to={`/library?tab=local&q=${encodeURIComponent(query)}`}
            className="inline-flex h-touch items-center text-sm font-semibold text-text-muted underline-offset-2 hover:text-text hover:underline lg:h-8"
          >
            Show all {countLabel(matches.length, 'song')}
          </Link>
        )}
      </div>
      <LocalTrackList
        tracks={matches.slice(0, SEARCH_LIMIT)}
        context={context}
        label="Songs on this device"
        blocked={blocked}
      />
      <StatusToast />
    </section>
  )
}
