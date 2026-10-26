import { FileDown, FileUp } from 'lucide-react'
import { type ChangeEvent, useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import {
  BackupError,
  type BackupErrorCode,
  backupBlob,
  backupFileName,
  exportLibrary,
  type ImportMode,
  importLibrary,
  MAX_BACKUP_BYTES,
  type ParsedBackup,
  parseBackup,
} from '../../db/backup'
import { useLibrary } from '../../db/hooks'
import { cn } from '../../lib/cn'
import { sanitizeSettings, useSettingsStore } from '../settings/settings-store'
import { isConnected, useSyncStore } from '../sync/sync-store'
import { failureText } from './failure'
import { addedLabel, countLabel } from './format'
import { showStatus } from './status'
import { Dialog } from './ui/dialog'

/** Where this browser remembers its last backup (a convenience, so failures are ignored). */
const LAST_BACKUP_KEY = 'fxm.library.lastBackup'

function readLastBackup(): number | undefined {
  try {
    const value = Number(localStorage.getItem(LAST_BACKUP_KEY))
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function writeLastBackup(at: number): void {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(at))
  } catch {
    // Storage blocked: the date is only a reminder.
  }
}

const ERRORS: Readonly<Record<BackupErrorCode, string>> = {
  'too-large': 'That file is too large to be an FXM backup.',
  'not-json': 'That file isn’t an FXM backup: it can’t be read as JSON.',
  'not-a-backup': 'That file isn’t an FXM library backup.',
  'too-new': 'That backup comes from a newer version of FXM. Update FXM, then try again.',
}

/** Saves a file through a temporary download link. */
function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const MODES: readonly {
  value: ImportMode
  label: string
  help: string
  /** Added to the help while sync is on. */
  syncHelp?: string
}[] = [
  {
    value: 'merge',
    label: 'Merge',
    help: 'Keep this library and add what the backup has.',
  },
  {
    value: 'replace',
    label: 'Replace',
    help: 'Make this library exactly the backup, settings included. What is here now is removed.',
    syncHelp:
      'Sync removes it from your other devices too, and they ask you first when it’s a lot.',
  },
]

function Restore({ onDone }: { onDone: () => void }) {
  const repo = useLibrary()
  const [file, setFile] = useState<{ name: string; parsed: ParsedBackup } | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const syncOn = useSyncStore(isConnected)
  const groupId = useId()

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    setError('')
    setFile(null)
    if (!chosen) return
    if (chosen.size > MAX_BACKUP_BYTES) {
      setError(ERRORS['too-large'])
      return
    }
    try {
      setFile({ name: chosen.name, parsed: parseBackup(await chosen.text()) })
    } catch (failure) {
      setError(failure instanceof BackupError ? ERRORS[failure.code] : 'That file can’t be read.')
    }
  }

  const restore = async () => {
    if (!file) return
    setBusy(true)
    try {
      await importLibrary(repo, file.parsed, mode)
      const settings = file.parsed.backup.appSettings
      if (mode === 'replace' && settings !== undefined) {
        useSettingsStore.setState(sanitizeSettings(settings))
      }
      showStatus(
        mode === 'replace' ? 'Library replaced from the backup' : 'Backup merged into your library',
      )
      onDone()
    } catch (failure) {
      setError(failureText(failure))
      setBusy(false)
    }
  }

  const summary = file?.parsed.summary
  return (
    <section aria-labelledby={`${groupId}-title`} className="space-y-3">
      <h3 id={`${groupId}-title`} className="font-bold">
        Restore from a backup
      </h3>
      <label
        className={cn(
          buttonClasses({ variant: 'secondary' }),
          'cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
        )}
      >
        <FileUp aria-hidden="true" />
        Choose a backup file
        <input type="file" accept="application/json,.json" className="sr-only" onChange={choose} />
      </label>
      {file && summary && (
        <div className="space-y-4 rounded-xl border border-border p-4">
          <div className="text-sm">
            <p className="font-semibold break-all">{file.name}</p>
            <p className="mt-1 text-text-muted">
              {[
                countLabel(summary.playlists, 'playlist'),
                countLabel(summary.likes, 'liked song'),
                countLabel(summary.follows, 'follow'),
                countLabel(summary.plays, 'play'),
              ].join(' · ')}
            </p>
            {file.parsed.skipped > 0 && (
              <p className="mt-1 text-text-muted">
                {countLabel(file.parsed.skipped, 'damaged item')} will be left out.
              </p>
            )}
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">How to restore it</legend>
            {MODES.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent"
              >
                <input
                  type="radio"
                  name={`${groupId}-mode`}
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                />
                <span className="text-sm">
                  <span className="block font-semibold">{option.label}</span>
                  <span className="block text-text-muted">
                    {syncOn && option.syncHelp !== undefined
                      ? `${option.help} ${option.syncHelp}`
                      : option.help}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={busy}
            onClick={restore}
            className={buttonClasses({ variant: mode === 'replace' ? 'danger' : 'primary' })}
          >
            {mode === 'replace' ? 'Replace my library' : 'Merge into my library'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

function Panel({ onDone }: { onDone: () => void }) {
  const repo = useLibrary()
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const theme = useSettingsStore((state) => state.theme)
  const [lastBackup, setLastBackup] = useState(readLastBackup)
  const [error, setError] = useState('')

  const download = async () => {
    setError('')
    try {
      const now = new Date()
      const backup = await exportLibrary(repo, { appSettings: { catalogMode, theme }, now })
      saveFile(backupBlob(backup), backupFileName(now))
      writeLastBackup(now.getTime())
      setLastBackup(now.getTime())
      showStatus('Backup saved')
    } catch (failure) {
      setError(failureText(failure))
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="font-bold">Save a backup</h3>
        <p className="text-sm text-text-muted">
          One JSON file with your playlists and their order, likes, follows, history and settings.
          {lastBackup === undefined
            ? ' This browser has no backup yet.'
            : ` Last backup from this browser: ${addedLabel(lastBackup)}.`}
        </p>
        <button type="button" className={buttonClasses()} onClick={download}>
          <FileDown aria-hidden="true" />
          Download backup
        </button>
        {error && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        )}
      </section>
      <hr className="border-border" />
      <Restore onDone={onDone} />
    </div>
  )
}

/**
 * Backup and restore. FXM keeps the library only in this browser, so a backup file is how it
 * survives clearing site data or moves to another device.
 */
export function BackupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Back up your library"
      description="Your library lives only in this browser. Save a backup to keep it safe, or to move it to another device."
    >
      <Panel onDone={onClose} />
    </Dialog>
  )
}
