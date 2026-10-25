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

function CandidateOption({
  candidate,
  result,
  name,
  checked,
  onSelect,
}: {
  candidate: AudioCandidate
  result: RowResult
  name: string
  checked: boolean
  onSelect: () => void
}) {
  const extras = result.extras?.[candidate.ref]
  const badges = [
    candidate.signals?.isrcVerified ? 'Same recording (ISRC)' : undefined,
    candidate.kind === 'song' ? undefined : 'Video',
  ].filter((badge): badge is string => badge !== undefined)
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-2 has-[:checked]:border-accent">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="size-4 shrink-0 accent-accent"
      />
      <CoverArt
        src={extras?.artwork?.url}
        seed={candidate.ref}
        icon={Music}
        rounded="sm"
        className="size-10"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{candidate.title}</span>
        <span className="block truncate text-sm text-text-muted">
          {details([
            candidate.artists.join(', '),
            extras?.album?.name,
            lengthText(candidate.durationMs),
          ])}
        </span>
        {badges.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {badges.map((badge) => (
              <span
                key={badge}
                className="rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold"
              >
                {badge}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="shrink-0 text-sm text-text-muted">
        {Math.round(candidate.confidence * 100)}% match
      </span>
    </label>
  )
}

/**
 * One row of an import's review list: what the input says, the best guess and the
 * alternatives to choose from, and the decision.
 */
export function ReviewItem({
  index,
  row,
  result,
  onDecision,
}: {
  index: number
  row: StoredRow
  result: RowResult
  onDecision: (decision: ReviewDecision) => Promise<void>
}) {
  const candidates = [result.best, ...(result.alternatives ?? [])].filter(
    (candidate): candidate is AudioCandidate => candidate !== undefined,
  )
  const [selected, setSelected] = useState(candidates[0]?.ref)
  const [busy, setBusy] = useState(false)
  const name = useId()
  const title = row.title === '' ? (row.location ?? 'Unknown song') : row.title
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
        <p className="font-semibold">
          <span className="text-text-muted">{index + 1}. </span>
          {title}
        </p>
        <p className="text-sm text-text-muted">
          {details([row.artists.join(', '), row.album, lengthText(row.durationMs)])}
        </p>
      </div>
      {candidates.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">
            {result.verdict === 'auto' ? 'Likely this song' : 'Is it one of these?'}
          </legend>
          {candidates.map((candidate) => (
            <CandidateOption
              key={candidate.ref}
              candidate={candidate}
              result={result}
              name={name}
              checked={selected === candidate.ref}
              onSelect={() => setSelected(candidate.ref)}
            />
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-text-muted">Nothing close enough was found.</p>
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
            disabled={busy || selected === undefined}
            aria-label={`Use the chosen song for ${title}`}
            onClick={() => selected !== undefined && decide({ action: 'confirm', ref: selected })}
          >
            Use this song
          </button>
        )}
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost', className: 'h-9 px-4' })}
          disabled={busy}
          aria-label={`Skip ${title}`}
          onClick={() => decide({ action: 'skip' })}
        >
          Skip
        </button>
      </div>
    </li>
  )
}
