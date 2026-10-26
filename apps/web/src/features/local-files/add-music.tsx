import { FilePlus2, FolderPlus, Plus, Smartphone } from 'lucide-react'
import { type ReactNode, useCallback, useRef } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { showStatus } from '../library/status'
import { Menu, type MenuItem } from '../library/ui/menu'
import { AUDIO_EXTENSIONS } from './format'
import { useLocalFiles } from './hooks'
import type { AddDeviceResult, AddFolderResult, AddPickedResult, LocalFiles } from './local-files'
import { localFailureText } from './messages'
import { needsAttention, scanSummary, statusText } from './root-status'
import type { LocalRootRecord } from './types'

/** What the file inputs accept: audio types, plus the extensions some systems don't type. */
const ACCEPT = [
  'audio/*',
  ...Object.keys(AUDIO_EXTENSIONS).map((extension) => `.${extension}`),
].join(',')

/**
 * Says what the scan of a root just added found, once it is over ("Added “Music”: 8 songs"),
 * or why it failed. Nothing when the user stopped it.
 */
async function announceScan(
  files: LocalFiles,
  root: LocalRootRecord,
  verb: 'Added' | 'Found',
): Promise<void> {
  const outcome = await files.whenScanned(root.id)
  if (outcome === undefined) {
    const status = files.statusOf(root.id)
    if (needsAttention(status)) showStatus(`“${root.name}”: ${statusText(root, status, 0)}`)
    return
  }
  if (outcome.status === 'cancelled') return
  showStatus(scanSummary(root, outcome, await files.repo.countFiles(root.id), verb))
}

/** Says what adding a folder did, now or once its scan is over. */
export function announceFolder(files: LocalFiles, result: AddFolderResult): void {
  switch (result.status) {
    case 'exists':
      showStatus(`“${result.root.name}” is already in Local files. Looking for changes`)
      break
    case 'inside':
      showStatus(`That folder is already part of “${result.root.name}”`)
      break
    case 'added':
    case 'replaced':
      announceScan(files, result.root, result.status === 'added' ? 'Added' : 'Found').catch(
        () => {},
      )
      break
    default:
  }
}

/** Says what adding chosen files did, once their scan is over. */
export function announcePicked(files: LocalFiles, result: AddPickedResult): void {
  if (result.status === 'empty') {
    showStatus('None of those files is a format FXM can play')
    return
  }
  announceScan(files, result.root, result.status === 'added' ? 'Added' : 'Found').catch(() => {})
}

/** Says what opening the device's music did, now or once its scan is over. */
export function announceDevice(files: LocalFiles, result: AddDeviceResult): void {
  if (result.status === 'denied') {
    showStatus(
      result.forGood
        ? 'FXM may not see your music. Allow it in Android’s settings'
        : 'FXM needs your permission to show the music on this device',
    )
    return
  }
  announceScan(files, result.root, result.status === 'added' ? 'Added' : 'Found').catch(() => {})
}

/**
 * Lists the device's own music, in the Android app: asks the user's permission first, where
 * Android still asks. Call it from the click that opens it: FXM never asks on its own.
 */
export function addDeviceMusic(files: LocalFiles): void {
  files.addDeviceMusic().then(
    (result) => announceDevice(files, result),
    (error: unknown) => showStatus(localFailureText(error)),
  )
}

/**
 * Opens the folder picker and adds the folder it gives (or, with `replace`, makes it that
 * root's folder). Call it straight from a click: the picker opens only during one.
 */
export function addFolder(files: LocalFiles, options: { replace?: string } = {}): void {
  files.addFolder(options).then(
    (result) => announceFolder(files, result),
    (error: unknown) => showStatus(localFailureText(error)),
  )
}

/** The file inputs FXM uses where it can't keep a folder; see {@link usePickers}. */
export interface Pickers {
  /** The hidden inputs: render them once. */
  inputs: ReactNode
  /** Opens the folder input. Call it from a click. */
  chooseFolder: () => void
  /** Opens the files input. Call it from a click. */
  chooseFiles: () => void
}

/**
 * The file inputs FXM uses where it can't keep a folder: one for a whole folder
 * (`webkitdirectory`), one for single files. Where a browser can't pick folders (iOS, for one),
 * the folder input takes several music files instead.
 */
