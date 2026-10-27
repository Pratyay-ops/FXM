import type { ExportChoice } from '@fxm/convert'
import type { DownloadFormat, Track } from '@fxm/core'
import { type DownloadRecord, downloadId } from '@fxm/downloads'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { buttonClasses } from '../../../components/ui/button'
import { RELEASED } from '../../connect/config'
import { countLabel } from '../../library/format'
import { showStatus } from '../../library/status'
import { Dialog, DialogActions } from '../../library/ui/dialog'
import { getLyricsProvider, lyricsContext } from '../../lyrics/lyrics-source'
import { effectiveDownloadFormat } from '../../settings/quality-options'
import { useQualityStore } from '../../settings/quality-store'
import { useSettingsStore } from '../../settings/settings-store'
import { formatLabel, progressOf, statusLine } from '../format'
import { useCanDownload, useDownload, useDownloadStatuses } from '../hooks'
import { requestStoragePersistence } from '../persistence'
import { ProgressBar } from '../progress'
import { getDownloads } from '../runtime'
import {
  exactChoiceHelp,
  exactChoices,
  type FormatChoice,
  plannedChoiceHelp,
  plannedChoices,
  sourceKinds,
} from './choices'
import { ConverterCredit } from './credit'
import { canPickFolder, nativeDeviceSaver, useSaveDestination } from './device'
import type { DownloadDialogRequest } from './download-dialog-store'
import {
  type Destination,
  type FailedSong,
  type JobProgress,
  plannedSaveRequest,
  runDownloadJob,
  savedMessage,
  saveRequestFor,
} from './job'
import { getDeviceSaver, isSavable, type SavableDownload, SaveError, saveErrorText } from './save'

/** The folder picker's ID: it opens where the user saved songs last. */
export const SAVE_FOLDER_ID = 'fxm-downloads'

/** Where the songs of a collection go without a folder picker, and the prompt they may meet. */
const MULTIPLE_DOWNLOADS =
  'Each song goes to your browser’s downloads as soon as it’s ready. If the browser asks whether FXM may download several files, allow it.'

type FormState =
  | { readonly kind: 'idle'; readonly notice?: string }
  | {
      readonly kind: 'running'
      readonly progress: JobProgress | undefined
      /** The folder the songs go to, when one was picked. */
      readonly folder: string | undefined
      /** Whether each song goes to the browser's downloads. */
      readonly viaDownloads: boolean
    }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'summary'
      readonly saved: number
      readonly failed: readonly FailedSong[]
      readonly folder: string | undefined
    }

function Notice({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="text-sm text-text-muted">
      {children}
    </p>
  )
}

/**
 * The dialog's buttons, kept in view at its bottom while the formats and their notes scroll:
 * on a phone the seven formats fill the screen, and Download is what the dialog is for.
 */
function StickyActions({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-5 mt-6 -mb-5 border-t border-border bg-surface px-5 py-3 sm:-mx-6 sm:-mb-6 sm:px-6">
      <div className="flex flex-wrap justify-end gap-3">{children}</div>
    </div>
  )
}

function CloseOnly({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <Notice>{children}</Notice>
      <DialogActions>
        <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onClose}>
          Close
        </button>
      </DialogActions>
    </>
  )
}

