import { type ExportChoice, exportChoices, sourceLabel } from '@fxm/convert'
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
import {
  fileDescription,
  getDeviceSaver,
  isSavable,
  SAVE_ERROR_TEXT,
  type SavableDownload,
  SaveError,
  saveDownload,
  savePlan,
} from './save'

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
  if (choice.needsCore) lines.push('FXM converts it on this device, which takes a little while.')
  return lines
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving'; readonly progress: number | undefined }
  | { readonly kind: 'failed'; readonly message: string }

function Notice({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>
}

function SaveForm({ track, onClose }: { track: Track; onClose: () => void }) {
  const record = useDownload(track)
  const download = useQualityStore((state) => state.prefs.download)
  const mode = useSettingsStore((state) => state.catalogMode)
  const [format, setFormat] = useState<DownloadFormat>(download.format)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const running = useRef<AbortController | undefined>(undefined)
  const groupId = useId()
  const helpId = useId()

  // Closing the dialog cancels a conversion still running.
  useEffect(() => () => running.current?.abort(), [])

  if (record === undefined) return null
  if (!isSavable(record)) {
    return (
      <>
        <Notice>This song isn’t downloaded on this device, so there is nothing to save yet.</Notice>
        <DialogActions>
          <button type="button" className={buttonClasses({ variant: 'ghost' })} onClick={onClose}>
            Close
          </button>
        </DialogActions>
      </>
    )
  }
  const mp3Kbps = download.mp3Kbps
  const choices = exportChoices(record.format, mp3Kbps === undefined ? {} : { mp3Kbps })
  const chosen = choices.find((choice) => choice.format === format) ?? choices[0]
  if (chosen === undefined) return null
  const saving = state.kind === 'saving'

  const save = async () => {
    const { plan, fileName } = savePlan(record, chosen.format, mp3Kbps)
    // First, while the click still counts as the user's: the browser may show its file picker.
    const target = await getDeviceSaver().choose({
      fileName,
      mimeType: plan.output.mimeType,
      description: fileDescription(plan),
    })
    if (target === undefined) return
    const controller = new AbortController()
    running.current = controller
    setState({ kind: 'saving', progress: undefined })
    try {
      const downloads = getDownloads()
      const result = await saveDownload(record, {
        format: chosen.format,
        ...(mp3Kbps === undefined ? {} : { mp3Kbps }),
        target,
        read: (file, type) => downloads.storage.read(file, type),
        fetch: downloads.environment.context().fetch,
        lyrics: () => getLyricsProvider().getLyrics(track, lyricsContext(mode, controller.signal)),
        onProgress: (done) => {
          if (!controller.signal.aborted) setState({ kind: 'saving', progress: done })
        },
        signal: controller.signal,
      })
      running.current = undefined
      showStatus(
        result.tagged
          ? `Saved “${track.title}” as ${result.fileName}`
          : `Saved “${track.title}” as ${result.fileName}, without its tags`,
      )
      onClose()
    } catch (error) {
      running.current = undefined
      if (controller.signal.aborted) {
        setState({ kind: 'idle' })
        return
      }
      setState({
        kind: 'failed',
        message: error instanceof SaveError ? error.message : SAVE_ERROR_TEXT.failed,
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
