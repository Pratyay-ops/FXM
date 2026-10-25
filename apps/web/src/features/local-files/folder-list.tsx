import { Ellipsis, FileAudio, Folder, RefreshCw, Square, Trash } from 'lucide-react'
import { useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { countLabel, playedLabel } from '../library/format'
import { showStatus } from '../library/status'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { Menu, type MenuItem } from '../library/ui/menu'
import { AddMusicActions, usePickers } from './add-music'
import { useLocalFiles, useRootStatuses } from './hooks'
import { CHECKING, type RootStatus } from './local-files'
import { localFailureText } from './messages'
import type { LocalRootRecord, SkippedCounts } from './types'

/** "3 files can't play here", or nothing when no file was left out. */
export function skippedText(skipped: SkippedCounts | undefined): string | undefined {
  const count = (skipped?.unsupported ?? 0) + (skipped?.unreadable ?? 0)
  if (count === 0) return undefined
  return `${countLabel(count, 'file')} can’t be played here`
}

/** The line under a root's name: its songs, or what it needs. */
function statusText(root: LocalRootRecord, status: RootStatus, songs: number): string {
  switch (status.state) {
    case 'scanning':
      return status.found === 0
        ? 'Looking for music…'
        : `Reading files: ${status.read.toLocaleString('en')} of ${status.found.toLocaleString('en')}`
    case 'needs-access':
      return 'FXM needs your permission to read this folder again'
    case 'denied':
      return 'You didn’t allow FXM to read this folder'
    case 'unavailable':
      return root.kind === 'picked-folder'
        ? 'Choose this folder again to play its songs'
        : 'Choose these files again to play them'
    case 'missing':
      return 'This folder was moved or deleted'
    case 'failed':
      return status.message
    default: {
      const parts = [countLabel(songs, 'song')]
      if (root.kind !== 'folder') parts.push('until FXM reloads')
      else if (root.scannedAt !== undefined) parts.push(`updated ${playedLabel(root.scannedAt)}`)
      const skipped = skippedText(root.skipped)
      if (skipped !== undefined) parts.push(skipped)
      return parts.join(' · ')
    }
  }
}

function FolderRow({
  root,
  status,
  songs,
  onChooseAgain,
  onRemove,
}: {
  root: LocalRootRecord
  status: RootStatus
  songs: number
  onChooseAgain: (root: LocalRootRecord) => void
  onRemove: (root: LocalRootRecord) => void
}) {
  const files = useLocalFiles()
  const { name } = root
  const Icon = root.kind === 'picked-files' ? FileAudio : Folder
  const scanning = status.state === 'scanning'
  const canScan = status.state === 'ready' || status.state === 'failed'
  const menu: MenuItem[] = [
    {
      id: 'scan',
      label: 'Scan for changes',
      icon: RefreshCw,
      disabled: !canScan,
      onSelect: () => {
        files.rescan(root.id).catch((error: unknown) => showStatus(localFailureText(error)))
      },
    },
    { kind: 'separator', id: 'separator' },
    {
      id: 'remove',
      label: 'Remove from FXM',
      icon: Trash,
      danger: true,
      onSelect: () => onRemove(root),
    },
  ]
  let action: { label: string; onClick: () => void } | undefined
  if (status.state === 'needs-access' || status.state === 'denied') {
    action = {
      label: 'Allow access',
      // No await before this: the browser shows its prompt only during the click.
      onClick: () => {
        files.requestAccess(root.id).catch((error: unknown) => showStatus(localFailureText(error)))
      },
    }
  } else if (status.state === 'unavailable') {
    action = { label: 'Choose again', onClick: () => onChooseAgain(root) }
  } else if (status.state === 'failed') {
    action = {
      label: 'Try again',
      onClick: () => {
        files.rescan(root.id).catch((error: unknown) => showStatus(localFailureText(error)))
      },
    }
  }
  const attention = action !== undefined || status.state === 'missing'
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-md bg-elevated text-text-muted"
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{name}</p>
        <p className={attention ? 'text-sm text-text' : 'text-sm text-text-muted'}>
          {statusText(root, status, songs)}
        </p>
        {scanning && (
          <progress
            aria-label={`Scanning ${name}`}
            className="mt-2 block h-1 w-full max-w-sm overflow-hidden rounded-full accent-accent"
            {...(status.found > 0 ? { max: status.found, value: status.read } : {})}
          />
        )}
      </div>
      {action !== undefined && (
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
      {scanning && (
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost' })}
          onClick={() => files.cancelScan(root.id)}
        >
          <Square aria-hidden="true" />
          Stop
        </button>
      )}
      <Menu
        label={`More options for ${name}`}
        iconOnly
        items={menu}
        className={iconButtonClasses({ size: 'sm' })}
      >
        <Ellipsis aria-hidden="true" />
      </Menu>
    </li>
  )
}

/** Confirms removing a root from local files. */
function RemoveRootDialog({
  root,
  onClose,
}: {
  root: LocalRootRecord | null
  onClose: () => void
}) {
  const files = useLocalFiles()
  const name = root?.name ?? ''
  return (
    <Dialog
      open={root !== null}
      onClose={onClose}
      title={`Remove “${name}”?`}
      description="Its songs leave Local files. The files stay on your device. Liked songs and playlists keep them, but they play again only once you add them again."
    >
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          data-autofocus=""
          className={buttonClasses({ variant: 'danger' })}
          onClick={() => {
            if (root !== null) {
              files.removeRoot(root.id).then(
                () => showStatus(`Removed “${name}” from Local files`),
                (error: unknown) => showStatus(localFailureText(error)),
              )
            }
            onClose()
          }}
        >
          Remove
        </button>
      </DialogActions>
    </Dialog>
  )
}

/** The folders and chosen files local files come from, with what each needs. */
export function FolderList({
  roots,
  songCounts,
}: {
  roots: readonly LocalRootRecord[]
  /** Songs per root ID. */
  songCounts: ReadonlyMap<string, number>
}) {
  const statuses = useRootStatuses()
  const pickers = usePickers()
  const [removing, setRemoving] = useState<LocalRootRecord | null>(null)
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="text-lg font-bold tracking-tight">
          Where your music comes from
        </h3>
        <AddMusicActions primary={false} align="end" />
      </div>
      <ul className="divide-y divide-border">
        {roots.map((root) => (
          <FolderRow
            key={root.id}
            root={root}
            status={statuses[root.id] ?? CHECKING}
            songs={songCounts.get(root.id) ?? 0}
            onChooseAgain={(target) =>
              target.kind === 'picked-folder' ? pickers.chooseFolder() : pickers.chooseFiles()
            }
            onRemove={setRemoving}
          />
        ))}
      </ul>
      {pickers.inputs}
      <RemoveRootDialog root={removing} onClose={() => setRemoving(null)} />
    </section>
  )
}
