import { FilePlus2, FolderPlus } from 'lucide-react'
import { type ReactNode, useCallback, useRef } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { showStatus } from '../library/status'
import { AUDIO_EXTENSIONS } from './format'
import { useLocalFiles } from './hooks'
import type { AddFolderResult, AddPickedResult } from './local-files'
import { localFailureText } from './messages'

/** What the files input accepts: audio types, plus the extensions some systems don't type. */
const ACCEPT = [
  'audio/*',
  ...Object.keys(AUDIO_EXTENSIONS).map((extension) => `.${extension}`),
].join(',')

function announcePicked(result: AddPickedResult): void {
  if (result.status === 'empty') showStatus('None of those files is a format FXM can play')
}

function announceFolder(result: AddFolderResult): void {
  if (result.status === 'exists') {
    showStatus(`“${result.root.name}” is already in Local files. Looking for changes`)
  } else if (result.status === 'inside') {
    showStatus(`That folder is already part of “${result.root.name}”`)
  }
}

/**
 * The file inputs FXM uses where it can't keep a folder: one for a whole folder
 * (`webkitdirectory`), one for single files. Render `inputs` once; `chooseFolder` and
 * `chooseFiles` open them, from a click.
 */
export function usePickers(): {
  inputs: ReactNode
  chooseFolder: () => void
  chooseFiles: () => void
} {
  const files = useLocalFiles()
  const folderInput = useRef<HTMLInputElement | null>(null)
  const filesInput = useRef<HTMLInputElement | null>(null)

  const onChange = useCallback(
    (input: HTMLInputElement) => {
      const chosen = [...(input.files ?? [])]
      // Cleared, so choosing the same files again still reports a change.
      input.value = ''
      if (chosen.length === 0) return
      files
        .addPicked(chosen)
        .then(announcePicked, (error: unknown) => showStatus(localFailureText(error)))
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

/**
 * The buttons that add music: "Add a folder" where the browser can keep access to it (Chromium),
 * else "Choose a folder"; and "Choose files" everywhere.
 */
export function AddMusicActions({
  primary = true,
  align = 'center',
}: {
  /** Whether "Add a folder" is the page's main action (the empty state) or a quiet one. */
  primary?: boolean
  /** `end`: at the start on phones, at the end of the row from 640 px (beside a heading). */
  align?: 'center' | 'end'
}) {
  const files = useLocalFiles()
  const pickers = usePickers()
  const keep = files.canKeepFolders()
  const addFolder = () => {
    // No await before this: the picker opens only during the click.
    files.addFolder().then(announceFolder, (error: unknown) => showStatus(localFailureText(error)))
  }
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3',
        align === 'center' ? 'justify-center' : 'justify-start sm:justify-end',
      )}
    >
      <button
        type="button"
        className={buttonClasses({ variant: primary ? 'primary' : 'secondary' })}
        onClick={keep ? addFolder : pickers.chooseFolder}
      >
        <FolderPlus aria-hidden="true" />
        {keep ? 'Add a folder' : 'Choose a folder'}
      </button>
      <button
        type="button"
        className={buttonClasses({ variant: primary ? 'secondary' : 'ghost' })}
        onClick={pickers.chooseFiles}
      >
        <FilePlus2 aria-hidden="true" />
        Choose files
      </button>
      {pickers.inputs}
    </div>
  )
}
