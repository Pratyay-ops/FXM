import { AlertTriangle, Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { useLive } from '../../db/hooks'
import { cn } from '../../lib/cn'
import { playedLabel } from '../library/format'
import { playlistPath } from '../library/paths'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { ConnectDialog, TokenDialog } from './connect-dialog'
import {
  type ConflictChoice,
  deleteKeptPlaylist,
  disconnectSync,
  rewriteGist,
  runSync,
  settleConflict,
} from './controller'
import { listConflicts, type PlaylistConflict } from './library-io'
import { problemMessage, setupErrorText } from './messages'
import { type SyncNotice, useSyncStore } from './sync-store'

/** "340 KB", "1.2 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en')} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The current time, updated every `ms` while mounted, for "5 minutes ago". */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/**
 * One row of the section, laid out like the other settings: the control beside the label, or
 * under the help when it is a row of several buttons (`stacked`).
 */
function Row({
  label,
  labelId,
  help,
  stacked = false,
  children,
}: {
  label: string
  labelId: string
  help?: ReactNode
  stacked?: boolean
  children?: ReactNode
}) {
  if (stacked) {
    return (
      <div className="space-y-3 p-4 sm:p-5">
        <div className="space-y-1">
          <p id={labelId} className="font-semibold">
            {label}
          </p>
          {help && <div className="max-w-xl text-sm text-text-muted">{help}</div>}
        </div>
        {children && <div className="flex flex-wrap gap-3">{children}</div>}
      </div>
    )
  }
  return (
    <div className="grid gap-3 p-4 sm:p-5 md:grid-cols-[minmax(0,20rem)_max-content] md:grid-rows-[auto_1fr] md:justify-between md:gap-x-8 md:gap-y-1">
      <p id={labelId} className="font-semibold md:col-start-1 md:row-start-1">
        {label}
      </p>
      {children && (
        <div className="flex min-w-0 flex-wrap gap-3 md:col-start-2 md:row-span-2 md:row-start-1 md:justify-end">
          {children}
        </div>
      )}
      {help && <div className="text-sm text-text-muted md:col-start-1 md:row-start-2">{help}</div>}
    </div>
  )
}

/** An on/off switch on a button, labelled by a visible label. */
function Switch({
  checked,
  labelledBy,
  describedBy,
  onChange,
}: {
  checked: boolean
  labelledBy: string
  describedBy?: string
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      // A 44px tall hit area around a 28px track.
      className="group relative inline-flex h-touch w-14 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-7 w-12 rounded-full transition-colors duration-200 forced-colors:border',
          checked ? 'bg-accent forced-colors:bg-[Highlight]' : 'bg-elevated',
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-1/2 left-2 size-5 -translate-y-1/2 rounded-full bg-text shadow transition-transform duration-200 forced-colors:bg-[CanvasText]',
          checked && 'translate-x-5 bg-on-accent',
        )}
      />
    </button>
  )
}

function Problem({
  onToken,
  onSetup,
  onRewrite,
}: {
  onToken: () => void
  onSetup: () => void
  onRewrite: () => void
}) {
  const problem = useSyncStore((state) => state.problem)
  if (problem === undefined) return null
  const { text, action } = problemMessage(problem)
  return (
    <div role="alert" className="flex gap-3 p-4 text-sm sm:p-5">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="min-w-0 space-y-3">
        <p className="font-semibold">{text}</p>
        {action === 'token' && (
          <button type="button" className={buttonClasses()} onClick={onToken}>
            Paste a new token
          </button>
        )}
        {action === 'setup' && (
          <button type="button" className={buttonClasses()} onClick={onSetup}>
            Set up sync again
          </button>
        )}
        {action === 'rewrite' && (
          <button type="button" className={buttonClasses()} onClick={onRewrite}>
            Rewrite the gist from this device
          </button>
        )}
      </div>
    </div>
  )
}

