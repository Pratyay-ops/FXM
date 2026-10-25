import { History, ListMusic, Pause, Play, Trash2, X } from 'lucide-react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { useLive } from '../../db/hooks'
import type { ImportProgressRecord } from '../../db/types'
import { cn } from '../../lib/cn'
import { addedLabel, countLabel } from '../library/format'
import { playlistPath } from '../library/paths'
import { failureText } from '../library/playlist-dialogs'
import { showStatus } from '../library/status'
import { countsText, kindLabel, type ShownStatus, shownStatus, statusText } from './format'
import { importPath } from './paths'
import {
  cancelImport,
  HISTORY_IMPORT_KIND,
  pauseImport,
  removeImport,
  resumeImport,
  useImportRunner,
} from './runner'
import type { ImportServicesAccess } from './services'

/** Runs an action, saying so when it fails. */
function act(work: () => Promise<unknown>): void {
  work().catch((error: unknown) => showStatus(failureText(error)))
}

/** The actions an import offers in its state. */
export function ImportActions({
  record,
  status,
  services,
  compact = false,
}: {
  record: ImportProgressRecord
  status: ShownStatus
  services: ImportServicesAccess
  compact?: boolean
}) {
  const label = record.label
  const small = buttonClasses({ variant: 'secondary', className: compact ? 'h-9 px-4' : '' })
  const canResume = status === 'paused' || status === 'interrupted'
  const canPause = status === 'running' || status === 'pending'
  const finished = status === 'done' || status === 'cancelled' || status === 'failed'
  return (
    <div className="flex flex-wrap gap-2">
      {canResume && (
        <button
          type="button"
          className={small}
          aria-label={`Resume importing ${label}`}
          onClick={() => act(async () => resumeImport(record.id, await services.get()))}
        >
          <Play aria-hidden="true" />
          Resume
        </button>
      )}
      {canPause && (
        <button
          type="button"
          className={small}
          aria-label={`Pause importing ${label}`}
          onClick={() => act(() => pauseImport(record.id))}
        >
          <Pause aria-hidden="true" />
          Pause
        </button>
      )}
      {(canPause || canResume) && (
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost', className: compact ? 'h-9 px-4' : '' })}
          aria-label={`Cancel importing ${label}`}
          onClick={() => act(() => cancelImport(record.id))}
        >
          <X aria-hidden="true" />
          Cancel
        </button>
      )}
      {finished && (
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost', className: compact ? 'h-9 px-4' : '' })}
          aria-label={`Remove ${label} from this list`}
          onClick={() => act(() => removeImport(record.id))}
        >
          <Trash2 aria-hidden="true" />
          Remove
        </button>
      )}
    </div>
  )
}

/** A progress bar for an import. */
export function ImportProgress({ record }: { record: ImportProgressRecord }) {
  const share = record.total === 0 ? 1 : record.done / record.total
  return (
    <div
      role="progressbar"
      aria-label={`${record.label}: progress`}
      aria-valuemin={0}
      aria-valuemax={record.total}
      aria-valuenow={record.done}
      className="h-1.5 overflow-hidden rounded-full bg-elevated forced-colors:border"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300 forced-colors:bg-[Highlight]"
        style={{ width: `${Math.round(share * 100)}%` }}
      />
    </div>
  )
}

function ImportCard({
  record,
  services,
}: {
  record: ImportProgressRecord
  services: ImportServicesAccess
}) {
  const activeId = useImportRunner((state) => state.activeId)
  const queued = useImportRunner((state) => state.queued)
  const activity = useImportRunner((state) =>
    state.activeId === record.id ? state.activity : null,
  )
  const status = shownStatus(record, activeId, queued)
  const history = record.kind === HISTORY_IMPORT_KIND
  const Icon = history ? History : ListMusic
  return (
    <li className="space-y-3 rounded-2xl border border-border p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-elevated text-text-muted">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{record.label}</p>
          <p className="truncate text-sm text-text-muted">
            {kindLabel(record.kind)} · {addedLabel(record.createdAt)} · {countsText(record)}
          </p>
        </div>
      </div>
      <ImportProgress record={record} />
      <p
        className={cn(
          'text-sm',
          status === 'failed' || (status === 'paused' && record.error)
            ? 'text-danger'
            : 'text-text-muted',
        )}
      >
        {statusText(record, status, activity ?? {})}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!history && (
          <Link
            to={importPath(record.id)}
            className={buttonClasses({ className: 'h-9 px-4' })}
            aria-label={
              record.needsReview > 0
                ? `Review ${countLabel(record.needsReview, 'song')} of ${record.label}`
                : `Match report of ${record.label}`
            }
          >
            {record.needsReview > 0
              ? `Review ${record.needsReview.toLocaleString('en')}`
              : 'Match report'}
          </Link>
        )}
        {record.playlistId !== undefined && (
          <Link
            to={playlistPath(record.playlistId)}
            className={buttonClasses({ variant: 'secondary', className: 'h-9 px-4' })}
            aria-label={`Open the playlist ${record.label}`}
          >
            Open playlist
          </Link>
        )}
        <ImportActions record={record} status={status} services={services} compact />
      </div>
    </li>
  )
}

/** Every import, most recently updated first, with its progress and actions. */
export function ImportList({ services }: { services: ImportServicesAccess }) {
  const live = useLive((repo) => repo.listImports(), [])
  if (live.status === 'loading') return null
  if (live.status === 'error') {
    return (
      <p role="alert" className="text-text-muted">
        Your imports can’t be read in this browser window. Private windows and turned-off site data
        can block it.
      </p>
    )
  }
  if (live.data.length === 0) return null
  return (
    <section aria-labelledby="your-imports" className="space-y-4">
      <h2 id="your-imports" className="text-xl font-bold tracking-tight">
        Your imports
      </h2>
      <ul className="space-y-3">
        {live.data.map((record) => (
          <ImportCard key={record.id} record={record} services={services} />
        ))}
      </ul>
    </section>
  )
}
