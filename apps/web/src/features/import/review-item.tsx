import type { AudioCandidate } from '@fxm/core'
import type { ReviewDecision, RowResult, StoredRow } from '@fxm/sources/import'
import { Music } from 'lucide-react'
import { useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { CoverArt } from '../library/cover-art'
import { lengthText } from './format'

/** "Radiohead · Pablo Honey · 3:58": what a row or a candidate says besides its title. */
function details(parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== '').join(' · ')
}

/** The `id` of a review item's title, for focus. */
export function reviewTitleId(index: number): string {
  return `review-title-${index}`
}

/** What a row is called in the review list: its title, else where an M3U line points. */
export function rowTitle(row: StoredRow): string {
  return row.title === '' ? (row.location ?? 'Unknown song') : row.title
}

/** The candidates of a row: the best guess first, then the alternatives. */
export function candidatesOf(result: RowResult): AudioCandidate[] {
  return [result.best, ...(result.alternatives ?? [])].filter(
    (candidate): candidate is AudioCandidate => candidate !== undefined,
  )
}

const BADGE = 'rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold'

/**
 * One candidate to choose. On a phone it stacks (the title on two lines, the details wrapping,
 * the match share among the badges), so the album and length that tell versions apart stay
 * readable; from `sm` up, the share sits on the right.
 */
function CandidateOption({
  candidate,
  result,
  name,
  checked,
  disabled,
  onSelect,
}: {
  candidate: AudioCandidate
  result: RowResult
  name: string
  checked: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const extras = result.extras?.[candidate.ref]
  const share = `${Math.round(candidate.confidence * 100)}% match`
  const badges = [
    candidate.signals?.isrcVerified ? 'Same recording (ISRC)' : undefined,
    candidate.kind === 'song' ? undefined : 'Video',
  ].filter((badge): badge is string => badge !== undefined)
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-2 has-[:checked]:border-accent has-[:disabled]:cursor-default">
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-1 size-4 shrink-0 accent-accent"
      />
      <CoverArt
        src={extras?.artwork?.url}
        seed={candidate.ref}
        icon={Music}
        rounded="sm"
        className="size-8 sm:size-10"
      />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 font-semibold break-words">{candidate.title}</span>
        <span className="block text-sm break-words text-text-muted">
          {details([
            candidate.artists.join(', '),
            extras?.album?.name,
            lengthText(candidate.durationMs),
          ])}
        </span>
        <span className="mt-1 flex flex-wrap gap-1 empty:hidden">
          {badges.map((badge) => (
            <span key={badge} className={BADGE}>
              {badge}
            </span>
          ))}
          <span className={`${BADGE} sm:hidden`}>{share}</span>
        </span>
      </span>
      <span className="hidden shrink-0 text-sm text-text-muted sm:block">{share}</span>
    </label>
  )
}

/** A decided row, kept in place for the session as one line with Undo. */
export function DecidedItem({
  index,
  row,
  text,
  disabled,
  onUndo,
}: {
  index: number
  row: StoredRow
  /** What was decided, e.g. "Using “Get Lucky (Radio Edit)”". */
  text: string
  disabled: boolean
  onUndo: () => void
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-border px-4 py-2 text-sm">
      <p className="min-w-0 flex-1 py-1.5 break-words">
        <span className="text-text-muted">{index + 1}. </span>
        <span className="font-semibold">{rowTitle(row)}</span>
        <span className="text-text-muted"> · {text}</span>
      </p>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Undo: ${rowTitle(row)}`}
        className="inline-flex h-touch items-center rounded-md font-semibold text-accent underline-offset-2 hover:underline disabled:opacity-50 lg:h-8 lg:pointer-coarse:h-touch"
        onClick={onUndo}
      >
        Undo
      </button>
    </li>
  )
}

/**
 * One row of an import's review list: what the input says, the best guess and the
 * alternatives to choose from, and the decision. `disabled` while another tab runs the import.
 */
export function ReviewItem({
  index,
  row,
  result,
  disabled = false,
  onDecision,
}: {
  index: number
  row: StoredRow
  result: RowResult
  disabled?: boolean
  onDecision: (decision: ReviewDecision) => Promise<void>
}) {
  const candidates = candidatesOf(result)
  const [selected, setSelected] = useState(candidates[0]?.ref)
  const [busy, setBusy] = useState(false)
  const name = useId()
  const titleId = reviewTitleId(index)
  const title = rowTitle(row)
  const decide = async (decision: ReviewDecision) => {
    setBusy(true)
    try {
      await onDecision(decision)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="space-y-3 rounded-2xl border border-border p-4">
      <div>
        <h3
          id={titleId}
          tabIndex={-1}
          className="font-semibold break-words outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span className="text-text-muted">{index + 1}. </span>
          {title}
        </h3>
        <p className="text-sm break-words text-text-muted">
          {details([row.artists.join(', '), row.album, lengthText(row.durationMs)])}
        </p>
      </div>
      {candidates.length > 0 ? (
        <fieldset className="min-w-0 space-y-2">
          <legend className="mb-1 text-sm font-semibold">
            {result.verdict === 'auto'
              ? `Likely the right song for “${title}”`
              : `Is “${title}” one of these?`}
          </legend>
          {candidates.map((candidate) => (
            <CandidateOption
              key={candidate.ref}
              candidate={candidate}
              result={result}
              name={name}
              checked={selected === candidate.ref}
              disabled={disabled}
              onSelect={() => setSelected(candidate.ref)}
            />
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-text-muted">
          Nothing close enough was found.
          {(row.kind === 'video' || row.kind === 'music-video') &&
            ' The video stays in the playlist and plays in the Music + Video mode.'}
        </p>
      )}
      {result.noDuration && (
        <p className="text-xs text-text-muted">
          The import had no length for this song, so FXM can’t be sure of the version.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {candidates.length > 0 && (
          <button
            type="button"
            className={buttonClasses({ className: 'h-9 px-4' })}
            disabled={disabled || busy || selected === undefined}
            aria-label={`Use the chosen song for ${title}`}
            onClick={() => selected !== undefined && decide({ action: 'confirm', ref: selected })}
          >
            Use this song
          </button>
        )}
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost', className: 'h-9 px-4' })}
          disabled={disabled || busy}
          aria-label={`Skip ${title}`}
          onClick={() => decide({ action: 'skip' })}
        >
          Skip
        </button>
      </div>
    </li>
  )
}
