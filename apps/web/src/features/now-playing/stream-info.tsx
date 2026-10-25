import type { AudioCandidate, QueueItem } from '@fxm/core'
import { AudioLines, Check, ChevronDown, CircleHelp, Link2 } from 'lucide-react'
import { Fragment, useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { chooseVersion } from '../queue/review-actions'
import { useQueueReviewStore } from '../queue/review-store'
import { usePlayerState } from './playback'
import { describeStream, isMatched, sourceName } from './stream-label'
import { VersionSwitcher } from './version-switcher'

const CHIP =
  'relative inline-flex h-8 max-w-full items-center gap-1.5 rounded-full px-3 text-xs font-semibold whitespace-nowrap'

/** Asks whether a best guess is the right recording, while it plays or waits for review. */
function BestGuessNotice({
  item,
  bestGuess,
  onOtherVersions,
}: {
  item: QueueItem
  bestGuess: AudioCandidate
  onOtherVersions: () => void
}) {
  const { track } = item
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
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClasses({ className: 'h-10 px-4' })}
          // Approve what plays: the best guess, or a version the user already picked.
          onClick={() => chooseVersion(track, item.candidate ?? bestGuess)}
        >
          <Check aria-hidden="true" />
          It’s right
        </button>
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
 */
export function StreamInfo({ item }: { item: QueueItem }) {
  const stream = usePlayerState((state) => state.stream)
  const bestGuess = useQueueReviewStore((state) => state.entries[item.track.id])
  const [showDetails, setShowDetails] = useState(false)
  const [switching, setSwitching] = useState(false)
  const detailsId = useId()
  const { badge, match, details } = describeStream(item.track, item.candidate, stream)
  const matched = isMatched(item.track, item.candidate)

  return (
    <div className="mt-4 space-y-3">
      {(badge !== undefined || match !== undefined) && (
        <div className="flex flex-wrap items-center gap-2">
          {badge !== undefined && (
            <button
              type="button"
              aria-expanded={showDetails}
              aria-controls={detailsId}
              onClick={() => setShowDetails(!showDetails)}
              className={cn(
                CHIP,
                // The ::after extends the hit area to 44px without changing the look.
                'border border-border text-text-muted transition-colors after:absolute after:-inset-1.5 hover:border-border-strong hover:text-text',
              )}
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
            <span className={cn(CHIP, 'bg-elevated text-text forced-colors:border')}>
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
          onOtherVersions={() => setSwitching(true)}
        />
      ) : (
        matched && (
          <button
            type="button"
            onClick={() => setSwitching(true)}
            className="inline-flex min-h-touch items-center text-sm font-semibold text-text-muted underline underline-offset-4 hover:text-text"
          >
            Not the right version?
          </button>
        )
      )}
      <VersionSwitcher open={switching} item={item} onClose={() => setSwitching(false)} />
    </div>
  )
}