export function usePickers(): Pickers {
  const files = useLocalFiles()
  const folderInput = useRef<HTMLInputElement | null>(null)
  const filesInput = useRef<HTMLInputElement | null>(null)

  const onChange = useCallback(
    (input: HTMLInputElement) => {
      const chosen = [...(input.files ?? [])]
      // Cleared, so choosing the same files again still reports a change.
      input.value = ''
      if (chosen.length === 0) return
      files.addPicked(chosen).then(
        (result) => announcePicked(files, result),
        (error: unknown) => showStatus(localFailureText(error)),
      )
    },
    [files],
  )

  const inputs = (
    <>
      <input
        ref={(input) => {
          folderInput.current = input
          // React has no prop for it; the DOM property is standard enough everywhere.
          if (input) input.webkitdirectory = true
        }}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        data-testid="local-folder-input"
        onChange={(event) => onChange(event.currentTarget)}
      />
      <input
        ref={filesInput}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        data-testid="local-files-input"
        onChange={(event) => onChange(event.currentTarget)}
      />
    </>
  )
  return {
    inputs,
    chooseFolder: () => folderInput.current?.click(),
    chooseFiles: () => filesInput.current?.click(),
  }
}

/** The ways this browser adds music, for the buttons and the menu. */
function addOptions(files: LocalFiles, pickers: Pickers, deviceListed = false) {
  const keep = files.canKeepFolders()
  const folders = keep || files.canChooseFolders()
  return {
    // The Android app: the device's own music, once.
    device:
      files.canListDeviceMusic() && !deviceListed
        ? { label: 'Music on this device', onClick: () => addDeviceMusic(files) }
        : undefined,
    folder: folders
      ? {
          label: keep ? 'Add a folder' : 'Choose a folder',
          onClick: keep ? () => addFolder(files) : pickers.chooseFolder,
        }
      : undefined,
    files: { label: folders ? 'Choose files' : 'Choose music files', onClick: pickers.chooseFiles },
  }
}

/**
 * The buttons that add the first music: "Add a folder" where the browser can keep access to it
 * (Chromium), else "Choose a folder"; and "Choose files". Where a browser can't pick folders at
 * all, only "Choose music files". In the Android app, "Music on this device" comes first.
 */
export function AddMusicActions({ pickers }: { pickers: Pickers }) {
  const files = useLocalFiles()
  const options = addOptions(files, pickers)
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      {options.device && (
        <button type="button" className={buttonClasses()} onClick={options.device.onClick}>
          <Smartphone aria-hidden="true" />
          {options.device.label}
        </button>
      )}
      {options.folder && (
        <button
          type="button"
          className={buttonClasses({ variant: options.device ? 'secondary' : 'primary' })}
          onClick={options.folder.onClick}
        >
          <FolderPlus aria-hidden="true" />
          {options.folder.label}
        </button>
      )}
      <button
        type="button"
        className={buttonClasses({
          variant: options.folder || options.device ? 'secondary' : 'primary',
        })}
        onClick={options.files.onClick}
      >
        <FilePlus2 aria-hidden="true" />
        {options.files.label}
      </button>
    </div>
  )
}

/**
 * "Add music": the same choices as {@link AddMusicActions}, as one menu button (icon only on
 * phones). `deviceListed`: the device's music is listed already, so it isn't offered again.
 */
export function AddMusicMenu({
  pickers,
  deviceListed = false,
}: {
  pickers: Pickers
  deviceListed?: boolean
}) {
  const files = useLocalFiles()
  const options = addOptions(files, pickers, deviceListed)
  const items: MenuItem[] = [
    ...(options.device
      ? [
          {
            id: 'device',
            label: options.device.label,
            icon: Smartphone,
            onSelect: options.device.onClick,
          },
        ]
      : []),
    ...(options.folder
      ? [
          {
            id: 'folder',
            label: options.folder.label,
            icon: FolderPlus,
            onSelect: options.folder.onClick,
          },
        ]
      : []),
    { id: 'files', label: options.files.label, icon: FilePlus2, onSelect: options.files.onClick },
  ]
  return (
    <Menu
      label="Add music"
      items={items}
      align="end"
      className={buttonClasses({ variant: 'secondary', className: 'max-sm:w-touch max-sm:px-0' })}
    >
      <Plus aria-hidden="true" />
      <span className="max-sm:sr-only">Add music</span>
    </Menu>
  )
}
