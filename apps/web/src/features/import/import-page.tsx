import { isFxmError } from '@fxm/core'
import {
  ImportInputError,
  type ImportLink,
  loadLinkImport,
  type ParsedImport,
  parseImportLink,
} from '@fxm/sources/import'
import { FileUp, Link2, X } from 'lucide-react'
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { cn } from '../../lib/cn'
import { StatusToast } from '../library/status'
import { TextField } from '../library/ui/field'
import { type ImportSource, importErrorText, readExportFiles, readPlaylistFile } from './files'
import { focusWhenReady } from './focus'
import { useMatchingAvailability } from './hooks'
import { ImportList } from './import-list'
import { ImportPreview } from './import-preview'
import { ConnectLink } from './matching-notice'
import { type ImportServicesAccess, useImportServices } from './services'

const SOURCES: readonly TabItem<ImportSource>[] = [
  { value: 'export', label: 'Spotify data' },
  { value: 'file', label: 'Playlist file' },
  { value: 'link', label: 'Link' },
]

/** Spotify's account page where its data download is asked for. */
const SPOTIFY_PRIVACY_URL = 'https://www.spotify.com/account/privacy/'

/** What the user picked, read and ready to preview. */
export interface PickedImport {
  parsed: ParsedImport
  link?: ImportLink
}

/** What the source picker remembers while a preview shows, so Cancel brings it back as it was. */
interface PickerState {
  source: ImportSource
  link: string
}

/** The `id` of a tab of the source picker, as the tabs component names them. */
function sourceTabId(tabsId: string, source: ImportSource): string {
  return `${tabsId}-tab-${source}`
}

/** A button that opens the file picker. */
function FileButton({
  label,
  accept,
  multiple = false,
  disabled = false,
  onFiles,
}: {
  label: string
  accept: string
  multiple?: boolean
  disabled?: boolean
  onFiles: (files: File[]) => void
}) {
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])]
    event.currentTarget.value = ''
    if (files.length > 0) onFiles(files)
  }
  return (
    <label
      className={cn(
        buttonClasses(),
        'cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <FileUp aria-hidden="true" />
      {label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={choose}
      />
    </label>
  )
}

/**
 * Where files can be dropped as well as chosen. The button stays the way in for keyboards and
 * touch screens; the drop area only helps a mouse.
 */
function DropZone({
  disabled,
  onFiles,
  children,
}: {
  disabled: boolean
  onFiles: (files: File[]) => void
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent) => !disabled && event.dataTransfer.types.includes('Files')
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a mouse shortcut; the button inside does the same for everyone
    <div
      onDragOver={(event) => {
        if (!accepts(event)) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        if (!accepts(event)) return
        event.preventDefault()
        const files = [...event.dataTransfer.files]
        if (files.length > 0) onFiles(files)
      }}
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border-2 border-dashed border-transparent p-2 transition-colors pointer-fine:border-border',
        over && 'border-accent bg-accent/5 pointer-fine:border-accent',
      )}
    >
      {children}
      <span className="hidden text-sm text-text-muted pointer-fine:inline">or drop them here</span>
    </div>
  )
}

