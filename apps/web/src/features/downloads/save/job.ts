/**
 * Download, then save: what the Download dialog runs once the user has said where the files go.
 * Each song is downloaded into FXM's own store first (so it plays offline and joins the
 * Downloads playlist, as every download does), then saved from that copy like Save to device
 * saves it: converted where needed, tagged, and written. A song downloaded already is saved
 * from its copy straight away, without the network.
 *
 * The download queue runs in whichever tab holds its lock, so the job follows each song's record
 * in the database rather than the manager's events, which only that tab hears.
 *
 * @module
 */

import {
  type DeviceSaver,
  exportFileName,
  exportMimeType,
  type SaveFolder,
  type SaveRequest,
  type SaveTarget,
  tagsFromTrack,
} from '@fxm/convert'
import {
  DOWNLOAD_FORMATS,
  type DownloadFormat,
  type Lyrics,
  type Mp3Bitrate,
  type Track,
} from '@fxm/core'
import {
  type DownloadErrorCode,
  type DownloadRecord,
  downloadId,
  isDownloadRecord,
} from '@fxm/downloads'
import { liveQuery } from 'dexie'
import { countLabel } from '../../library/format'
import { ERROR_TEXT } from '../format'
import type { Downloads } from '../runtime'
import {
  fileDescription,
  isSavable,
  type SavableDownload,
  SaveError,
  saveDownload,
  saveErrorText,
  savePlan,
} from './save'

/**
 * Where the files go, as the user said straight from the click:
 *
 * - `target`: one song's file, at the place its saver's picker chose;
 * - `folder`: a folder the user picked for several songs, each under its own name;
 * - `each`: each file through the device saver once its name is known (the browser's
 *   downloads, or an app's own saver), which needs no click;
 * - `none`: nowhere yet: one song whose file type is known only once it is downloaded, on a
 *   device whose picker opens only from a click. The dialog asks with a second click.
 */
export type Destination =
  | { readonly kind: 'target'; readonly target: SaveTarget }
  | { readonly kind: 'folder'; readonly folder: SaveFolder }
  | { readonly kind: 'each'; readonly saver: DeviceSaver }
  | { readonly kind: 'none' }

/** Why a download stopped before it completed. */
export class DownloadStopped extends Error {
  /** It failed, was paused (by the user, or by the queue for want of room or a bot check), or went away. */
  readonly reason: 'failed' | 'paused' | 'removed'
  /** The download's error, when it has one. */
  readonly code: DownloadErrorCode | undefined
  constructor(reason: DownloadStopped['reason'], code?: DownloadErrorCode) {
    super(`The download ${reason === 'removed' ? 'was cancelled' : reason}`)
    this.name = 'DownloadStopped'
    this.reason = reason
    this.code = code
  }
}

/** What a download that stopped says to the user. */
export function stoppedText(stopped: DownloadStopped): string {
  const why = stopped.code === undefined ? undefined : ERROR_TEXT[stopped.code]
  switch (stopped.reason) {
    case 'failed':
      return `The download failed: ${why ?? ERROR_TEXT.unknown}.`
    case 'paused':
      return why === undefined
        ? 'The download was paused. Resume it in Downloads, then try again.'
        : `The download was paused: ${why}.`
    case 'removed':
      return 'The download was cancelled.'
  }
}

/**
 * Follows the download `id` in `db` until its file is complete: resolves with the record then,
 * calls `onRecord` with every other state it passes through, and rejects with
 * {@link DownloadStopped} when it fails, is paused or goes away, or with the signal's reason.
 */
