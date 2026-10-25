import type { AudioCandidate, Track } from '@fxm/core'
import { formatTime } from '@fxm/player'
import { cn } from '../../lib/cn'
import { formatConfidence, KIND_LABELS, sourceName } from '../now-playing/stream-label'
import { useQueueReviewStore } from './review-store'
import { Switch } from './switch'

function lengthOf(durationMs: number | undefined): string | undefined {
  return durationMs === undefined ? undefined : formatTime(durationMs / 1000)
}

/**
 * The best guess for `track`, to judge it before approving it: where it comes from and how sure
 * the match is, its title, kind and artists, and its length next to the track's own (a live
 * take or an edit shows up there).
 */
export function BestGuessCard({
  track,
  guess,
  className,
}: {
  track: Track
  guess: AudioCandidate
  className?: string
}) {
  const kind = guess.kind === 'song' ? undefined : KIND_LABELS[guess.kind]
  const guessLength = lengthOf(guess.durationMs)
  const ownLength = lengthOf(track.durationMs)
  const length =
    guessLength === undefined || ownLength === undefined
      ? guessLength
      : `${guessLength} (original ${ownLength})`
  const details = [kind, guess.artists.join(', '), length].filter(Boolean).join(' · ')
  return (
    <div className={cn('rounded-lg bg-elevated px-3 py-2', className)}>
      <p className="text-xs font-semibold text-text-muted">
        Best guess on {sourceName(guess.source)} · match {formatConfidence(guess.confidence)}
      </p>
      <p className="mt-0.5 truncate font-semibold">{guess.title}</p>
      <p className="text-sm text-text-muted">{details}</p>
    </div>
  )
}

/** The "Play best guesses" setting, saved with the review list and passed to the policy. */
export function BestGuessesSetting({ className }: { className?: string }) {
  const playBestGuesses = useQueueReviewStore((state) => state.playBestGuesses)
  const setPlayBestGuesses = useQueueReviewStore((state) => state.setPlayBestGuesses)
  return (
    <Switch
      label="Play best guesses"
      description="Play FXM’s best guess for songs like these, without asking."
      checked={playBestGuesses}
      onChange={setPlayBestGuesses}
      {...(className === undefined ? {} : { className })}
    />
  )
}
