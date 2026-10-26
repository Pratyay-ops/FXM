import {
  type ExportChoice,
  type ExportOptions,
  exportChoices,
  isExportable,
  type SaveTarget,
  type SourceAudio,
  sourceLabel,
} from '@fxm/convert'
import { DOWNLOAD_FORMATS, type DownloadFormat, isLosslessCodec, type Track } from '@fxm/core'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { buttonClasses } from '../../../components/ui/button'
import { showStatus } from '../../library/status'
import { Dialog, DialogActions } from '../../library/ui/dialog'
import { getLyricsProvider, lyricsContext } from '../../lyrics/lyrics-source'
import { useQualityStore } from '../../settings/quality-store'
import { useSettingsStore } from '../../settings/settings-store'
import { formatLabel } from '../format'
import { useDownload } from '../hooks'
import { ProgressBar } from '../progress'
import { getDownloads } from '../runtime'
import { ConverterCredit } from './credit'
import {
  fileDescription,
  getDeviceSaver,
  isSavable,
  type SavableDownload,
  SaveError,
  saveDownload,
  saveErrorText,
  savePlan,
} from './save'

/** The formats `source` can be saved in, or `undefined` when FXM can't save it at all. */
function choicesFor(source: SourceAudio, options: ExportOptions): ExportChoice[] | undefined {
  if (!isExportable(source)) return undefined
  try {
    return exportChoices(source, options)
  } catch {
    return undefined
  }
}