/** Where the user picks what to import: a data download, a playlist file or a link. */
function SourcePicker({
  services,
  picker,
  onPickerChange,
  onPicked,
  tabsId,
}: {
  services: ImportServicesAccess
  picker: PickerState
  onPickerChange: (next: PickerState) => void
  onPicked: (picked: PickedImport) => void
  tabsId: string
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [connectHint, setConnectHint] = useState(false)
  const [linkError, setLinkError] = useState('')
  const loading = useRef<AbortController | null>(null)
  const { source, link } = picker

  const read = async (
    work: (signal: AbortSignal) => Promise<PickedImport>,
    linkRef?: ImportLink,
  ) => {
    setError('')
    setLinkError('')
    setConnectHint(false)
    const controller = new AbortController()
    loading.current = controller
    try {
      const picked = await work(controller.signal)
      if (!controller.signal.aborted) onPicked(picked)
    } catch (failure) {
      if (controller.signal.aborted) return
      const text = importErrorText(failure, linkRef)
      if (linkRef === undefined) setError(text)
      else setLinkError(text)
      setConnectHint(linkRef !== undefined && isFxmError(failure, 'Unsupported'))
    } finally {
      if (loading.current === controller) {
        loading.current = null
        setBusy('')
      }
    }
  }

  const readExport = (files: File[]) => {
    setBusy('Reading your Spotify data…')
    void read(async () => ({ parsed: await readExportFiles(files) }))
  }

  const readFile = (files: File[]) => {
    const [file] = files
    if (file === undefined) return
    setBusy(`Reading ${file.name}…`)
    void read(async () => ({ parsed: await readPlaylistFile(file) }))
  }

  const loadLink = (event: FormEvent) => {
    event.preventDefault()
    const parsedLink = parseImportLink(link)
    if (parsedLink === null) {
      setConnectHint(false)
      setLinkError(importErrorText(new ImportInputError('bad-link', 'Not an import link')))
      return
    }
    setBusy('Loading…')
    void read(async (signal) => {
      const ready = await services.get()
      // The user waits for this load: it needs no place in the queue of bulk searches.
      const parsed = await loadLinkImport(
        parsedLink,
        { spotify: ready.spotify, youtube: ready.youtube },
        ready.context('all', signal, 'interactive'),
        {
          onProgress: (rows) => {
            if (!signal.aborted) setBusy(`Loading… ${rows.toLocaleString('en')} songs so far`)
          },
        },
      )
      return { parsed, link: parsedLink }
    }, parsedLink)
  }

  const stopLoading = () => {
    loading.current?.abort()
    loading.current = null
    setBusy('')
  }

  return (
    <section aria-labelledby={`${tabsId}-title`} className="space-y-4">
      <h2 id={`${tabsId}-title`} className="text-xl font-bold tracking-tight">
        What to import
      </h2>
      <Tabs
        label="What to import"
        id={tabsId}
        items={SOURCES}
        value={source}
        onChange={(next) => {
          onPickerChange({ ...picker, source: next })
          setError('')
        }}
      />
      <TabPanel
        id={tabsId}
        value={source}
        className="space-y-4 rounded-2xl border border-border p-4"
      >
        {source === 'export' && (
          <>
            <DropZone disabled={busy !== ''} onFiles={readExport}>
              <FileButton
                label="Choose ZIP or JSON files"
                accept=".zip,.json,application/zip,application/json"
                multiple
                disabled={busy !== ''}
                onFiles={readExport}
              />
            </DropZone>
            <details className="group max-w-prose text-sm">
              <summary className="inline-flex min-h-touch cursor-pointer items-center font-semibold">
                How to get your Spotify data
              </summary>
              <div className="space-y-2 pb-1 text-text-muted">
                <p>
                  Spotify sends you a copy of your data when you ask for it. Open your account’s{' '}
                  <a
                    href={SPOTIFY_PRIVACY_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-accent underline underline-offset-2 hover:no-underline"
                  >
                    privacy settings on spotify.com
                  </a>{' '}
                  and ask to download your data.
                </p>
                <p>
                  The account data, with your playlists, liked songs and a year of listening,
                  arrives as a ZIP file within a few days. The extended streaming history, with
                  every play since you joined, takes longer. Choose the ZIP file, or the JSON files
                  inside it.
                </p>
              </div>
            </details>
          </>
        )}
        {source === 'file' && (
          <>
            <DropZone disabled={busy !== ''} onFiles={readFile}>
              <FileButton
                label="Choose a CSV or M3U file"
                accept=".csv,.tsv,.txt,.m3u,.m3u8,text/csv,audio/x-mpegurl,audio/mpegurl"
                disabled={busy !== ''}
                onFiles={readFile}
              />
            </DropZone>
            <p className="max-w-prose text-sm text-text-muted">
              A CSV file, such as one Exportify saves (with ISRCs, the most precise way to find each
              song), or an M3U or M3U8 playlist from a music player.
            </p>
          </>
        )}
        {source === 'link' && (
          <form onSubmit={loadLink} className="space-y-3">
            <TextField
              label="Playlist, album or song link"
              hint="A Spotify playlist, album or song, or a YouTube or YouTube Music playlist."
              placeholder="https://open.spotify.com/playlist/…"
              inputMode="url"
              autoComplete="off"
              value={link}
              error={linkError || undefined}
              onChange={(event) => {
                onPickerChange({ ...picker, link: event.currentTarget.value })
                setLinkError('')
              }}
              className="max-w-xl"
            />
            {connectHint && (
              <p className="text-sm">
                <ConnectLink>How to add FXM Connect</ConnectLink>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className={buttonClasses()}
                disabled={busy !== '' || link.trim() === ''}
              >
                <Link2 aria-hidden="true" />
                Load
              </button>
              {busy !== '' && (
                <button
                  type="button"
                  className={buttonClasses({ variant: 'ghost' })}
                  onClick={stopLoading}
                >
                  <X aria-hidden="true" />
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
        {busy && (
          <p role="status" className="text-sm text-text-muted">
            {busy}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        )}
      </TabPanel>
    </section>
  )
}

/**
 * Imports: playlists, liked songs and listening history from Spotify's data download, CSV and
 * M3U files, and Spotify and YouTube links. Below, every import with its progress.
 */
export function ImportPage() {
  const services = useImportServices()
  const [picked, setPicked] = useState<PickedImport | null>(null)
  const [picker, setPicker] = useState<PickerState>({ source: 'export', link: '' })
  const [focusId, setFocusId] = useState<string | null>(null)
  const tabsId = useId()
  const matching = useMatchingAvailability(services)
  const clearFocus = useCallback(() => setFocusId(null), [])

  const closePreview = (started?: string) => {
    setPicked(null)
    // After a start, the first new import's card takes the focus once it shows (ImportList);
    // after a cancel, the tab the user picked from.
    if (started !== undefined) setFocusId(started)
    else focusWhenReady(() => document.getElementById(sourceTabId(tabsId, picker.source)))
  }

  return (
    <div className="space-y-8 pt-2 md:pt-4">
      <div className="space-y-2">
        <PageTitle hideOnPhone>Import music</PageTitle>
        <p className="max-w-prose text-text-muted">
          Bring your playlists, liked songs and listening history from Spotify, YouTube or a
          playlist file. FXM finds every song for you, and keeps everything on this device.
        </p>
      </div>
      {picked === null ? (
        <SourcePicker
          services={services}
          picker={picker}
          onPickerChange={setPicker}
          onPicked={setPicked}
          tabsId={tabsId}
        />
      ) : (
        <ImportPreview
          picked={picked}
          services={services}
          matching={matching}
          onClose={closePreview}
        />
      )}
      <ImportList
        services={services}
        matching={matching}
        focusId={focusId}
        onFocused={clearFocus}
      />
      <StatusToast />
    </div>
  )
}