/** Whether the browser says it is online; downloads wait for a connection otherwise. */
function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/** The progress of a running job, in a bar and a line. */
function JobStatus({
  progress,
  single,
  downloading,
  folder,
  viaDownloads,
}: {
  progress: JobProgress | undefined
  single: boolean
  /** Whether the job starts by downloading, for the words before it says how it goes. */
  downloading: boolean
  folder: string | undefined
  viaDownloads: boolean
}) {
  const title = progress?.track.title
  const record: DownloadRecord | undefined = progress?.record
  let value: number | undefined
  let label = downloading ? 'Downloading' : 'Saving'
  let line = 'Starting'
  if (progress !== undefined && title !== undefined) {
    if (progress.phase === 'downloading') {
      value = record === undefined ? undefined : progressOf(record)
      line = record === undefined ? 'Waiting' : statusLine(record, online())
      label = `Downloading ${title}`
    } else {
      value = progress.saved
      line = progress.saved === undefined ? 'Starting' : `${Math.round(progress.saved * 100)}%`
      label = `Saving ${title}`
    }
  }
  if (single) {
    return (
      <div className="mt-4 space-y-2">
        <ProgressBar value={value} label={label} valueText={line} />
        <p className="text-sm text-text-muted">
          {(progress?.phase ?? (downloading ? 'downloading' : 'saving')) === 'saving'
            ? 'Saving'
            : 'Downloading'}{' '}
          · {line}
        </p>
      </div>
    )
  }
  const total = progress?.total ?? 0
  const done = progress?.done ?? 0
  return (
    <div className="mt-4 space-y-2">
      <ProgressBar
        value={total === 0 ? undefined : done / total}
        label="Songs done"
        valueText={`${done} of ${total}`}
      />
      <p className="text-sm text-text-muted">
        {total === 0 ? 'Starting' : `${done} of ${countLabel(total, 'song')} done`}
        {title !== undefined &&
          ` · “${title}”: ${progress?.phase === 'saving' ? 'saving' : 'downloading'}, ${line}`}
      </p>
      {folder !== undefined && <Notice>Saving to “{folder}”.</Notice>}
      {viaDownloads && <Notice>{MULTIPLE_DOWNLOADS}</Notice>}
    </div>
  )
}

/** The list of what a collection couldn't save, after the rest was saved. */
function Summary({
  state,
  total,
  onClose,
}: {
  state: Extract<FormState, { kind: 'summary' }>
  total: number
  onClose: () => void
}) {
  const where = state.folder === undefined ? '' : ` to “${state.folder}”`
  return (
    <>
      <p role="alert" className="text-sm font-semibold">
        {state.saved === 0
          ? 'No song could be saved.'
          : `Saved ${state.saved} of ${countLabel(total, 'song')}${where}.`}{' '}
        {state.failed.length === 1
          ? 'One couldn’t be saved:'
          : `${state.failed.length} couldn’t be saved:`}
      </p>
      <ul className="mt-3 max-h-60 space-y-2 overflow-y-auto text-sm">
        {state.failed.map(({ track, message }) => (
          <li key={downloadId(track)}>
            <span className="font-semibold">{track.title}</span>
            <span className="text-text-muted"> · {message}</span>
          </li>
        ))}
      </ul>
      <Notice>
        Songs that downloaded stay in Downloads and play offline. Use “Save to device…” on one to
        try saving it again.
      </Notice>
      <DialogActions>
        <button
          type="button"
          data-autofocus=""
          className={buttonClasses({ variant: 'primary' })}
          onClick={onClose}
        >
          Close
        </button>
      </DialogActions>
    </>
  )
}

