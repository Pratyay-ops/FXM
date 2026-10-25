import type { AudioCandidate, QueueItem } from '@fxm/core'
import { formatTime } from '@fxm/player'
import { Check } from 'lucide-react'
import { useMemo, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { Dialog } from '../now-playing/dialog'
import { usePlayerState } from '../now-playing/playback'
import { formatConfidence, KIND_LABELS, sourceName } from '../now-playing/stream-label'
import { VersionSwitcher } from '../now-playing/version-switcher'
import { approveAllBestGuesses, chooseVersion } from './review-actions'
import { useQueueReviewStore } from './review-store'

function ReviewRow({
  item,
  bestGuess,
  onOtherVersions,
}: {
  item: QueueItem
  bestGuess: AudioCandidate
  onOtherVersions: () => void
}) {
  const { track } = item
  const kind = bestGuess.kind === 'song' ? undefined : KIND_LABELS[bestGuess.kind]
  const length =
    bestGuess.durationMs === undefined ? undefined : formatTime(bestGuess.durationMs / 1000)
  const guess = [kind, bestGuess.artists.join(', '), length].filter(Boolean).join(' · ')
  return (
    <li className="py-3">
      <p className="truncate font-semibold">{track.title}</p>
      <p className="truncate text-sm text-text-muted">
        {track.artists.map((artist) => artist.name).join(', ')} · from {sourceName(track.source)}
      </p>
      <div className="mt-2 rounded-lg bg-elevated px-3 py-2">
        <p className="text-xs font-semibold text-text-muted">
          Best guess on {sourceName(bestGuess.source)} · match{' '}
          {formatConfidence(bestGuess.confidence)}
        </p>
        <p className="mt-0.5 truncate font-semibold">{bestGuess.title}</p>
        <p className="truncate text-sm text-text-muted">{guess}</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClasses({ className: 'h-10 px-4' })}
          onClick={() => chooseVersion(track, bestGuess)}
        >
          <Check aria-hidden="true" />
          Approve
          <span className="sr-only"> the best guess for {track.title}</span>
        </button>
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
          onClick={onOtherVersions}
        >
          Other versions
          <span className="sr-only"> of {track.title}</span>
        </button>
      </div>
    </li>
  )
}

/**
 * The batch review: every song in the queue whose match needs review, with its best guess, to
 * approve one by one, all at once, or replace with another version.
 */
export function ReviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = usePlayerState((state) => state.queue.items)
  const entries = useQueueReviewStore((state) => state.entries)
  const [switching, setSwitching] = useState<QueueItem>()

  // One row per track, in queue order.
  const rows = useMemo(() => {
    const seen = new Set<string>()
    return items.flatMap((item) => {
      const bestGuess = entries[item.track.id]
      if (bestGuess === undefined || seen.has(item.track.id)) return []
      seen.add(item.track.id)
      return [{ item, bestGuess }]
    })
  }, [items, entries])

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Review best guesses"
        description="FXM matched these songs from another catalog, but isn’t sure it found the right recording. Approve the ones that sound right."
        footer={
          rows.length === 0 ? (
            <button type="button" className={buttonClasses()} onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className={buttonClasses({ variant: 'secondary' })}
                onClick={onClose}
              >
                Later
              </button>
              <button
                type="button"
                className={buttonClasses()}
                onClick={() => {
                  approveAllBestGuesses()
                  onClose()
                }}
              >
                Approve all
              </button>
            </>
          )
        }
      >
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-text-muted">
            All done: nothing in the queue needs review.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ item, bestGuess }) => (
              <ReviewRow
                key={item.track.id}
                item={item}
                bestGuess={bestGuess}
                onOtherVersions={() => setSwitching(item)}
              />
            ))}
          </ul>
        )}
      </Dialog>
      {switching !== undefined && (
        <VersionSwitcher open item={switching} onClose={() => setSwitching(undefined)} />
      )}
    </>
  )
}