export function waitForDownload(
  db: Downloads['db'],
  id: string,
  options: { signal: AbortSignal; onRecord?: (record: DownloadRecord) => void },
): Promise<SavableDownload> {
  const { signal } = options
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      subscription.unsubscribe()
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    const subscription = liveQuery(() => db.downloads.get(id)).subscribe({
      next: (value) => {
        const record = isDownloadRecord(value) ? value : undefined
        if (record === undefined || record.status === 'removing') {
          finish(() => reject(new DownloadStopped('removed')))
        } else if (record.status === 'completed') {
          // A completed record without its file is what the queue fails as `file-missing`.
          if (isSavable(record)) finish(() => resolve(record))
          else finish(() => reject(new DownloadStopped('failed', 'file-missing')))
        } else if (record.status === 'failed' || record.status === 'paused') {
          const reason = record.status
          finish(() => reject(new DownloadStopped(reason, record.error?.code)))
        } else {
          options.onRecord?.(record)
        }
      },
      error: (error: unknown) => finish(() => reject(error)),
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Where a job stands, for the dialog's progress. */
export interface JobProgress {
  /** The song in hand. */
  readonly track: Track
  /** Its place in the list, from 0. */
  readonly index: number
  /** How many songs the job saves. */
  readonly total: number
  /** Waiting for its download, or saving its file. */
  readonly phase: 'downloading' | 'saving'
  /** Its download's record while it downloads. */
  readonly record?: DownloadRecord
  /** How far saving got, from 0 to 1, while it saves; `undefined` until it says. */
  readonly saved?: number
  /** How many songs are done: saved, or failed. */
  readonly done: number
}

/** A song the job saved. */
export interface SavedSong {
  readonly track: Track
  readonly fileName: string
  /** Whether its tags made it into the file. */
  readonly tagged: boolean
}

/** A song the job couldn't save, and why, in words. */
export interface FailedSong {
  readonly track: Track
  readonly message: string
}

/** What a job did. */
export interface JobResult {
  readonly saved: readonly SavedSong[]
  readonly failed: readonly FailedSong[]
  /** Songs it only downloaded, for a destination of `none`: the dialog asks where next. */
  readonly downloaded: readonly SavableDownload[]
}

/** What {@link runDownloadJob} needs. */
export interface JobOptions {
  readonly downloads: Pick<Downloads, 'manager' | 'db' | 'storage' | 'environment'>
  readonly tracks: readonly Track[]
  readonly format: DownloadFormat
  readonly mp3Kbps?: Mp3Bitrate | undefined
  readonly destination: Destination
  /** A song's lyrics, for its tags. */
  readonly lyrics: (track: Track, signal: AbortSignal) => Promise<Lyrics | null | undefined>
  readonly onProgress?: (progress: JobProgress) => void
  /**
   * Stops the job: the conversion running stops, its place is given up, downloads the job
   * started and that haven't finished are cancelled, and those it resumed are paused again.
   * Completed downloads stay, as do the files saved so far.
   */
  readonly signal: AbortSignal
}

/** The request the device saver gets for `record`'s file in `format`. */
export function saveRequestFor(
  record: SavableDownload,
  format: DownloadFormat,
  mp3Kbps: Mp3Bitrate | undefined,
): SaveRequest {
  const { plan, fileName } = savePlan(record, format, mp3Kbps)
  return { fileName, mimeType: plan.output.mimeType, description: fileDescription(plan) }
}

/**
 * The request for `track`'s file in `format` before it is downloaded: known for every format but
 * Original, whose file type is the stream's, which only the download decides. Saving a song in a
 * converted format always gives that format's file, whatever its source.
 */
export function plannedSaveRequest(track: Track, format: DownloadFormat): SaveRequest | undefined {
  if (format === 'original') return undefined
  const info = DOWNLOAD_FORMATS[format]
  return {
    // The tags' title and artists, as `savePlan` names the file once it is downloaded.
    fileName: exportFileName(tagsFromTrack(track), info.extension),
    mimeType: exportMimeType(info.container),
    description: `${info.label} audio`,
  }
}

/** Where one song's file goes. */
async function targetFor(
  destination: Exclude<Destination, { kind: 'none' }>,
  request: SaveRequest,
  format: DownloadFormat,
): Promise<SaveTarget | undefined> {
  switch (destination.kind) {
    case 'target':
      return destination.target
    case 'folder':
      return destination.folder.target(request)
    case 'each':
      try {
        return await destination.saver.choose(request)
      } catch {
        throw new SaveError('write-failed', saveErrorText('write-failed', format))
      }
  }
}

/**
 * Downloads `tracks` into FXM's store where they aren't there already, and saves each one's file
 * in `format` to `destination` as soon as its download completes, in the order of the list. A
 * song that can't be downloaded here, whose download stops, or whose save fails is reported in
 * `failed`, and the others go on.
 *
 * @throws the signal's reason once it aborts, after tidying up (see `JobOptions.signal`).
 */
export async function runDownloadJob(options: JobOptions): Promise<JobResult> {
  const { downloads, format, mp3Kbps, destination, signal } = options
  const { manager, db } = downloads
  const saved: SavedSong[] = []
  const failed: FailedSong[] = []
  const downloaded: SavableDownload[] = []
  // One file per song, also when a list holds a song twice.
  const tracks = [...new Map(options.tracks.map((track) => [downloadId(track), track])).values()]

  // A single place chosen at the click, until `saveDownload` has it (which gives it up itself
  // when saving fails): given up here if the job ends without saving into it.
  let unusedTarget = destination.kind === 'target' ? destination.target : undefined
  const giveUp = () => unusedTarget?.discard().catch(() => undefined)

  // Which downloads this job starts (to cancel them if it stops) or resumes (to pause again).
  let records: (DownloadRecord | undefined)[]
  try {
    records = await Promise.all(tracks.map((track) => manager.get(track)))
  } catch (error) {
    await giveUp()
    throw error
  }
  const before = new Map(tracks.map((track, index) => [downloadId(track), records[index]]))
  const wanted = tracks.filter((track) => {
    const record = before.get(downloadId(track))
    if (record?.status === 'completed') return false
    if (manager.availability(track).available) return true
    failed.push({ track, message: `“${track.title}” can’t be downloaded here.` })
    return false
  })
  const started = wanted.filter((track) => before.get(downloadId(track)) === undefined)
  const resumed = wanted.filter((track) => {
    const status = before.get(downloadId(track))?.status
    return status === 'paused' || status === 'failed'
  })
  if (wanted.length > 0) {
    try {
      await manager.enqueueAll(wanted)
    } catch (error) {
      await giveUp()
      throw error
    }
  }

  const tidyUp = async () => {
    const left = async (list: readonly Track[]) => {
      const records = await Promise.all(list.map((track) => manager.get(track)))
      return records.filter(
        (record): record is DownloadRecord => record !== undefined && record.status !== 'completed',
      )
    }
    await manager.removeMany((await left(started)).map((record) => record.id))
    for (const record of await left(resumed)) await manager.pause(record.id)
  }

  const failedIds = new Set(failed.map(({ track }) => downloadId(track)))
  try {
    for (const [index, track] of tracks.entries()) {
      signal.throwIfAborted()
      const id = downloadId(track)
      if (failedIds.has(id)) continue
      const done = saved.length + failed.length + downloaded.length
      const report = (progress: Omit<JobProgress, 'track' | 'index' | 'total' | 'done'>) =>
        options.onProgress?.({ track, index, total: tracks.length, done, ...progress })
      try {
        // A song downloaded already is saved straight away, from its copy.
        if (before.get(id)?.status !== 'completed') report({ phase: 'downloading' })
        const record = await waitForDownload(db, id, {
          signal,
          onRecord: (current) => report({ phase: 'downloading', record: current }),
        })
        if (destination.kind === 'none') {
          downloaded.push(record)
          continue
        }
        report({ phase: 'saving' })
        const target = await targetFor(destination, saveRequestFor(record, format, mp3Kbps), format)
        // The app's own saver may ask, and the user may say no: that song isn't saved.
        if (target === undefined) {
          failed.push({ track, message: 'Not saved: no place was chosen.' })
          continue
        }
        if (target === unusedTarget) unusedTarget = undefined
        const result = await saveDownload(record, {
          format,
          ...(mp3Kbps === undefined ? {} : { mp3Kbps }),
          target,
          read: (file, type) => downloads.storage.read(file, type),
          fetch: downloads.environment.context().fetch,
          lyrics: () => options.lyrics(track, signal),
          onProgress: (value) => {
            if (!signal.aborted) report({ phase: 'saving', saved: value })
          },
          signal,
        })
        saved.push({ track, fileName: result.fileName, tagged: result.tagged })
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof DownloadStopped) {
          failed.push({ track, message: stoppedText(error) })
        } else if (error instanceof SaveError) {
          failed.push({ track, message: error.message })
        } else {
          failed.push({ track, message: saveErrorText('failed', format) })
        }
      }
    }
  } catch (error) {
    await giveUp()
    await tidyUp().catch(() => undefined)
    throw error
  }
  // A place never written to (its download failed) leaves no empty file behind.
  await giveUp()
  return { saved, failed, downloaded }
}

/** The toast after a job that saved every song: "Saved “Song” as Artist - Song.flac". */
export function savedMessage(
  result: JobResult,
  where: { readonly folder?: string | undefined; readonly downloads?: boolean },
): string {
  const [only] = result.saved
  if (result.saved.length === 1 && only !== undefined) {
    return only.tagged
      ? `Saved “${only.track.title}” as ${only.fileName}`
      : `Saved “${only.track.title}” as ${only.fileName}, without its tags`
  }
  const songs = countLabel(result.saved.length, 'song')
  if (where.folder !== undefined) return `Saved ${songs} to “${where.folder}”`
  if (where.downloads) return `Saved ${songs} to your browser’s downloads`
  return `Saved ${songs}`
}
