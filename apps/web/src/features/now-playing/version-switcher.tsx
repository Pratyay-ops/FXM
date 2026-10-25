import type { AudioCandidate, QueueItem, Track } from '@fxm/core'
import { formatTime } from '@fxm/player'
import { useQuery } from '@tanstack/react-query'
import { Check, RotateCcw, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { chooseVersion, sameAudio } from '../queue/review-actions'
import { useQueueReviewStore } from '../queue/review-store'
import { useSettingsStore } from '../settings/settings-store'
import { versionSearchPath } from './browse-links'
import { Dialog } from './dialog'
import { getPlayback } from './playback'
import { formatConfidence, KIND_LABELS, sourceName } from './stream-label'

const SUBHEADING = 'mb-1 text-xs font-bold tracking-[0.12em] text-text-muted uppercase'

function artistNames(artists: readonly string[]): string {
  return artists.join(', ')
}

/** One version: its title, kind, artists, length, source and match score, and an action. */
function VersionRow({ candidate, action }: { candidate: AudioCandidate; action: ReactNode }) {
  const kind = candidate.kind === 'song' ? undefined : KIND_LABELS[candidate.kind]
  const length =
    candidate.durationMs === undefined ? undefined : formatTime(candidate.durationMs / 1000)
  const details = [kind, artistNames(candidate.artists), length].filter(Boolean).join(' · ')
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{candidate.title}</p>
        <p className="truncate text-sm text-text-muted">{details}</p>
        <p className="text-xs text-text-muted">
          {sourceName(candidate.source)} · match {formatConfidence(candidate.confidence)}
        </p>
      </div>
      {action}
    </div>
  )
}

function OtherVersions({
  track,
  current,
  onChoose,
}: {
  track: Track
  current: AudioCandidate | undefined
  onChoose: (candidate: AudioCandidate) => void
}) {
  const mode = useSettingsStore((state) => state.catalogMode)
  const query = useQuery({
    queryKey: ['versions', track.id, mode],
    queryFn: ({ signal }) => getPlayback().policy.alternatives(track, signal),
    staleTime: 10 * 60_000,
  })
  if (query.isPending) {
    return (
      <div role="status" className="space-y-3 py-2">
        <span className="sr-only">Looking for other versions…</span>
        <Skeleton className="h-4 w-3/4 rounded-full" />
        <Skeleton className="h-4 w-1/2 rounded-full" />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="py-2">
        <p className="text-sm text-text-muted">Couldn’t look for other versions.</p>
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary', className: 'mt-2 h-10 px-4' })}
          onClick={() => void query.refetch()}
        >
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      </div>
    )
  }
  const others = query.data.filter((candidate) => !sameAudio(candidate, current))
  if (others.length === 0) {
    return (
      <p className="py-2 text-sm text-text-muted">
        No other versions found. Search for the song to pick one yourself.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-border">
      {others.map((candidate) => (
        <li key={`${candidate.source}:${candidate.ref}`}>
          <VersionRow
            candidate={candidate}
            action={
              <button
                type="button"
                className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
                onClick={() => onChoose(candidate)}
              >
                Use this
                <span className="sr-only"> version: {candidate.title}</span>
              </button>
            }
          />
        </li>
      ))}
    </ul>
  )
}

/**
 * "Not the right version?": the version that plays (or the best guess waiting for review), the
 * other versions the matching engine ranked, and a search to find one by hand. Picking one
 * makes it the track's audio everywhere in the queue, and the policy remembers it.
 */
export function VersionSwitcher({
  open,
  item,
  onClose,
}: {
  open: boolean
  item: QueueItem
  onClose: () => void
}) {
  const { track } = item
  const bestGuess = useQueueReviewStore((state) => state.entries[track.id])
  const current = item.candidate ?? bestGuess
  const awaitingReview = bestGuess !== undefined
  const choose = (candidate: AudioCandidate) => {
    chooseVersion(track, candidate)
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose the right version"
      description={`Of “${track.title}” by ${artistNames(track.artists.map((artist) => artist.name))}`}
      footer={
        <Link
          to={versionSearchPath(track)}
          onClick={onClose}
          className={buttonClasses({ variant: 'secondary' })}
        >
          <Search aria-hidden="true" />
          Search for another version
        </Link>
      }
    >
      {current !== undefined && (
        <section className="mb-4">
          <h3 className={SUBHEADING}>{awaitingReview ? 'Best guess' : 'Current version'}</h3>
          <VersionRow
            candidate={current}
            action={
              awaitingReview ? (
                <button
                  type="button"
                  className={buttonClasses({ className: 'h-10 px-4' })}
                  onClick={() => choose(current)}
                >
                  <Check aria-hidden="true" />
                  It’s right
                </button>
              ) : (
                <span className="flex items-center gap-1 text-sm font-semibold text-accent">
                  <Check aria-hidden="true" className="size-4" />
                  Chosen
                </span>
              )
            }
          />
        </section>
      )}
      <section className="pb-3">
        <h3 className={SUBHEADING}>Other versions</h3>
        <OtherVersions track={track} current={current} onChoose={choose} />
      </section>
    </Dialog>
  )
}