const CHOICES: readonly {
  choice: ConflictChoice
  label: (conflict: PlaylistConflict) => string
}[] = [
  { choice: 'keep-this', label: (conflict) => `Keep “${conflict.original.name}”` },
  { choice: 'keep-other', label: () => 'Keep the other version' },
  { choice: 'keep-both', label: () => 'Keep both' },
]

function Conflicts() {
  const live = useLive((repo) => listConflicts(repo), [])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (live.status !== 'ready' || live.data.length === 0) return null

  const settle = async (conflict: PlaylistConflict, choice: ConflictChoice) => {
    setBusy(true)
    setError('')
    try {
      await settleConflict(conflict, choice)
    } catch (failure) {
      setError(setupErrorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <h3 className="font-semibold">Playlists with two versions</h3>
      <ul className="space-y-4">
        {live.data.map((conflict) => (
          <li key={conflict.copy.id} className="space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm">
              <Link className="font-semibold underline" to={playlistPath(conflict.original.id)}>
                {conflict.original.name}
              </Link>{' '}
              changed on two devices before they synced, so FXM kept both versions. The other one is{' '}
              <Link className="font-semibold underline" to={playlistPath(conflict.copy.id)}>
                {conflict.copy.name}
              </Link>
              .
            </p>
            <div className="flex flex-wrap gap-2">
              {CHOICES.map(({ choice, label }) => (
                <button
                  key={choice}
                  type="button"
                  disabled={busy}
                  className={buttonClasses({ variant: 'secondary' })}
                  onClick={() => settle(conflict, choice)}
                >
                  {label(conflict)}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

function noticeText(notice: SyncNotice): string {
  return notice.kind === 'kept-here'
    ? `“${notice.name}” was deleted on another device, but you changed it here, so FXM kept it.`
    : `“${notice.name}” changed on another device after you deleted it here, so FXM brought it back.`
}

function Notices() {
  const notices = useSyncStore((state) => state.notices)
  const dismiss = useSyncStore((state) => state.dismissNotice)
  const [error, setError] = useState('')
  if (notices.length === 0) return null
  return (
    <div className="space-y-4 p-4 sm:p-5">
      <h3 className="font-semibold">Kept by sync</h3>
      <ul className="space-y-3">
        {notices.map((notice) => (
          <li key={notice.id} className="space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm">{noticeText(notice)}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClasses({ variant: 'secondary' })}
                onClick={() =>
                  deleteKeptPlaylist(notice.id, notice.playlistId).catch((failure: unknown) =>
                    setError(setupErrorText(failure)),
                  )
                }
              >
                Delete it
              </button>
              <button
                type="button"
                className={buttonClasses({ variant: 'ghost' })}
                onClick={() => dismiss(notice.id)}
              >
                Keep it
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  // The Clipboard API exists only in secure contexts; the link is on the page anyway.
  if (typeof navigator.clipboard?.writeText !== 'function') return null
  return (
    <button
      type="button"
      className={buttonClasses({ variant: 'secondary' })}
      onClick={() => {
        navigator.clipboard.writeText(url).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}

function Connected() {
  const login = useSyncStore((state) => state.login)
  const token = useSyncStore((state) => state.token)
  const gistUrl = useSyncStore((state) => state.gistUrl)
  const syncing = useSyncStore((state) => state.syncing)
  const lastSyncAt = useSyncStore((state) => state.lastSyncAt)
  const gistBytes = useSyncStore((state) => state.gistBytes)
  const auto = useSyncStore((state) => state.auto)
  const setAuto = useSyncStore((state) => state.setAuto)
  const now = useNow(30_000)
  const syncLabel = useId()
  const autoLabel = useId()
  const autoHelp = useId()
  const gistLabel = useId()
  const [dialog, setDialog] = useState<'token' | 'setup' | 'rewrite' | 'off' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  let status: string
  if (syncing) status = 'Syncing…'
  else if (lastSyncAt === undefined) status = 'Not synced yet.'
  else status = `Last synced ${playedLabel(lastSyncAt, now)}.`

  const rewrite = async () => {
    setBusy(true)
    setError('')
    try {
      await rewriteGist()
      setDialog(null)
    } catch (failure) {
      setError(setupErrorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Problem
        onToken={() => setDialog('token')}
        onSetup={() => setDialog('setup')}
        onRewrite={() => setDialog('rewrite')}
      />
      <Row
        label="Sync with GitHub"
        labelId={syncLabel}
        help={
          <p aria-live="polite">
            On, with the gist of <strong className="text-text">@{login}</strong>. {status}
          </p>
        }
      >
        <button
          type="button"
          className={buttonClasses()}
          disabled={syncing}
          onClick={() => void runSync('manual')}
        >
          <RefreshCw aria-hidden="true" className={cn(syncing && 'motion-safe:animate-spin')} />
          Sync now
        </button>
      </Row>
      <Row
        label="Sync automatically"
        labelId={autoLabel}
        help={
          <p id={autoHelp}>
            After you change your library, when you come back to FXM, and every 15 minutes while it
            is open. New plays sync less often, to save data.
          </p>
        }
      >
        <Switch checked={auto} labelledBy={autoLabel} describedBy={autoHelp} onChange={setAuto} />
      </Row>
      <Row
        label="Your sync gist"
        labelId={gistLabel}
        stacked
        help={
          <p>
            {gistBytes !== undefined &&
              `It holds ${sizeLabel(gistBytes)}, which GitHub sends back after each change. `}
            To sync another device, set sync up there with a token of the same account. If it
            doesn’t find this gist, paste its link.
          </p>
        }
      >
        {gistUrl !== undefined && (
          <>
            <a
              href={gistUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClasses({ variant: 'secondary' })}
            >
              Open on GitHub
              <ExternalLink aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <CopyLink url={gistUrl} />
          </>
        )}
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost' })}
          onClick={() => setDialog('off')}
        >
          Turn off sync
        </button>
      </Row>
      <Conflicts />
      <Notices />
      <TokenDialog open={dialog === 'token'} onClose={() => setDialog(null)} />
      <ConnectDialog
        open={dialog === 'setup'}
        onClose={() => setDialog(null)}
        initialToken={token}
      />
      <Dialog
        open={dialog === 'rewrite'}
        onClose={() => setDialog(null)}
        title="Rewrite the gist?"
        description="FXM replaces what’s in your sync gist with this device’s library. Your other devices keep their libraries and add back what this device lacks at their next sync."
      >
        {error && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        )}
        <DialogActions>
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() => setDialog(null)}
          >
            Cancel
          </button>
          <button type="button" className={buttonClasses()} disabled={busy} onClick={rewrite}>
            {busy ? 'Rewriting…' : 'Rewrite the gist'}
          </button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={dialog === 'off'}
        onClose={() => setDialog(null)}
        title="Turn off sync on this device?"
        description="FXM forgets your token on this device. Your library stays here, and the gist stays on GitHub: delete it there if you no longer need it."
      >
        <DialogActions>
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() => setDialog(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={buttonClasses({ variant: 'danger' })}
            onClick={() => {
              disconnectSync()
              setDialog(null)
            }}
          >
            Turn off sync
          </button>
        </DialogActions>
      </Dialog>
    </>
  )
}

function NotConnected() {
  const labelId = useId()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Row
        label="Sync with GitHub"
        labelId={labelId}
        help={
          <p>
            Keep your library and settings the same on all your devices. FXM keeps them in a secret
            gist on your own GitHub account, with a token you create: FXM has no servers.
          </p>
        }
      >
        <button type="button" className={buttonClasses()} onClick={() => setOpen(true)}>
          Set up sync
        </button>
      </Row>
      <ConnectDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** The Sync section of Settings: set up, status and controls, conflicts and notices. */
export function SyncSettings() {
  const connected = useSyncStore(
    (state) => state.token !== undefined && state.gistId !== undefined && state.login !== undefined,
  )
  return connected ? <Connected /> : <NotConnected />
}
