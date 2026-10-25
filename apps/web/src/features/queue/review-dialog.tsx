import type { AudioCandidate, QueueItem } from '@fxm/core'
import { Check, Pause, Play } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { Dialog } from '../now-playing/dialog'
import { getPlayer, usePlayerState } from '../now-playing/playback'
import { sourceName } from '../now-playing/stream-label'
import { VersionSwitcher } from '../now-playing/version-switcher'
import { BestGuessCard, BestGuessesSetting } from './best-guess'
import { approveAllBestGuesses, chooseVersion, playBestGuess } from './review-actions'
import { useQueueReviewStore } from './review-store'

/** One song to review: its first queue item, that item's index, and the best guess. */
interface ReviewEntry {
  item: QueueItem
  index: number
  bestGuess: AudioCandidate
}

/** Where focus goes once the last row is gone. */
const DONE = 'done'

/**
 * Plays a best guess to check it by ear, without approving it, or pauses it while it plays.
 * Playing it makes it the queue's current song.
 */
function PlayGuessButton({ entry }: { entry: ReviewEntry }) {
  const { item, index, bestGuess } = entry
  const playing = usePlayerState(
    (state) =>
      state.queue.items[state.queue.index]?.uid === item.uid &&
      (state.status === 'playing' || state.status === 'loading'),
  )
  return (
    <button
      type="button"
      className={buttonClasses({ variant: 'ghost', className: 'h-10 px-4' })}
      onClick={() => (playing ? getPlayer().pause() : playBestGuess(item, index, bestGuess))}
    >
      {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      {playing ? 'Pause' : 'Play'}
      <span className="sr-only"> the best guess for {item.track.title}</span>
    </button>
  )
}

function ReviewRow({
  entry,
  register,
  onApprove,
  onOtherVersions,
}: {
  entry: ReviewEntry
  register: (node: HTMLButtonElement | null) => void
  onApprove: () => void
  onOtherVersions: () => void
}) {
  const { track } = entry.item
  return (
    <li className="py-3">
      <p className="truncate font-semibold">{track.title}</p>
      <p className="truncate text-sm text-text-muted">
        {track.artists.map((artist) => artist.name).join(', ')} · from {sourceName(track.source)}
      </p>
      <BestGuessCard track={track} guess={entry.bestGuess} className="mt-2" />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          ref={register}
          className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
          onClick={onApprove}
        >
          <Check aria-hidden="true" />
          Approve
          <span className="sr-only"> the best guess for {track.title}</span>
        </button>
        <PlayGuessButton entry={entry} />
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost', className: 'h-10 px-4' })}
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
 * play, approve one by one or all at once, or replace with another version. An approval
 * removes its row: focus moves to the next row's "Approve" (or the previous one's, or "Done").
 */
export function ReviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = usePlayerState((state) => state.queue.items)
  const entries = useQueueReviewStore((state) => state.entries)
  const [switching, setSwitching] = useState<ReviewEntry>()
  const approveButtons = useRef(new Map<string, HTMLButtonElement>())
  const doneButton = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<string | null>(null)

  // One row per track, in queue order.
  const rows = useMemo(() => {
    const seen = new Set<string>()
    return items.flatMap((item, index): ReviewEntry[] => {
      const bestGuess = entries[item.track.id]
      if (bestGuess === undefined || seen.has(item.track.id)) return []
      seen.add(item.track.id)
      return [{ item, index, bestGuess }]
    })
  }, [items, entries])

  useLayoutEffect(() => {
    const key = pendingFocus.current
    if (key === null) return
    pendingFocus.current = null
    const target = key === DONE ? doneButton.current : approveButtons.current.get(key)
    target?.focus()
  })

  /** Picks where focus goes once the row of `trackId` is gone. */
  const focusAfter = (trackId: string) => {
    const at = rows.findIndex((row) => row.item.track.id === trackId)
    const neighbour = rows[at + 1] ?? rows[at - 1]
    pendingFocus.current = neighbour === undefined ? DONE : neighbour.item.track.id
  }

  const register = (trackId: string) => (node: HTMLButtonElement | null) => {
    if (node === null) approveButtons.current.delete(trackId)
    else approveButtons.current.set(trackId, node)
  }

  const closeSwitcher = () => {
    const entry = switching
    setSwitching(undefined)
    // A version was picked, so its row goes. Closed without one, focus returns to the row.
    const trackId = entry?.item.track.id
    if (trackId !== undefined && useQueueReviewStore.getState().entries[trackId] === undefined) {
      focusAfter(trackId)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Review best guesses"
        description="FXM matched these songs from another catalog, but isn’t sure it found the right recording. Play a guess to check it, and approve the ones that are right."
        footer={
          rows.length === 0 ? (
            <button type="button" ref={doneButton} className={buttonClasses()} onClick={onClose}>
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
        <BestGuessesSetting className="border-b border-border pt-1 pb-4" />
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-text-muted">
            All done: nothing in the queue needs review.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((entry) => (
              <ReviewRow
                key={entry.item.track.id}
                entry={entry}
                register={register(entry.item.track.id)}
                onApprove={() => {
                  focusAfter(entry.item.track.id)
                  chooseVersion(entry.item.track, entry.bestGuess)
                }}
                onOtherVersions={() => setSwitching(entry)}
              />
            ))}
          </ul>
        )}
      </Dialog>
      {switching !== undefined && (
        <VersionSwitcher open item={switching.item} onClose={closeSwitcher} />
      )}
    </>
  )
}
