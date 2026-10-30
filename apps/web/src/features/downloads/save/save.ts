/**
 * "Save to device" (stage 4.2): a completed download, in the format the user picks, with its
 * tags, cover and lyrics, written where the user keeps files. The stored download stays the
 * original for offline playback; only the saved copy is converted.
 *
 * Two pieces can be replaced: the converter (the worker running FXM's ffmpeg core) and the
 * device saver (the browser's file picker or downloads). The desktop app (stage 7.4) and the
 * Android app (6.4) set their own saver with {@link setDeviceSaver}, so a saved file goes
 * through a native dialog or into the device's music library.
 *
 * @module
 */

import {
  type ConvertErrorCode,
  type Converter,
  createBrowserDeviceSaver,
  createConverter,
  type DeviceSaver,
  type ExportPlan,
  exportFileName,
  fetchCover,
  isConvertError,
  planExport,
  type SaveTarget,
  tagsFromTrack,
} from '@fxm/convert'
import {
  DOWNLOAD_FORMATS,
  type DownloadFormat,
  type Lyrics,
  type Mp3Bitrate,
  type ProviderContext,
} from '@fxm/core'
import type { DownloadRecord } from '@fxm/downloads'
import { mimeTypeOf } from '@fxm/player'
import { appShowsImage } from '../../../lib/images'
import { nativeDeviceSaver } from './device'

export { setDeviceSaver } from './device'

let converter: Converter | undefined
let browserSaver: DeviceSaver | undefined

