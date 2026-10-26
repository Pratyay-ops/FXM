/**
 * What the download buttons and menus do, with the confirmations they show. Call these straight
 * from the click: starting a download also asks the browser to keep FXM's data when space runs
 * low, and Firefox asks the user only from a click.
 *
 * @module
 */

import { type EntityId, isFxmError, type Track } from '@fxm/core'
import { downloadId, exportDownloadToMusic } from '@fxm/downloads'
import { getLibrary } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID } from '../../db/types'
import { countLabel } from '../library/format'
import { showStatus } from '../library/status'
import { requestStoragePersistence } from './persistence'
import { getDownloads } from './runtime'

/** Where the app remembers that it asked to show download notifications (Android). */
export const NOTIFICATIONS_ASKED_KEY = 'fxm-download-notifications-asked'

/**
 * In the Android app, asks once for the notification permission (Android 13+), from the click
 * that starts the first download, so the progress notification of the background service shows.
 * The downloads run either way.
 */
function askForDownloadNotifications(): void {
  const { plugin } = getDownloads()
  if (plugin === undefined) return
  try {
    if (localStorage.getItem(NOTIFICATIONS_ASKED_KEY) !== null) return
    localStorage.setItem(NOTIFICATIONS_ASKED_KEY, '1')
  } catch {
    // Storage blocked: ask now, as if for the first time.
  }
  void plugin.requestNotifications().catch(() => {})
}

/** The track a removal needs: its ID, and its title for the confirmation. */
export type RemovableTrack = Pick<Track, 'id'> & { title?: string | undefined }

/** Downloads `tracks` that can be downloaded here and aren't already. */
export async function downloadTracks(tracks: readonly Track[]): Promise<void> {
  // First, while the click still counts as the user's: the browser may ask.
  void requestStoragePersistence()
  askForDownloadNotifications()
  const [only] = tracks
  try {
    const { queued, present, skipped } = await getDownloads().manager.enqueueAll(tracks)
    if (tracks.length === 1 && only !== undefined) {
      if (queued === 1) showStatus(`Downloading “${only.title}”`)
      else if (present === 1) showStatus(`“${only.title}” is already in Downloads`)
      else showStatus(`“${only.title}” can’t be downloaded here`)
      return
    }
    if (queued > 0) {
      const extra = present > 0 ? `, ${countLabel(present, 'song')} already there` : ''
      showStatus(`Downloading ${countLabel(queued, 'song')}${extra}`)
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

/**
 * In the Android app, saves a copy of the finished download of `track` to Music/FXM, where every
 * music app finds it. Call it from the click: on Android 9 and older the app asks for the
 * permission it needs.
 */
export async function saveDownloadToMusic(track: Pick<Track, 'id' | 'title'>): Promise<void> {
  const { plugin, manager } = getDownloads()
  if (plugin === undefined) return
  try {
    const record = await manager.get(track)
    if (record === undefined) {
      showStatus(`“${track.title}” isn’t downloaded on this device`)
      return
    }
    const { path } = await exportDownloadToMusic(plugin, record)
    showStatus(`Saved “${track.title}” to ${path}`)
  } catch (error) {
    showStatus(isFxmError(error) ? error.message : 'Couldn’t save the song to Music')
  }
}