function DownloadForm({
  request,
  onClose,
  conversions,
}: {
  request: DownloadDialogRequest
  onClose: () => void
  conversions: boolean
}) {
  const { tracks } = request
  const saveOnly = request.save === true
  const single = tracks.length === 1 ? tracks[0] : undefined
  const record = useDownload(single)
  const statuses = useDownloadStatuses()
  const canDownload = useCanDownload()
  // Re-renders when an app sets its own saver, which may ask differently.
  const saveTo = useSaveDestination()
  const download = useQualityStore((state) => state.prefs.download)
  const mode = useSettingsStore((state) => state.catalogMode)
  const [format, setFormat] = useState<DownloadFormat>(() =>
    effectiveDownloadFormat(download.format, conversions),
  )
  const [state, setState] = useState<FormState>({ kind: 'idle' })
  const running = useRef<AbortController | undefined>(undefined)
  // Whether the dialog is still open: a job that ends after it closed changes nothing on it.
  const open = useRef(true)
  const primary = useRef<HTMLButtonElement>(null)
  const groupId = useId()
  const helpId = useId()

  // Closing the dialog stops a job still running.
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
      running.current?.abort()
    }
  }, [])

  // After a download that the user saves with a second click, the button takes the focus.
  const notice = state.kind === 'idle' ? state.notice : undefined
  useEffect(() => {
    if (notice !== undefined) primary.current?.focus()
  }, [notice])

  if (single !== undefined && record === undefined) return null
  if (single === undefined && statuses === undefined) return null
  const savable: SavableDownload | undefined = isSavable(record) ? record : undefined
  if (saveOnly && savable === undefined) {
    return (
      <CloseOnly onClose={onClose}>
        This song isn’t downloaded on this device, so there is nothing to save yet.
      </CloseOnly>
    )
  }

  const mp3Kbps = download.mp3Kbps
  // One downloaded song: the exact formats of its file. Otherwise the formats themselves.
  let exact: ExportChoice[] | undefined
  if (single !== undefined && savable !== undefined) {
    exact = exactChoices(savable.format, mp3Kbps === undefined ? {} : { mp3Kbps }, conversions)
    if (exact === undefined) {
      return (
        <CloseOnly onClose={onClose}>
          FXM can’t save this download: its file isn’t in a format FXM reads. Remove the download
          and download it again.
        </CloseOnly>
      )
    }
  }
  const choices: readonly FormatChoice[] = exact ?? plannedChoices(conversions)
  const chosen = choices.find((choice) => choice.format === format) ?? choices[0]
  if (chosen === undefined) return null

  // A collection: the songs downloaded already, and those that can't be downloaded here.
  const isDownloaded = (track: Track) => statuses?.get(downloadId(track)) === 'completed'
  const present = single === undefined ? tracks.filter(isDownloaded) : []
  const included = tracks.filter((track) => isDownloaded(track) || canDownload(track))
  const leftOut = single === undefined ? tracks.length - included.length : 0
  if (single === undefined && included.length === 0) {
    return (
      <CloseOnly onClose={onClose}>
        None of these songs can be downloaded here, so there is nothing to save.
      </CloseOnly>
    )
  }
  const needsDownload = single === undefined ? present.length < included.length : !savable
  const asksLater =
    single !== undefined &&
    !savable &&
    chosen.format === 'original' &&
    getDeviceSaver().asksWhere?.() === true
  const folderPicker = single === undefined && canPickFolder()

  const help =
    exact !== undefined && savable !== undefined
      ? exactChoiceHelp(
          savable,
          exact.find((choice) => choice.format === chosen.format) ?? (exact[0] as ExportChoice),
        )
      : plannedChoiceHelp(chosen.format, sourceKinds(included.length > 0 ? included : tracks), {
          several: single === undefined,
          mp3Kbps,
        })

  const busy = state.kind === 'running'
  const phase = busy
    ? (state.progress?.phase ?? (needsDownload ? 'downloading' : 'saving'))
    : undefined

  /** Saves the songs: asks where straight from the click, then runs the job. */
  const start = () => {
    const controller = new AbortController()
    const chosenFormat = chosen.format
    const saver = getDeviceSaver()
    // First, while the click still counts as the user's: the browser may show its picker.
    let asking: Promise<Destination | undefined>
    if (single !== undefined) {
      const known =
        savable !== undefined
          ? saveRequestFor(savable, chosenFormat, mp3Kbps)
          : plannedSaveRequest(single, chosenFormat)
      if (known !== undefined) {
        asking = saver
          .choose(known)
          .then((target) => (target === undefined ? undefined : { kind: 'target', target }))
      } else {
        // Original: its file type is the download's. A picker that opens only from a click asks
        // once the song is downloaded, with the Save button; anything else saves on its own.
        asking = Promise.resolve(
          saver.asksWhere?.() === true ? { kind: 'none' } : { kind: 'each', saver },
        )
      }
    } else if (saver.chooseFolder !== undefined) {
      asking = saver.chooseFolder({ id: SAVE_FOLDER_ID }).then((folder) => {
        if (folder === undefined) return undefined
        return folder === null ? { kind: 'each', saver } : { kind: 'folder', folder }
      })
    } else {
      asking = Promise.resolve({ kind: 'each', saver })
    }
    // Then the download's own request, also from the click: Firefox asks the user.
    if (needsDownload) void requestStoragePersistence()
    void run(asking, controller, chosenFormat)
  }

  const run = async (
    asking: Promise<Destination | undefined>,
    controller: AbortController,
    chosenFormat: DownloadFormat,
  ) => {
    let destination: Destination | undefined
    try {
      destination = await asking
    } catch {
      // A saver that fails to ask (a native dialog that broke): nothing was downloaded or converted.
      if (open.current) {
        setState({ kind: 'failed', message: saveErrorText('write-failed', chosenFormat) })
      }
      return
    }
    if (destination === undefined) return
    if (!open.current) {
      if (destination.kind === 'target') await destination.target.discard()
      return
    }
    const folder = destination.kind === 'folder' ? destination.folder.name : undefined
    const viaDownloads = destination.kind === 'each' && nativeDeviceSaver() === undefined
    running.current = controller
    setState({ kind: 'running', progress: undefined, folder, viaDownloads })
    try {
      const result = await runDownloadJob({
        downloads: getDownloads(),
        tracks: single === undefined ? included : tracks,
        format: chosenFormat,
        mp3Kbps,
        destination,
        lyrics: (track, signal) =>
          getLyricsProvider().getLyrics(track, lyricsContext(mode, signal)),
        onProgress: (progress) => {
          if (open.current && !controller.signal.aborted) {
            setState({ kind: 'running', progress, folder, viaDownloads })
          }
        },
        signal: controller.signal,
      })
      running.current = undefined
      if (!open.current) return
      const [failure] = result.failed
      if (result.downloaded.length > 0 && failure === undefined) {
        setState({
          kind: 'idle',
          notice: `“${single?.title ?? ''}” is downloaded. Press Save to choose where its file goes.`,
        })
        return
      }
      if (failure === undefined) {
        showStatus(savedMessage(result, { folder, downloads: viaDownloads }))
        onClose()
        return
      }
      if (single !== undefined) {
        setState({ kind: 'failed', message: failure.message })
        return
      }
      setState({ kind: 'summary', saved: result.saved.length, failed: result.failed, folder })
    } catch (error) {
      if (running.current === controller) running.current = undefined
      if (!open.current) return
      if (controller.signal.aborted) {
        setState({ kind: 'idle' })
        return
      }
      setState({
        kind: 'failed',
        message: error instanceof SaveError ? error.message : saveErrorText('failed', chosenFormat),
      })
    }
  }

  if (state.kind === 'summary') {
    return <Summary state={state} total={included.length} onClose={onClose} />
  }

  let action = needsDownload ? 'Download' : 'Save'
  if (phase === 'downloading') action = 'Downloading…'
  else if (phase === 'saving') action = 'Saving…'

  return (
    <>
      {single === undefined && (present.length > 0 || leftOut > 0) && (
        <div className="mb-4 space-y-1">
          {present.length > 0 && (
            <Notice>
              {present.length === included.length
                ? 'They are all downloaded already: FXM saves them from their copies, without downloading them again.'
                : `${countLabel(present.length, 'song')} ${present.length === 1 ? 'is' : 'are'} downloaded already: FXM saves ${present.length === 1 ? 'it' : 'them'} from ${present.length === 1 ? 'its copy' : 'their copies'}.`}
            </Notice>
          )}
          {leftOut > 0 && (
            <Notice>
              {leftOut === 1
                ? 'One song can’t be downloaded here, so it’s left out.'
                : `${leftOut} songs can’t be downloaded here, so they’re left out.`}
            </Notice>
          )}
        </div>
      )}
      <fieldset className="space-y-2" disabled={busy} aria-describedby={helpId}>
        <legend className="mb-2 text-sm font-semibold">Format</legend>
        {choices.map((choice) => (
          <label
            key={choice.format}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent has-[:disabled]:cursor-default"
          >
            <input
              type="radio"
              name={`${groupId}-format`}
              value={choice.format}
              checked={choice.format === chosen.format}
              onChange={() => {
                setFormat(choice.format)
                setState({ kind: 'idle' })
              }}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1 text-sm">{choice.label}</span>
            {choice.extension !== undefined && (
              <span className="shrink-0 text-xs text-text-muted">.{choice.extension}</span>
            )}
          </label>
        ))}
      </fieldset>
      <div id={helpId} className="mt-3 space-y-1">
        {help.map((line) => (
          <Notice key={line}>{line}</Notice>
        ))}
        {!busy && asksLater && (
          <Notice>
            FXM asks where to save once the song is downloaded: only then is its file type known.
          </Notice>
        )}
        {!busy && single === undefined && (
          <Notice>
            {folderPicker
              ? 'FXM asks for a folder and saves each song there as soon as it’s ready.'
              : saveTo === 'app'
                ? 'FXM saves each song on this device as soon as it’s ready.'
                : MULTIPLE_DOWNLOADS}
          </Notice>
        )}
        {!busy && needsDownload && (
          <Notice>
            {single === undefined
              ? 'The songs also stay in Downloads, to play offline.'
              : 'The song also stays in Downloads, to play offline.'}
          </Notice>
        )}
      </div>
      {notice !== undefined && (
        <p role="status" className="mt-3 text-sm font-semibold">
          {notice}
        </p>
      )}
      {busy && (
        <JobStatus
          progress={state.progress}
          single={single !== undefined}
          downloading={needsDownload}
          folder={state.folder}
          viaDownloads={single === undefined && state.viaDownloads}
        />
      )}
      {state.kind === 'failed' && (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {state.message}
        </p>
      )}
      {chosen.needsCore && <ConverterCredit className="mt-3 text-xs text-text-muted" />}
      <StickyActions>
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost' })}
          onClick={() => {
            if (busy) running.current?.abort()
            else onClose()
          }}
        >
          Cancel
        </button>
        <button
          ref={primary}
          type="button"
          data-autofocus=""
          disabled={busy}
          className={buttonClasses({ variant: 'primary' })}
          onClick={start}
        >
          {action}
        </button>
      </StickyActions>
    </>
  )
}

