import {
  ChevronDown,
  Ellipsis,
  FileAudio,
  Folder,
  Lock,
  type LucideIcon,
  RefreshCw,
  Smartphone,
  Square,
  Trash,
  TriangleAlert,
} from 'lucide-react'
import { type Ref, useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { showStatus } from '../library/status'
import { Dialog, DialogActions } from '../library/ui/dialog'
import { Menu, type MenuItem } from '../library/ui/menu'
import { AddMusicMenu, addFolder, type Pickers } from './add-music'
import { useLocalFiles } from './hooks'
import { CHECKING, type LocalFiles, type RootStatus } from './local-files'
import { localFailureText } from './messages'
import { isScanning, needsAttention, sourcesSummary, statusText } from './root-status'
import type { LocalRootRecord } from './types'

/** The button that fixes what a root needs: allow access, choose or find it again, retry. */
export interface RootAction {
  /** Its text in the root's row, e.g. "Allow access". */
  label: string
  /** Its text away from the row, naming the root: "Choose “Tunes” again". */
  standalone: string
  /** Does it. Call it straight from a click: most open a picker or a prompt. */
  run: () => void
}

/** What fixes a root in `status`, if the user can do something about it. */
export function rootAction(
  root: LocalRootRecord,
  status: RootStatus,
  files: LocalFiles,
  pickers: Pickers,
): RootAction | undefined {
  const name = `“${root.name}”`
  if (root.kind === 'device') return deviceAction(root, status, files)
  switch (status.state) {
    case 'needs-access':
      return {
        label: 'Allow access',
        standalone: `Allow access to ${name}`,
        // No await before this: the browser shows its prompt only during the click.
        run: () => {
          files
            .requestAccess(root.id)
            .catch((error: unknown) => showStatus(localFailureText(error)))
        },
      }
    case 'denied':
      // Once refused, the browser doesn't ask again: picking the folder grants access anew.
      return {
        label: 'Choose folder again',
        standalone: `Choose ${name} again`,
        run: () => addFolder(files, { replace: root.id }),
      }
    case 'missing':
      return {
        label: 'Find folder',
        standalone: `Find ${name}`,
        run: () => addFolder(files, { replace: root.id }),
      }
    case 'unavailable':
      return root.kind === 'picked-folder'
        ? { label: 'Choose again', standalone: `Choose ${name} again`, run: pickers.chooseFolder }
        : { label: 'Choose again', standalone: 'Choose your files again', run: pickers.chooseFiles }
    case 'failed':
      return {
        label: 'Try again',
        standalone: `Scan ${name} again`,
        run: () => {
          files.rescan(root.id).catch((error: unknown) => showStatus(localFailureText(error)))
        },
      }
    default:
      return undefined
  }
}

/** What fixes the device's music in `status`: ask again, or Android's settings once refused. */
function deviceAction(
  root: LocalRootRecord,
  status: RootStatus,
  files: LocalFiles,
): RootAction | undefined {
  switch (status.state) {
    case 'needs-access':
      return {
        label: 'Allow access',
        standalone: 'Allow access to your music',
        run: () => {
          files
            .requestAccess(root.id)
            .catch((error: unknown) => showStatus(localFailureText(error)))
        },
      }
    case 'denied':
      // Android asks no more: only its settings can allow it now.
      return {
        label: 'Open settings',
        standalone: 'Allow your music in Android’s settings',
        run: () => {
          files.openDeviceSettings().catch((error: unknown) => showStatus(localFailureText(error)))
        },
      }
    case 'failed':
      return {
        label: 'Try again',
        standalone: 'Scan your music again',
        run: () => {
          files.rescan(root.id).catch((error: unknown) => showStatus(localFailureText(error)))
        },
      }
    default:
      return undefined
  }
}

/** The icon a root shows when it needs nothing: a folder, chosen files, or the phone. */
function kindIcon(root: LocalRootRecord): LucideIcon {
  if (root.kind === 'device') return Smartphone
  return root.kind === 'picked-files' ? FileAudio : Folder
}

/** The icon of a root: what it is, or a lock or a warning when it needs the user. */
function rootIcon(root: LocalRootRecord, status: RootStatus): { icon: LucideIcon; tone: string } {
  switch (status.state) {
    case 'needs-access':
    case 'denied':
    case 'unavailable':
      return { icon: Lock, tone: 'text-accent' }
    case 'missing':
    case 'failed':
      return { icon: TriangleAlert, tone: 'text-danger' }
    default:
      return { icon: kindIcon(root), tone: 'text-text-muted' }
  }
}

/**
 * How far a scan got: a bar that moves until the walk has found every file (the total isn't
 * known before), then one that fills up.
 */
function ScanBar({
  status,
  name,
}: {
  status: Extract<RootStatus, { state: 'scanning' }>
  name: string
}) {
  const label = `Scanning ${name}`
  if (!status.walked) {
    return (
      <div
        role="progressbar"
        aria-label={label}
        className="mt-2 h-1 w-full max-w-sm overflow-hidden rounded-full bg-border forced-colors:border forced-colors:border-[CanvasText]"
      >
        <div className="h-full w-2/5 animate-progress rounded-full bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60 forced-colors:bg-[Highlight] forced-colors:forced-color-adjust-none" />
      </div>
    )
  }
  return (
    <progress
      aria-label={label}
      max={Math.max(1, status.found)}
      value={status.read}
      className="mt-2 block h-1 w-full max-w-sm appearance-none overflow-hidden rounded-full bg-border [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-border [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent"
    />
  )
}

function FolderRow({
  root,
  status,
  songs,
  action,
  onRemove,
  className,
}: {
  root: LocalRootRecord
  status: RootStatus
  songs: number
  action: RootAction | undefined
  onRemove: (root: LocalRootRecord) => void
  className?: string | undefined
}) {
  const files = useLocalFiles()
  const { name } = root
  const { icon: Icon, tone } = rootIcon(root, status)
  const scanning = isScanning(status)
  const attention = needsAttention(status)
  const canScan = status.state === 'ready' || status.state === 'failed'
  const hasButtons = action !== undefined || scanning
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
  // On phones the buttons go on a line of their own under the text, so the name and what the
  // folder needs keep the width; the menu ends that line.
  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 py-3', className)}>
      <span
        aria-hidden="true"
        className={cn('grid size-10 shrink-0 place-items-center rounded-md bg-elevated', tone)}
      >
        <Icon className="size-5" />
      </span>
      <div className={cn('min-w-0 flex-1', hasButtons && 'max-sm:basis-[calc(100%-3.25rem)]')}>
        <p className="truncate font-semibold">{name}</p>
        <p className={attention ? 'text-sm text-text' : 'text-sm text-text-muted'}>
          {statusText(root, status, songs)}
        </p>
        {status.state === 'scanning' && <ScanBar status={status} name={name} />}
      </div>
      {hasButtons && (
        <div className="flex flex-wrap items-center gap-2 max-sm:ms-13">
          {action !== undefined && (
            <button
              type="button"
              aria-label={`${action.label}: ${name}`}
              className={buttonClasses({ variant: 'secondary' })}
              onClick={action.run}
            >
              {action.label}
            </button>
          )}
          {scanning && (
            <button
              type="button"
              aria-label={`Stop scanning ${name}`}
              className={buttonClasses({ variant: 'ghost' })}
              onClick={() => files.cancelScan(root.id)}
            >
              <Square aria-hidden="true" />
              Stop
            </button>
          )}
        </div>
      )}
      <Menu
        label={`More options for ${name}`}
        iconOnly
        items={menu}
        className={cn(iconButtonClasses({ size: 'sm' }), hasButtons && 'max-sm:ms-auto')}
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

/**
 * The folders and chosen files local files come from, with what each needs, and "Add music".
 *
 * On phones the list folds into one line ("Music · 8 songs · updated just now") that opens it,
 * so the songs start on the first screen; folders that need the user always show in full.
 */
export function FolderList({
  roots,
  statuses,
  songCounts,
  pickers,
  headingRef,
}: {
  roots: readonly LocalRootRecord[]
  statuses: Readonly<Record<string, RootStatus>>
  /** Songs per root ID. */
  songCounts: ReadonlyMap<string, number>
  pickers: Pickers
  /** The heading, which gets focus when the first folder arrives. */
  headingRef?: Ref<HTMLHeadingElement>
}) {
  const files = useLocalFiles()
  const [expanded, setExpanded] = useState(false)
  const [removing, setRemoving] = useState<LocalRootRecord | null>(null)
  const headingId = useId()
  const listId = useId()
  const statusOf = (root: LocalRootRecord) => statuses[root.id] ?? CHECKING
  const Icon = roots.length === 1 && roots[0] !== undefined ? kindIcon(roots[0]) : Folder
  // When every folder needs the user, every row shows anyway: no line to fold them into.
  const foldable = roots.some((root) => !needsAttention(statusOf(root)))
  return (
    <section aria-labelledby={headingId} className="space-y-1 sm:space-y-2">
      <div className="flex min-h-touch items-center justify-between gap-2 sm:gap-3">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className={cn(
            'font-bold tracking-tight max-sm:text-base sm:text-lg',
            foldable && 'max-sm:sr-only',
          )}
        >
          Where your music comes from
        </h3>
        {foldable && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((open) => !open)}
            className="-ml-1 flex min-h-touch min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left text-sm text-text-muted hover:text-text sm:hidden"
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="line-clamp-2 min-w-0 flex-1">
              <span className="sr-only">Folders: </span>
              {sourcesSummary(roots, statuses, songCounts)}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-180')}
            />
          </button>
        )}
        <AddMusicMenu
          pickers={pickers}
          deviceListed={roots.some((root) => root.kind === 'device')}
        />
      </div>
      <ul id={listId} className="divide-y divide-border">
        {roots.map((root) => {
          const status = statusOf(root)
          return (
            <FolderRow
              key={root.id}
              root={root}
              status={status}
              songs={songCounts.get(root.id) ?? 0}
              action={rootAction(root, status, files, pickers)}
              onRemove={setRemoving}
              className={!expanded && !needsAttention(status) ? 'max-sm:hidden' : undefined}
            />
          )
        })}
      </ul>
      <RemoveRootDialog root={removing} onClose={() => setRemoving(null)} />
    </section>
  )
}
