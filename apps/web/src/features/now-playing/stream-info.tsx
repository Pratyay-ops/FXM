import type { AudioCandidate, QueueItem } from '@fxm/core'
import { AudioLines, Check, ChevronDown, CircleHelp, Link2, Play } from 'lucide-react'
import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { BestGuessCard } from '../queue/best-guess'
import { chooseVersion, playBestGuess } from '../queue/review-actions'
import { useQueueReviewStore } from '../queue/review-store'
import { usePlayerState } from './playback'
import { describeStream, isMatched, sourceName } from './stream-label'
import { VersionSwitcher } from './version-switcher'

/**
 * Asks whether a best guess is the right recording, while it plays or waits for review, and
 * shows it: what it is, where it comes from, how sure the match is and how long it is. A guess
 * that hasn't played yet (the queue skipped it) can be played from here to check it by ear.
 */
function BestGuessNotice({
  item,
  bestGuess,
  onApprove,
  onOtherVersions,
}: {
  item: QueueItem
  bestGuess: AudioCandidate
  onApprove: () => void
  onOtherVersions: () => void
}) {
  const { track } = item
  const approveButton = useRef<HTMLButtonElement>(null)
  const played = item.candidate !== undefined
  const queueIndex = usePlayerState((state) => state.queue.index)
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="flex items-center gap-2 font-semibold">
        <CircleHelp aria-hidden="true" className="size-5 shrink-0 text-accent" />
        Is this the right version?
      </p>
      <p className="mt-1 text-sm text-text-muted">
        FXM matched this song from {sourceName(track.source)}, but isn’t sure it found the right
        recording.
      </p>
      <BestGuessCard track={track} guess={item.candidate ?? bestGuess} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          ref={approveButton}
          className={buttonClasses({ className: 'h-10 px-4' })}
          onClick={onApprove}
        >
          <Check aria-hidden="true" />
          It’s right
        </button>
        {!played && (
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
            onClick={() => {
              // The button goes once the guess plays: keep the focus in the notice.
              approveButton.current?.focus()
              playBestGuess(item, queueIndex, bestGuess)
            }}
          >
            <Play aria-hidden="true" />
            Play it
          </button>
        )}
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
          onClick={onOtherVersions}
        >
          Not the right version?
        </button>
      </div>
    </div>
  )
}

/**
 * The stream badge ("Opus · YouTube Music"), the match it came from ("Matched from Spotify ·
 * 0.93"), the stream details behind the badge, and "Not the right version?" for matched audio.
 * Approving a best guess replaces its notice with "Not the right version?", which takes the
 * focus (or the track's heading, `headingId`, does).
 */
export function StreamInfo({ item, headingId }: { item: QueueItem; headingId: string }) {
  const stream = usePlayerState((state) => state.stream)
  const bestGuess = useQueueReviewStore((state) => state.entries[item.track.id])
  const [showDetails, setShowDetails] = useState(false)
  const [switching, setSwitching] = useState(false)
  const otherVersions = useRef<HTMLButtonElement>(null)
  const focusAfterReview = useRef(false)
  const detailsId = useId()
  const { badge, match, details } = describeStream(item.track, item.candidate, stream)
  const matched = isMatched(item.track, item.candidate)

  // Approved: the notice and its focused button are gone.
  useLayoutEffect(() => {
    if (!focusAfterReview.current || bestGuess !== undefined) return
    focusAfterReview.current = false
    const target = otherVersions.current ?? document.getElementById(headingId)
    target?.focus()
  })

  const closeSwitcher = () => {
    setSwitching(false)
    // A version picked in the switcher approves the best guess too.
    const reviewed = useQueueReviewStore.getState().entries[item.track.id] === undefined
    if (bestGuess !== undefined && reviewed) focusAfterReview.current = true
  }

  return (
    <div className="mt-4 space-y-3">
      {(badge !== undefined || match !== undefined) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {badge !== undefined && (
            <button
              type="button"
              aria-expanded={showDetails}
              aria-controls={detailsId}
              onClick={() => setShowDetails(!showDetails)}
              // The ::after extends the hit area to 44px without changing the look.
              className="relative inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-border px-3 text-xs font-semibold whitespace-nowrap text-text-muted transition-colors after:absolute after:-inset-1.5 hover:border-border-strong hover:text-text"
            >
              <AudioLines aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{badge}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'size-3.5 shrink-0 transition-transform',
                  showDetails && 'rotate-180',
                )}
              />
            </button>
          )}
          {match !== undefined && (
            // Plain text, not a chip: only the badge is a control.
            <span className="inline-flex max-w-full items-center gap-1.5 text-xs font-semibold text-text-muted">
              <Link2 aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{match}</span>
            </span>
          )}
        </div>
      )}
      <dl
        id={detailsId}
        hidden={!showDetails}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg bg-elevated p-3 text-sm"
      >
        {details.map((detail) => (
          <Fragment key={detail.label}>
            <dt className="text-text-muted">{detail.label}</dt>
            <dd className="break-words">{detail.value}</dd>
          </Fragment>
        ))}
      </dl>
      {bestGuess !== undefined ? (
        <BestGuessNotice
          item={item}
          bestGuess={bestGuess}
          onApprove={() => {
            focusAfterReview.current = true
            // Approve what plays: the best guess, or a version the user already picked.
            chooseVersion(item.track, item.candidate ?? bestGuess)
          }}
          onOtherVersions={() => setSwitching(true)}
        />
      ) : (
        matched && (
          <button
            type="button"
            ref={otherVersions}
            onClick={() => setSwitching(true)}
            className="inline-flex min-h-touch items-center text-sm font-semibold text-text-muted underline underline-offset-4 hover:text-text"
          >
            Not the right version?
          </button>
        )
      )}
      <VersionSwitcher open={switching} item={item} onClose={closeSwitcher} />
    </div>
  )
}
