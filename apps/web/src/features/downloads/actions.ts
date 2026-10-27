/**
 * What the download buttons and menus do, with the confirmations they show. Call these straight
 * from the click: starting a download also asks the browser to keep FXM's data when space runs
 * low, and Firefox asks the user only from a click.
 *
 * @module
 */

import type { EntityId, Track } from '@fxm/core'
import { downloadId } from '@fxm/downloads'
import { getLibrary } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID } from '../../db/types'
import { countLabel } from '../library/format'
import { showStatus } from '../library/status'
import { useQualityStore } from '../settings/quality-store'
import { requestStoragePersistence } from './persistence'
import { getDownloads } from './runtime'
import { fileSavingAvailable } from './save/device'
import { openDownloadDialog } from './save/download-dialog-store'

/** The track a removal needs: its ID, and its title for the confirmation. */
export type RemovableTrack = Pick<Track, 'id'> & { title?: string | undefined }

/**
 * What the confirmation adds where Download can't save a file although its setting is on: the
 * desktop and Android apps until they have a saver of their own.
 */
export function offlineOnlyNote(several: boolean): string {
  return `Saving files isn’t available here, so ${several ? 'they play' : 'it plays'} offline in FXM only`
}

/**
 * Downloads `tracks` that can be downloaded here and aren't already, into FXM's store only: they
 * play offline and join Downloads, and no file is saved. `offlineOnly` adds that saving a file
 * isn't available here (Download's setting is on, but this device has nowhere to save).
 */
export async function downloadTracks(
  tracks: readonly Track[],
  { offlineOnly = false }: { offlineOnly?: boolean } = {},
): Promise<void> {
  // First, while the click still counts as the user's: the browser may ask.
  void requestStoragePersistence()
  const [only] = tracks
  const note = (several: boolean) => (offlineOnly ? `. ${offlineOnlyNote(several)}` : '')
  try {
    const { queued, present, skipped } = await getDownloads().manager.enqueueAll(tracks)
    if (tracks.length === 1 && only !== undefined) {
      if (queued === 1) showStatus(`Downloading “${only.title}”${note(false)}`)
      else if (present === 1) showStatus(`“${only.title}” is already in Downloads`)
      else showStatus(`“${only.title}” can’t be downloaded here`)
      return
    }
    if (queued > 0) {
      const extra = present > 0 ? `, ${countLabel(present, 'song')} already there` : ''
      showStatus(`Downloading ${countLabel(queued, 'song')}${extra}${note(queued > 1)}`)
    } else if (present > 0) {
      showStatus('These songs are already in Downloads')
    } else if (skipped > 0) {
      showStatus('These songs can’t be downloaded here')
    }
  } catch {
    showStatus('Couldn’t start the download')
  }
}

/**
 * Whether Download saves a file too: the setting "Save a file to this device when downloading"
 * is on (it is by default), and this device has somewhere to save (not the desktop or Android
 * app before they set a saver of their own).
 */
export function downloadSavesFile(): boolean {
  return useQualityStore.getState().downloads.saveFile && fileSavingAvailable()
}

/**
 * What Download does, from any menu or button: with "Save a file to this device when
 * downloading" on, it opens the Download dialog, which asks for the format and where to save
 * (call it straight from the click: the dialog's own button opens the browser's picker), and
 * downloads and saves the songs. With the setting off, it keeps an offline copy in FXM only, as
 * {@link downloadTracks} does; and where no file can be saved, it does the same and says so.
 * `title` names a collection (an album, a playlist) in the dialog.
 */
export function requestDownload(
  tracks: readonly Track[],
  { title }: { title?: string | undefined } = {},
): void {
  if (tracks.length === 0) return
  if (downloadSavesFile()) {
    openDownloadDialog({ tracks, title })
    return
  }
  void downloadTracks(tracks, { offlineOnly: useQualityStore.getState().downloads.saveFile })
}

/**
 * Deletes the downloads of `tracks` and takes them out of the Downloads playlist, also for an
 * entry whose file isn't on this device (e.g. from a backup of another device): one change to
 * the downloads and one to the playlist, however many there are.
 */
export async function removeDownloads(tracks: readonly RemovableTrack[]): Promise<void> {
  const { manager } = getDownloads()
  const library = getLibrary()
  try {
    await manager.removeMany(tracks.map((track) => downloadId(track)))
    await library.removeDownloads(tracks.map((track) => track.id))
    const [only] = tracks
    showStatus(
      tracks.length === 1 && only?.title !== undefined
        ? `Removed the download of “${only.title}”`
        : `Removed ${countLabel(tracks.length, 'download')}`,
    )
  } catch {
    showStatus('Couldn’t remove the download')
  }
}

/** Deletes every download and empties the Downloads playlist, each in one change. */
export async function removeAllDownloads(): Promise<void> {
  const library = getLibrary()
  try {
    const removed = await getDownloads().manager.removeAll()
    const view = await library.getPlaylistView(DOWNLOADS_PLAYLIST_ID)
    const ids = new Set<EntityId<'track'>>([
      ...removed.map((record) => record.track.id),
      ...(view?.rows.map((row) => row.id) ?? []),
    ])
    await library.removeDownloads([...ids])
    showStatus('Removed every download')
  } catch {
    showStatus('Couldn’t remove the downloads')
  }
}

/** Pauses a download that is waiting or running. */
export async function pauseDownload(id: string): Promise<void> {
  await getDownloads()
    .manager.pause(id)
    .catch(() => undefined)
}

/** Resumes a paused download, or retries a failed one, from where it stopped. */
export async function resumeDownload(id: string): Promise<void> {
  void requestStoragePersistence()
  await getDownloads()
    .manager.resume(id)
    .catch(() => undefined)
}

/** Pauses every download that is waiting or running. */
export async function pauseAllDownloads(): Promise<void> {
  await getDownloads()
    .manager.pauseAll()
    .catch(() => undefined)
}

/** Resumes every paused download and retries every failed one. */
export async function resumeAllDownloads(): Promise<void> {
  void requestStoragePersistence()
  await getDownloads()
    .manager.resumeAll()
    .catch(() => undefined)
}