/** The dialog's description: the song, and the file it has; or the collection and its size. */
function useDescription(request: DownloadDialogRequest | null): string | undefined {
  const tracks = request?.tracks ?? []
  const single = tracks.length === 1 ? tracks[0] : undefined
  const record = useDownload(single)
  if (request === null) return undefined
  if (single !== undefined) {
    return `“${single.title}”${isSavable(record) ? ` · downloaded as ${formatLabel(record.format)}` : ''}`
  }
  const songs = countLabel(tracks.length, 'song')
  return request.title === undefined ? songs : `“${request.title}” · ${songs}`
}

/**
 * The Download dialog, and "Save to device" for a downloaded song (`request.save`).
 *
 * - **Download** asks for the format, starting at the download format of Settings, with honest
 *   words for each (YouTube audio is never lossless). Its button asks where to save straight
 *   from the click (the browser's save picker for one song, a folder for several, where the
 *   browser has them; its downloads elsewhere), then downloads each song into FXM's store, where
 *   it plays offline and joins Downloads, and saves its file from there: converted, tagged and
 *   written, with the progress and a Cancel button. A song downloaded already is saved from its
 *   copy.
 * - **Save to device** offers a downloaded song's file in every format, labelled for that file.
 *
 * Closing the dialog stops what it runs. `null` closes it.
 */
export function DownloadDialog({
  request,
  onClose,
  conversions = RELEASED.conversions,
}: {
  request: DownloadDialogRequest | null
  onClose: () => void
  /**
   * Whether other formats than the original are offered (stage 4.2). Default:
   * `RELEASED.conversions`.
   */
  conversions?: boolean
}) {
  const description = useDescription(request)
  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      title={request?.save === true ? 'Save to device' : 'Download'}
      description={description}
    >
      {request !== null && (
        <DownloadForm request={request} onClose={onClose} conversions={conversions} />
      )}
    </Dialog>
  )
}
