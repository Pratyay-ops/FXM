import { importBlockOf } from '@fxm/sources/import'
import {
  Ellipsis,
  History,
  ListMusic,
  ListX,
  Pause,
  Play,
  RotateCcw,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { useLive } from '../../db/hooks'
import { getLibrary } from '../../db/repo'
import type { ImportProgressRecord } from '../../db/types'
import { cn } from '../../lib/cn'
import { failureText } from '../library/failure'
import { addedLabel, countLabel } from '../library/format'
import { playlistPath } from '../library/paths'
import { showStatus } from '../library/status'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { Menu, type MenuItem } from '../library/ui/menu'
import { focusImportTitle, focusWhenReady, importTitleId, useFocusTitleWhenGone } from './focus'
import {
  canPause,
  canResume,
  countsText,
  isAlarming,
  isBusy,
  kindLabel,
  type ShownStatus,
  shownStatus,
  statusText,
} from './format'
import { useRunnerView } from './hooks'
import { ImportBusyError } from './locks'
import { MatchingNotice } from './matching-notice'
import { importPath } from './paths'
import {
  cancelImport,
  HISTORY_IMPORT_KIND,
  type ImportActivity,
  pauseImport,
  removeImport,
  resumeImport,
  retryFailedSongs,
  useImportRunner,
} from './runner'
import type { ImportServicesAccess, MatchingAvailability } from './services'

/** Why an import action failed, for people. */
export function actionFailureText(error: unknown): string {
  if (error instanceof ImportBusyError) return error.message
  return failureText(error)
}

/** One line on where an import stands; only a failure that needs the user stands out. */
export function ImportStatusLine({
  record,
  status,
  activity,
  matching,
}: {
  record: ImportProgressRecord
  status: ShownStatus
  activity: ImportActivity | null
  matching: MatchingAvailability | undefined
}) {
  return (
    <p className={cn('text-sm', isAlarming(record, status) ? 'text-danger' : 'text-text-muted')}>
      {statusText(record, status, { activity, blocked: importBlockOf(record.state), matching })}
    </p>
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

/**
 * How a button looks while its action runs. It is only `aria-disabled` then, not `disabled`:
 * browsers move focus off a button they disable, to the top of the document.
 */
const WORKING_CLASSES = 'aria-disabled:pointer-events-none aria-disabled:opacity-50'

/** Whether an import's playlist has no songs: then stopping it offers to delete the playlist. */
async function playlistIsEmpty(record: ImportProgressRecord): Promise<boolean> {
  if (record.playlistId === undefined) return false
  const view = await getLibrary()
    .getPlaylistView(record.playlistId)
    .catch(() => undefined)
  return view !== undefined && view.rows.length === 0
}

/**
 * "Cancel importing …?" or "Remove … from your imports?", with "Delete the empty playlist too"
 * when the import's playlist has no songs.
 */
function StopImportDialog({
  record,
  action,
  emptyPlaylist,
  onClose,
  onDone,
}: {
  record: ImportProgressRecord
  action: 'cancel' | 'remove' | null
  emptyPlaylist: boolean
  onClose: () => void
  onDone: (action: 'cancel' | 'remove') => void
}) {
  const [deletePlaylist, setDeletePlaylist] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cancel = action === 'cancel'
  const close = () => {
    setError('')
    onClose()
  }
  const confirm = async () => {
    if (action === null || busy) return
    setBusy(true)
    setError('')
    try {
      if (cancel) await cancelImport(record.id)
      else await removeImport(record.id)
      if (emptyPlaylist && deletePlaylist && record.playlistId !== undefined) {
        await getLibrary().deletePlaylist(record.playlistId)
      }
      showStatus(cancel ? `Cancelled importing ${record.label}` : `Removed ${record.label}`)
      onClose()
      onDone(action)
    } catch (failure) {
      setError(actionFailureText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={action !== null}
      onClose={close}
      title={cancel ? `Cancel importing “${record.label}”?` : `Remove “${record.label}”?`}
      description={
        <p>
          {cancel
            ? 'The import stops for good: it can’t be resumed. The songs it found stay in the playlist.'
            : 'The import leaves this list, with its match report.'}
        </p>
      }
    >
      {emptyPlaylist && (
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={deletePlaylist}
            onChange={() => setDeletePlaylist((value) => !value)}
            className="size-4 shrink-0 accent-accent"
          />
          Delete the empty playlist too
        </label>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={close}>
          {cancel ? 'Keep importing' : 'Keep it'}
        </button>
        <button
          type="button"
          data-autofocus=""
          aria-disabled={busy || undefined}
          className={buttonClasses({ variant: 'danger', className: WORKING_CLASSES })}
          onClick={confirm}
        >
          {cancel ? 'Cancel import' : 'Remove'}
        </button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * Runs an import action, saying so when it fails, and tells whether one is under way. One at a
 * time: an action started while another runs is ignored.
 */
function useAction() {
  const [working, setWorking] = useState(false)
  const busy = useRef(false)
  const run = async (work: () => Promise<unknown>, after?: () => void) => {
    if (busy.current) return
    busy.current = true
    setWorking(true)
    try {
      await work()
      after?.()
    } catch (error) {
      showStatus(actionFailureText(error))
    } finally {
      busy.current = false
      setWorking(false)
    }
  }
  return { working, run }
}

/**
 * The import's menu: Open playlist, Cancel (after a confirmation, with "Delete the empty
 * playlist too" when it has no songs) and Remove. Nothing when none applies.
 */
export function ImportMenu({
  record,
  status,
  playlistInMenu,
  onRemoved,
  className,
}: {
  record: ImportProgressRecord
  status: ShownStatus
  /** Whether the menu offers "Open playlist". */
  playlistInMenu: boolean
  /** Called once the import was removed. */
  onRemoved: () => void
  className?: string
}) {
  const navigate = useNavigate()
  const { run } = useAction()
  const [dialog, setDialog] = useState<'cancel' | 'remove' | null>(null)
  const [emptyPlaylist, setEmptyPlaylist] = useState(false)
  const history = record.kind === HISTORY_IMPORT_KIND
  const stoppable = canPause(record, status) || canResume(record, status)

  const openDialog = async (action: 'cancel' | 'remove') => {
    const empty = await playlistIsEmpty(record)
    if (action === 'remove' && !empty) {
      await run(async () => {
        await removeImport(record.id)
        showStatus(`Removed ${record.label}`)
      }, onRemoved)
      return
    }
    setEmptyPlaylist(empty)
    setDialog(action)
  }

  const items: MenuItem[] = []
  if (playlistInMenu && record.playlistId !== undefined) {
    const playlistId = record.playlistId
    items.push({
      id: 'open',
      label: 'Open playlist',
      icon: SquareArrowOutUpRight,
      onSelect: () => navigate(playlistPath(playlistId)),
    })
  }
  if (!history && stoppable) {
    items.push({
      id: 'cancel',
      label: 'Cancel import…',
      icon: ListX,
      onSelect: () => void openDialog('cancel'),
    })
  }
  if (!isBusy(status)) {
    items.push({
      id: 'remove',
      label: 'Remove from list',
      icon: Trash2,
      onSelect: () => void openDialog('remove'),
    })
  }
  if (items.length === 0) return null
  return (
    <>
      <Menu
        label={`More options for ${record.label}`}
        iconOnly
        className={iconButtonClasses({ size: 'sm', className })}
        items={items}
      >
        <Ellipsis aria-hidden="true" />
      </Menu>
      <StopImportDialog
        record={record}
        action={dialog}
        emptyPlaylist={emptyPlaylist}
        onClose={() => setDialog(null)}
        onDone={(action) => (action === 'remove' ? onRemoved() : focusImportTitle(record.id))}
      />
    </>
  )
}

/**
 * What an import offers in its state: one Pause/Resume button (the same element, so focus stays
 * on it as it changes), and Retry for failed songs. While an action runs, both stay focusable and
 * ignore presses. After an action that takes its button away (Retry), or when a focused button
 * goes away by itself (Pause once the import finishes), focus moves to the import's title.
 */
export function ImportControls({
  record,
  status,
  services,
  resumeIsMain,
  afterToggle,
}: {
  record: ImportProgressRecord
  status: ShownStatus
  services: ImportServicesAccess
  /** Whether Resume is the page's main action, in the accent color. */
  resumeIsMain: boolean
  /** What comes right after the Pause/Resume button, e.g. a link to the match report. */
  afterToggle?: ReactNode
}) {
  const { working, run } = useAction()
  const keepFocus = useFocusTitleWhenGone(record.id)
  const label = record.label
  const history = record.kind === HISTORY_IMPORT_KIND
  const pausable = canPause(record, status)
  const resumable = canResume(record, status)
  const canRetry = !history && record.failed > 0 && !isBusy(status) && status !== 'cancelled'

  const toggle = () =>
    run(async () => {
      if (pausable) await pauseImport(record.id)
      else await resumeImport(record.id, await services.get())
    })

  const retry = () =>
    run(
      async () => {
        const count = await retryFailedSongs(record.id, await services.get())
        showStatus(
          count === 0 ? 'Nothing to try again' : `Trying ${countLabel(count, 'song')} again`,
        )
      },
      () => focusImportTitle(record.id),
    )

  return (
    <>
      {(pausable || resumable) && (
        <button
          key="toggle"
          ref={keepFocus}
          type="button"
          aria-disabled={working || undefined}
          className={buttonClasses({
            variant: resumable && resumeIsMain ? 'primary' : 'secondary',
            className: cn('h-9 px-4', WORKING_CLASSES),
          })}
          aria-label={pausable ? `Pause importing ${label}` : `Resume importing ${label}`}
          onClick={toggle}
        >
          {pausable ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {pausable ? 'Pause' : 'Resume'}
        </button>
      )}
      {afterToggle}
      {canRetry && (
        <button
          key="retry"
          ref={keepFocus}
          type="button"
          aria-disabled={working || undefined}
          className={buttonClasses({
            variant: 'secondary',
            className: cn('h-9 px-4', WORKING_CLASSES),
          })}
          aria-label={`Try the ${countLabel(record.failed, 'failed song')} of ${label} again`}
          onClick={retry}
        >
          <RotateCcw aria-hidden="true" />
          Retry {record.failed.toLocaleString('en')} failed
        </button>
      )}
    </>
  )
}

function ImportCard({
  record,
  status,
  services,
  matching,
  onRemoved,
}: {
  record: ImportProgressRecord
  status: ShownStatus
  services: ImportServicesAccess
  matching: MatchingAvailability | undefined
  onRemoved: () => void
}) {
  const activity = useImportRunner((runner) =>
    runner.activeId === record.id ? runner.activity : null,
  )
  const history = record.kind === HISTORY_IMPORT_KIND
  const Icon = history ? History : ListMusic
  const review = !history && record.needsReview > 0
  const resumeIsMain = !review
  return (
    <li className="space-y-3 rounded-2xl border border-border p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-elevated text-text-muted">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            id={importTitleId(record.id)}
            tabIndex={-1}
            className="line-clamp-2 font-semibold break-words outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {record.label}
          </h3>
          <p className="text-sm text-text-muted">
            {kindLabel(record.kind)} · {addedLabel(record.createdAt)}
            {/* On phones the counts start a line of their own: the separator is for screen
                readers only there, so they never hear "today2 songs". */}
            <span className="max-sm:sr-only">{' · '}</span>
            <span className="block sm:inline">{countsText(record)}</span>
          </p>
        </div>
        <ImportMenu
          record={record}
          status={status}
          playlistInMenu
          onRemoved={onRemoved}
          className="-mt-1 -mr-2"
        />
      </div>
      <ImportProgress record={record} />
      <ImportStatusLine record={record} status={status} activity={activity} matching={matching} />
      <div className="flex flex-wrap items-center gap-2">
        {review && (
          <Link
            key="review"
            to={importPath(record.id)}
            className={buttonClasses({ className: 'h-9 px-4' })}
            aria-label={`Review ${countLabel(record.needsReview, 'song')} of ${record.label}`}
          >
            Review {record.needsReview.toLocaleString('en')}
          </Link>
        )}
        <ImportControls
          record={record}
          status={status}
          services={services}
          resumeIsMain={resumeIsMain}
          afterToggle={
            !history &&
            !review && (
              <Link
                key="report"
                to={importPath(record.id)}
                className={buttonClasses({ variant: 'secondary', className: 'h-9 px-4' })}
                aria-label={`Match report of ${record.label}`}
              >
                Match report
              </Link>
            )
          }
        />
      </div>
    </li>
  )
}

/**
 * Every import, newest first (an order that stays put while they run), with its progress and
 * actions. `focusId`: an import whose card gets the focus once it shows, e.g. one just started.
 */
export function ImportList({
  services,
  matching,
  focusId,
  onFocused,
}: {
  services: ImportServicesAccess
  matching: MatchingAvailability | undefined
  focusId?: string | null
  onFocused?: () => void
}) {
  const live = useLive((repo) => repo.listImports(), [])
  const records = useMemo(
    () => (live.status === 'ready' ? [...live.data].sort((a, b) => b.createdAt - a.createdAt) : []),
    [live],
  )
  const runner = useRunnerView(
    records.some((record) => record.status === 'running' || record.status === 'pending'),
  )

  useEffect(() => {
    if (!focusId || !records.some((record) => record.id === focusId)) return
    focusImportTitle(focusId, { scroll: true })
    onFocused?.()
  }, [focusId, records, onFocused])

  if (live.status === 'loading') return null
  if (live.status === 'error') {
    return (
      <p role="alert" className="text-text-muted">
        Your imports can’t be read in this browser window. Private windows and turned-off site data
        can block it.
      </p>
    )
  }
  if (records.length === 0) return null
  const waiting = records.some(
    (record) =>
      record.kind !== HISTORY_IMPORT_KIND &&
      record.done < record.total &&
      record.status !== 'cancelled' &&
      record.status !== 'failed',
  )
  const focusAfterRemoving = (index: number) => {
    const next = records[index + 1] ?? records[index - 1]
    if (next !== undefined) focusImportTitle(next.id)
    else focusWhenReady(() => document.getElementById('main'))
  }
  return (
    <section aria-labelledby="your-imports" className="space-y-4">
      <h2 id="your-imports" className="text-xl font-bold tracking-tight">
        Your imports
      </h2>
      {waiting && <MatchingNotice matching={matching} where="imports" />}
      <ul className="space-y-3">
        {records.map((record, index) => (
          <ImportCard
            key={record.id}
            record={record}
            status={shownStatus(record, runner)}
            services={services}
            matching={matching}
            onRemoved={() => focusAfterRemoving(index)}
          />
        ))}
      </ul>
    </section>
  )
}