/** Where the app serves the ffmpeg core: its `ffmpeg/` folder (make dist puts it there). */
export function coreBaseUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}ffmpeg/`, globalThis.location?.href).href
}

/** The app's converter: one worker, started on first use. */
export function getConverter(): Converter {
  converter ??= createConverter({
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    coreBase: coreBaseUrl(),
  })
  return converter
}

/** Replaces the converter, e.g. with an in-process one in tests; `undefined` restores the worker. */
export function setConverter(next: Converter | undefined): void {
  converter?.dispose()
  converter = next
}

/**
 * How saved files reach the device: the desktop or Android app's own saver once it set one
 * (`setDeviceSaver`), else the browser's picker or downloads. Whether there is anywhere to save
 * at all is `fileSavingAvailable()` (`./device`): the native apps have nowhere until they set
 * theirs.
 */
export function getDeviceSaver(): DeviceSaver {
  const native = nativeDeviceSaver()
  if (native !== undefined) return native
  browserSaver ??= createBrowserDeviceSaver()
  return browserSaver
}

/** A completed download whose file is there: with its file and what the file holds. */
export type SavableDownload = DownloadRecord &
  Required<Pick<DownloadRecord, 'file' | 'format'>> & { readonly status: 'completed' }

/**
 * Whether `record` is a completed download with its file. Whether FXM can save that file is
 * `isExportable(record.format)` (`@fxm/convert`): a stored video whose audio isn't AAC in MP4
 * can't be, which no source delivers.
 */
export function isSavable(record: DownloadRecord | null | undefined): record is SavableDownload {
  return (
    record !== null &&
    record !== undefined &&
    record.status === 'completed' &&
    record.file !== undefined &&
    record.format !== undefined
  )
}

/**
 * The plan, file name and type of saving `record` as `format`.
 *
 * @throws ConvertError `unsupported-input` for a file FXM can't save (`isExportable`).
 */
export function savePlan(
  record: SavableDownload,
  format: DownloadFormat,
  mp3Kbps: Mp3Bitrate | undefined,
): { plan: ExportPlan; fileName: string } {
  const plan = planExport(record.format, format, mp3Kbps === undefined ? {} : { mp3Kbps })
  // The tags' title and artists: a stored track's names are checked to be text there.
  const fileName = exportFileName(tagsFromTrack(record.track), plan.output.extension)
  return { plan, fileName }
}

/** What a saved file's picker says it is: "FLAC audio", or "WEBM audio" for an original. */
export function fileDescription(plan: ExportPlan): string {
  const name =
    plan.format === 'original'
      ? plan.output.extension.toUpperCase()
      : DOWNLOAD_FORMATS[plan.format].label
  return `${name} audio`
}

/** Why saving failed, for the UI. */
export type SaveErrorCode = ConvertErrorCode | 'file-missing' | 'read-failed' | 'write-failed'

/** What each failure says to the user, when a format other than Original was chosen. */
export const SAVE_ERROR_TEXT: Readonly<Record<SaveErrorCode, string>> = {
  'core-unavailable':
    "Converting doesn't work in this browser right now. Save the original instead, or reload FXM and try again.",
  'unsupported-input': "FXM can't read this download's format.",
  'corrupt-input': 'The downloaded file is damaged. Remove the download and download it again.',
  'out-of-memory': 'The file is too large to convert in this browser. Save the original instead.',
  cancelled: 'Cancelled.',
  failed: 'The conversion failed. Try again, or save the original.',
  'file-missing': 'The downloaded file is gone. Download it again.',
  'read-failed': "FXM couldn't read the downloaded file right now. Reload FXM and try again.",
  'write-failed': "FXM couldn't write the file there. Try another folder.",
}

/**
 * What the failures that suggest saving the original say when the original is what failed.
 * Original never needs the core (an original WebM is saved untagged without it), so these are
 * rare: memory running out while the audio of a video is extracted, say.
 */
const ORIGINAL_ERROR_TEXT: Readonly<Partial<Record<SaveErrorCode, string>>> = {
  'core-unavailable': "Saving doesn't work in this browser right now. Reload FXM and try again.",
  'out-of-memory': 'The file is too large to save in this browser.',
  failed: 'Saving failed. Try again.',
}

/** What a failure says to the user, for the format that was chosen. */
export function saveErrorText(code: SaveErrorCode, format?: DownloadFormat): string {
  return (format === 'original' ? ORIGINAL_ERROR_TEXT[code] : undefined) ?? SAVE_ERROR_TEXT[code]
}

/** A failed save, with its reason. */
export class SaveError extends Error {
  readonly code: SaveErrorCode
  constructor(code: SaveErrorCode, message = SAVE_ERROR_TEXT[code]) {
    super(message)
    this.name = 'SaveError'
    this.code = code
  }
}

/** Converts a WebP or GIF cover to JPEG through a canvas, where the browser has one. */
export async function canvasToJpeg(image: Blob): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return undefined
  }
  try {
    const bitmap = await createImageBitmap(image)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  } catch {
    return undefined
  }
}

/** How long the cover and the lyrics may take before the file is saved without them. */
export const EXTRAS_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/** What {@link saveDownload} needs besides the download. */
export interface SaveOptions {
  readonly format: DownloadFormat
  readonly mp3Kbps?: Mp3Bitrate
  /** Where to write: what the device saver's `choose` returned, from the click. */
  readonly target: SaveTarget
  /** Reads the stored file (the downloads' storage). */
  readonly read: (file: string, type: string) => Promise<Blob | undefined>
  /** The platform's `fetch`, for the cover. */
  readonly fetch: ProviderContext['fetch']
  /** The track's lyrics, when it has any. */
  readonly lyrics?: () => Promise<Lyrics | null | undefined>
  /**
   * Which of the track's covers may be fetched for the file, by URL. Default: what the app may
   * load (`appShowsImage`), so no cover comes from Spotify while Spotify is switched off.
   */
  readonly showImage?: (url: string) => boolean
  readonly onProgress?: (done: number) => void
  readonly signal?: AbortSignal
}

/** What a finished save did. */
export interface SaveResult {
  readonly fileName: string
  readonly plan: ExportPlan
  /** Whether the tags made it into the file. */
  readonly tagged: boolean
}

/**
 * Saves `record` as `options.format` to `options.target`: reads the stored file, fetches the
 * cover and the lyrics (each left out when slow or missing), converts and tags it in the
 * conversion worker, and writes it. On any failure the target is given up.
 *
 * @throws SaveError with the reason, in words for the chosen format.
 */
export async function saveDownload(
  record: SavableDownload,
  options: SaveOptions,
): Promise<SaveResult> {
  const fail = (code: SaveErrorCode) => new SaveError(code, saveErrorText(code, options.format))
  const showImage = options.showImage ?? appShowsImage
  try {
    const { plan } = savePlan(record, options.format, options.mp3Kbps)
    const type = mimeTypeOf(record.format) ?? 'application/octet-stream'
    const [input, cover, lyrics] = await Promise.all([
      // Storage that can't be read (no Origin Private File System here, say) isn't a missing file.
      options.read(record.file, type).catch(() => {
        throw fail('read-failed')
      }),
      withTimeout(
        fetchCover(
          record.track.artwork.filter((image) => showImage(image.url)),
          {
            fetch: options.fetch,
            toJpeg: canvasToJpeg,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        ),
        EXTRAS_TIMEOUT_MS,
        undefined,
      ),
      withTimeout(options.lyrics?.() ?? Promise.resolve(undefined), EXTRAS_TIMEOUT_MS, undefined),
    ])
    if (input === undefined) throw fail('file-missing')
    options.signal?.throwIfAborted()
    const tags = tagsFromTrack(record.track, {
      ...(lyrics === undefined ? {} : { lyrics }),
      ...(cover === undefined ? {} : { cover }),
    })
    const outcome = await getConverter().exportAudio(
      {
        input,
        source: record.format,
        format: options.format,
        ...(options.mp3Kbps === undefined ? {} : { options: { mp3Kbps: options.mp3Kbps } }),
        tags,
      },
      {
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )
    try {
      await options.target.write(outcome.blob)
    } catch {
      throw fail('write-failed')
    }
    return { fileName: options.target.fileName, plan, tagged: outcome.tagged }
  } catch (error) {
    await options.target.discard().catch(() => undefined)
    if (error instanceof SaveError) throw error
    if (isConvertError(error)) throw fail(error.code)
    if (options.signal?.aborted) throw fail('cancelled')
    throw fail('failed')
  }
}
