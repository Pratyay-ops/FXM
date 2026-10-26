/**
 * Saving a download to the device's Music folder on Android (stage 6.4): a copy of the finished
 * file in Music/FXM, through MediaStore, where every music app finds it. The download itself
 * stays in the app's storage and keeps playing offline in FXM.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import type { DownloadRecord } from '../types'
import { type FxmDownloadsPlugin, fxmDownloadsErrorCode } from './plugin'

/** Where a saved song is: its MediaStore URI, and its path, e.g. `Music/FXM/A - B.m4a`. */
export interface ExportedDownload {
  readonly uri: string
  readonly path: string
}

/**
 * Whether `record`'s file can be saved to Music now: a completed download of audio. A video file
 * (YouTube's itag 18) can't until stage 4.2 takes its audio out: saving it would put a video
 * among the songs (ARCHITECTURE.md §14).
 */
export function canExportToMusic(record: DownloadRecord): boolean {
  return (
    record.status === 'completed' && record.file !== undefined && record.format?.media === 'audio'
  )
}

/**
 * Saves a copy of `record`'s file to Music/FXM, named `Artist - Title`. Call it from a click: on
 * Android 9 and older the app asks for the permission it needs. Rejects with an `FxmError`:
 * `Unsupported` for a download that can't be saved ({@link canExportToMusic}),
 * `AuthRequired` when the user refused the permission, `NotFound` when the file is gone,
 * `Unavailable` otherwise (a full disk, the storage failing), with a message for people.
 */
export async function exportDownloadToMusic(
  plugin: Pick<FxmDownloadsPlugin, 'exportToMusic'>,
  record: DownloadRecord,
): Promise<ExportedDownload> {
  const { format, file } = record
  if (!canExportToMusic(record) || format === undefined || file === undefined) {
    throw new FxmError(
      'Unsupported',
      format?.media === 'muxed-video'
        ? 'This download is a video file: saving its sound to Music comes with conversion'
        : 'Only a finished download can be saved to Music',
    )
  }
  try {
    const { uri, path } = await plugin.exportToMusic({
      file,
      codec: format.codec,
      container: format.container,
      media: format.media,
      title: record.track.title,
      artists: record.track.artists.map((artist) => artist.name),
      ...(record.track.album?.name ? { album: record.track.album.name } : {}),
    })
    return { uri, path }
  } catch (error) {
    switch (fxmDownloadsErrorCode(error)) {
      case 'DENIED':
        throw new FxmError('AuthRequired', 'Allow FXM to save to your Music folder to do that', {
          cause: error,
        })
      case 'NOT_FOUND':
        throw new FxmError('NotFound', 'The downloaded file is gone', { cause: error })
      case 'BAD_REQUEST':
        throw new FxmError('Unsupported', 'This download’s format can’t be saved to Music yet', {
          cause: error,
        })
      case 'NO_SPACE':
        throw new FxmError('Unavailable', 'There is no room left on this device', {
          cause: error,
        })
      default:
        throw new FxmError('Unavailable', 'Couldn’t save the song to Music', { cause: error })
    }
  }
}