/** What the chosen format means for this download, in a sentence or two. */
function choiceHelp(record: SavableDownload, choice: ExportChoice): string[] {
  const lines: string[] = []
  const source = record.format
  if (source.media === 'muxed-video') {
    lines.push('This song was downloaded as a 360p video. FXM saves its audio track only.')
  }
  if (choice.format === 'original') {
    lines.push(
      source.container === 'webm'
        ? 'The audio exactly as downloaded, with its title, artists and album. WebM files have no place for a cover.'
        : 'The audio exactly as downloaded, with its tags, cover and lyrics.',
    )
  } else if (DOWNLOAD_FORMATS[choice.format].lossless && !isLosslessCodec(source.codec)) {
    lines.push(
      `${sourceLabel(source)} is never lossless: converting it gives a bigger file, not a better one.`,
    )
  }
  // A remux (WebM's tags, Opus into .opus) keeps the audio as it is: only a re-encode converts.
  if (choice.needsCore && choice.transcoded) {
    lines.push('FXM converts it on this device, which takes a little while.')
  }
  return lines
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving'; readonly progress: number | undefined }
  | { readonly kind: 'failed'; readonly message: string }

function Notice({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>
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

function SaveForm({ track, onClose }: { track: Track; onClose: () => void }) {
  const record = useDownload(track)
  const download = useQualityStore((state) => state.prefs.download)
  const mode = useSettingsStore((state) => state.catalogMode)
  const [format, setFormat] = useState<DownloadFormat>(download.format)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const running = useRef<AbortController | undefined>(undefined)
  // Whether the dialog is still open: a save that ends after it closed changes nothing on it.
  const open = useRef(true)
  const groupId = useId()
  const helpId = useId()

  // Closing the dialog cancels a conversion still running.
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
      running.current?.abort()
    }
  }, [])

  if (record === undefined) return null
  if (!isSavable(record)) {
    return (
      <CloseOnly onClose={onClose}>
        This song isn’t downloaded on this device, so there is nothing to save yet.
      </CloseOnly>
    )
  }
  const mp3Kbps = download.mp3Kbps
  const choices = choicesFor(record.format, mp3Kbps === undefined ? {} : { mp3Kbps })
  if (choices === undefined) {
    return (
      <CloseOnly onClose={onClose}>
        FXM can’t save this download: its file isn’t in a format FXM reads. Remove the download and
        download it again.
      </CloseOnly>
    )
  }
  const chosen = choices.find((choice) => choice.format === format) ?? choices[0]
  if (chosen === undefined) return null
  const saving = state.kind === 'saving'

  const save = async () => {
    const controller = new AbortController()
    try {
      const { plan, fileName } = savePlan(record, chosen.format, mp3Kbps)
      let target: SaveTarget | undefined
      try {
        // First, while the click still counts as the user's: the browser may show its picker.
        target = await getDeviceSaver().choose({
          fileName,
          mimeType: plan.output.mimeType,
          description: fileDescription(plan),
        })
      } catch {
        // A saver that fails to ask (a native dialog that broke): nothing was converted.
        throw new SaveError('write-failed', saveErrorText('write-failed', chosen.format))
      }
      if (target === undefined || !open.current) {
        await target?.discard()
        return
      }
      running.current = controller
      setState({ kind: 'saving', progress: undefined })
      const downloads = getDownloads()
      const result = await saveDownload(record, {
        format: chosen.format,
        ...(mp3Kbps === undefined ? {} : { mp3Kbps }),
        target,
        read: (file, type) => downloads.storage.read(file, type),
        fetch: downloads.environment.context().fetch,
        lyrics: () => getLyricsProvider().getLyrics(track, lyricsContext(mode, controller.signal)),
        onProgress: (done) => {
          if (open.current && !controller.signal.aborted) {
            setState({ kind: 'saving', progress: done })
          }
        },
        signal: controller.signal,
      })
      running.current = undefined
      showStatus(
        result.tagged
          ? `Saved “${track.title}” as ${result.fileName}`
          : `Saved “${track.title}” as ${result.fileName}, without its tags`,
      )
      if (open.current) onClose()
    } catch (error) {
      if (running.current === controller) running.current = undefined
      if (!open.current) return
      if (controller.signal.aborted) {
        setState({ kind: 'idle' })
        return
      }
      setState({
        kind: 'failed',
        message:
          error instanceof SaveError ? error.message : saveErrorText('failed', chosen.format),
      })
    }
  }

  return (
    <>
      <fieldset className="space-y-2" disabled={saving} aria-describedby={helpId}>
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
            <span className="shrink-0 text-xs text-text-muted">.{choice.extension}</span>
          </label>
        ))}
      </fieldset>
      <div id={helpId} className="mt-3 space-y-1">
        {choiceHelp(record, chosen).map((line) => (
          <Notice key={line}>{line}</Notice>
        ))}
      </div>
      {saving && (
        <div className="mt-4 space-y-2">
          <ProgressBar
            value={state.progress}
            label={`Saving ${track.title}`}
            valueText={
              state.progress === undefined ? 'Starting' : `${Math.round(state.progress * 100)}%`
            }
          />
        </div>
      )}
      {state.kind === 'failed' && (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {state.message}
        </p>
      )}
      {chosen.needsCore && <ConverterCredit className="mt-3 text-xs text-text-muted" />}
      <DialogActions>
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost' })}
          onClick={() => {
            if (saving) running.current?.abort()
            else onClose()
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          data-autofocus=""
          disabled={saving}
          className={buttonClasses({ variant: 'primary' })}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </DialogActions>
    </>
  )
}

/**
 * "Save to device" for a downloaded song: the formats it can be saved in, each with its honest
 * label (YouTube audio is never called lossless), the conversion's progress, and errors in
 * words. The format starts at the download setting (Settings → Audio quality).
 */
export function SaveToDeviceDialog({
  track,
  onClose,
}: {
  /** The song to save; `null` closes the dialog. */
  track: Track | null
  onClose: () => void
}) {
  const record = useDownload(track ?? undefined)
  return (
    <Dialog
      open={track !== null}
      onClose={onClose}
      title="Save to device"
      description={
        track === null
          ? undefined
          : `“${track.title}”${isSavable(record) ? ` · downloaded as ${formatLabel(record.format)}` : ''}`
      }
    >
      {track !== null && <SaveForm track={track} onClose={onClose} />}
    </Dialog>
  )
}
