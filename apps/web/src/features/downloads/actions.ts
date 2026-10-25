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
import { requestStoragePersistence } from './persistence'
import { getDownloads } from './runtime'

/** The track a removal needs: its ID, and its title for the confirmation. */
export type RemovableTrack = Pick<Track, 'id'> & { title?: string | undefined }

/** Downloads `tracks` that can be downloaded here and aren't already. */
export async function downloadTracks(tracks: readonly Track[]): Promise<void> {
  // First, while the click still counts as the user's: the browser may ask.
  void requestStoragePersistence()
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
 * entry whose file isn't on this device (e.g. from a backup of another device).
 */
export async function removeDownloads(tracks: readonly RemovableTrack[]): Promise<void> {
  const { manager } = getDownloads()
  const library = getLibrary()
  try {
    for (const track of tracks) {
      await manager.remove(downloadId(track))
      await library.removeDownload(track.id)
    }
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

/** Deletes every download and empties the Downloads playlist. */
export async function removeAllDownloads(): Promise<void> {
  const library = getLibrary()
  try {
    const removed = await getDownloads().manager.removeAll()
    const view = await library.getPlaylistView(DOWNLOADS_PLAYLIST_ID)
    const ids = new Set<EntityId<'track'>>([
      ...removed.map((record) => record.track.id),
      ...(view?.rows.map((row) => row.id) ?? []),
    ])
    for (const id of ids) await library.removeDownload(id)
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
