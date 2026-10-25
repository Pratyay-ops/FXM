import {
  ImportInputError,
  type ImportLink,
  loadLinkImport,
  type ParsedImport,
  parseImportLink,
} from '@fxm/sources/import'
import { FileUp, Link2 } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { cn } from '../../lib/cn'
import { StatusToast } from '../library/status'
import { TextField } from '../library/ui/field'
import { type ImportSource, importErrorText, readExportFiles, readPlaylistFile } from './files'
import { ImportList } from './import-list'
import { ImportPreview } from './import-preview'
import { type ImportServicesAccess, useImportServices } from './services'

const SOURCES: readonly TabItem<ImportSource>[] = [
  { value: 'export', label: 'Spotify data' },
  { value: 'file', label: 'Playlist file' },
  { value: 'link', label: 'Link' },
]

/** What the user picked, read and ready to preview. */
export interface PickedImport {
  parsed: ParsedImport
  link?: ImportLink
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

/** Where the user picks what to import: a data download, a playlist file or a link. */
function SourcePicker({
  services,
  onPicked,
}: {
  services: ImportServicesAccess
  onPicked: (picked: PickedImport) => void
}) {
  const [source, setSource] = useState<ImportSource>('export')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const tabsId = useId()

  const read = async (work: () => Promise<PickedImport>, linkRef?: ImportLink) => {
    setError('')
    try {
      onPicked(await work())
    } catch (failure) {
      setError(importErrorText(failure, linkRef))
    } finally {
      setBusy('')
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
      setError(importErrorText(new ImportInputError('bad-link', 'Not an import link')))
      return
    }
    setBusy('Loading…')
    void read(async () => {
      const ready = await services.get()
      const parsed = await loadLinkImport(
        parsedLink,
        { spotify: ready.spotify, youtube: ready.youtube },
        ready.context('all'),
        { onProgress: (rows) => setBusy(`Loading… ${rows.toLocaleString('en')} songs so far`) },
      )
      return { parsed, link: parsedLink }
    }, parsedLink)
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
          setSource(next)
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
            <p className="max-w-prose text-sm text-text-muted">
              Spotify sends you a copy of your data when you ask for it: on spotify.com, open your
              account’s privacy settings and choose to download your data. The account data, with
              your playlists, liked songs and a year of listening, arrives as a ZIP file within a
              few days; the extended streaming history, with every play since you joined, takes
              longer. Choose the ZIP file, or the JSON files inside it.
            </p>
            <FileButton
              label="Choose ZIP or JSON files"
              accept=".zip,.json,application/zip,application/json"
              multiple
              disabled={busy !== ''}
              onFiles={readExport}
            />
          </>
        )}
        {source === 'file' && (
          <>
            <p className="max-w-prose text-sm text-text-muted">
              A CSV file, such as one Exportify saves (with ISRCs, the most precise way to find each
              song), or an M3U or M3U8 playlist from a music player.
            </p>
            <FileButton
              label="Choose a CSV or M3U file"
              accept=".csv,.tsv,.txt,.m3u,.m3u8,text/csv,audio/x-mpegurl,audio/mpegurl"
              disabled={busy !== ''}
              onFiles={readFile}
            />
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
              onChange={(event) => setLink(event.currentTarget.value)}
              className="max-w-xl"
            />
            <button
              type="submit"
              className={buttonClasses()}
              disabled={busy !== '' || link.trim() === ''}
            >
              <Link2 aria-hidden="true" />
              Load
            </button>
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
        <SourcePicker services={services} onPicked={setPicked} />
      ) : (
        <ImportPreview picked={picked} services={services} onClose={() => setPicked(null)} />
      )}
      <ImportList services={services} />
      <StatusToast />
    </div>
  )
}
