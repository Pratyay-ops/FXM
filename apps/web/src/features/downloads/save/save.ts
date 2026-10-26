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

let converter: Converter | undefined
let saver: DeviceSaver | undefined

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

/** How saved files reach the device: the browser's picker or downloads by default. */
export function getDeviceSaver(): DeviceSaver {
  saver ??= createBrowserDeviceSaver()
  return saver
}

/**
 * Replaces the device saver: the desktop and Android apps save their own way (stages 7.4 and
 * 6.4); tests pass fakes. `undefined` goes back to the browser's.
 */
export function setDeviceSaver(next: DeviceSaver | undefined): void {
  saver = next
}

/** A completed download that can be saved: with its file and what the file holds. */
export type SavableDownload = DownloadRecord &
  Required<Pick<DownloadRecord, 'file' | 'format'>> & { readonly status: 'completed' }

/** Whether `record` is a completed download whose file can be saved. */
export function isSavable(record: DownloadRecord | null | undefined): record is SavableDownload {
  return (
    record !== null &&
    record !== undefined &&
    record.status === 'completed' &&
    record.file !== undefined &&
    record.format !== undefined
  )
}

/** The plan, file name and type of saving `record` as `format`. */
export function savePlan(
  record: SavableDownload,
  format: DownloadFormat,
  mp3Kbps: Mp3Bitrate | undefined,
): { plan: ExportPlan; fileName: string } {
  const plan = planExport(record.format, format, mp3Kbps === undefined ? {} : { mp3Kbps })
  const fileName = exportFileName(
    { title: record.track.title, artists: record.track.artists.map((artist) => artist.name) },
    plan.output.extension,
  )
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
export type SaveErrorCode = ConvertErrorCode | 'file-missing' | 'write-failed'

/** What each failure says to the user. */
export const SAVE_ERROR_TEXT: Readonly<Record<SaveErrorCode, string>> = {
  'core-unavailable':
    "Converting doesn't work in this browser right now. Save the original instead, or reload FXM and try again.",
  'unsupported-input': "FXM can't read this download's format.",
  'corrupt-input': 'The downloaded file is damaged. Remove the download and download it again.',
  'out-of-memory': 'The file is too large to convert in this browser. Save the original instead.',
  cancelled: 'Cancelled.',
  failed: 'The conversion failed. Try again, or save the original.',
  'file-missing': 'The downloaded file is gone. Download it again.',
  'write-failed': "FXM couldn't write the file there. Try another folder.",
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
 * conversion worker, and writes it.
 *
 * @throws SaveError with the reason.
 */
export async function saveDownload(
  record: SavableDownload,
  options: SaveOptions,
): Promise<SaveResult> {
  const { plan } = savePlan(record, options.format, options.mp3Kbps)
  try {
    const type = mimeTypeOf(record.format) ?? 'application/octet-stream'
    const [input, cover, lyrics] = await Promise.all([
      options.read(record.file, type),
      withTimeout(
        fetchCover(record.track.artwork, {
          fetch: options.fetch,
          toJpeg: canvasToJpeg,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
        EXTRAS_TIMEOUT_MS,
        undefined,
      ),
      withTimeout(options.lyrics?.() ?? Promise.resolve(undefined), EXTRAS_TIMEOUT_MS, undefined),
    ])
    if (input === undefined) throw new SaveError('file-missing')
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
      throw new SaveError('write-failed')
    }
    return { fileName: options.target.fileName, plan, tagged: outcome.tagged }
  } catch (error) {
    await options.target.discard().catch(() => undefined)
    if (error instanceof SaveError) throw error
    if (isConvertError(error)) throw new SaveError(error.code)
    if (options.signal?.aborted) throw new SaveError('cancelled')
    throw new SaveError('failed')
  }
}
