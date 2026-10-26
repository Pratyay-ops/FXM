/**
 * Download entries for the menus of track lists: "Download", "Cancel download" and "Remove
 * download", depending on where the track's download stands and whether it can be downloaded
 * here; "Save to device…" for a finished one, and in the Android app "Save to Music folder" too.
 *
 * @module
 */

import type { EntityId, Track } from '@fxm/core'
import { downloadId } from '@fxm/downloads'
import { ArrowDownToLine, CircleMinus, CircleX, FolderDown, HardDriveDownload } from 'lucide-react'
import { useCallback } from 'react'
import type { MenuItem } from '../library/ui/menu'
import { downloadTracks, removeDownloads, saveDownloadToMusic } from './actions'
import { useCanDownload, useDownloadStatuses } from './hooks'
import { getDownloads } from './runtime'

/** A row a download entry is for: its track ID, and its track when the cache has it. */
export interface DownloadMenuRow {
  id: EntityId<'track'>
  track?: Track | undefined
}

/** Builds the download entry of a row's menu, if it gets one. */
export type DownloadMenuItem = (
  row: DownloadMenuRow,
  options?: {
    /**
     * The row is in the Downloads playlist: it always offers "Remove download", the only way
     * out of that list, also for a song whose file isn't on this device.
     */
    inDownloads?: boolean
  },
) => MenuItem | undefined

/**
 * Download entries for the rows of a list, from one live read of every download. Until that
 * read answers, rows outside Downloads get no entry, rather than "Download" for a song that is
 * downloaded already.
 */
export function useDownloadMenuItem(): DownloadMenuItem {
  const statuses = useDownloadStatuses()
  const canDownload = useCanDownload()
  return useCallback<DownloadMenuItem>(
    (row, { inDownloads = false } = {}) => {
      const title = row.track?.title
      if (!inDownloads && statuses === undefined) return undefined
      const status = statuses?.get(downloadId(row))
      const remove = () => void removeDownloads([{ id: row.id, title }])
      if (inDownloads || status === 'completed') {
        return {
          id: 'remove-download',
          label: 'Remove download',
          icon: CircleMinus,
          danger: true,
          onSelect: remove,
        }
      }
      if (status !== undefined) {
        return { id: 'cancel-download', label: 'Cancel download', icon: CircleX, onSelect: remove }
      }
      const { track } = row
      if (track === undefined || !canDownload(track)) return undefined
      return {
        id: 'download',
        label: 'Download',
        icon: ArrowDownToLine,
        onSelect: () => void downloadTracks([track]),
      }
    },
    [statuses, canDownload],
  )
}

/**
 * The "Save to device…" entry of a row's menu: only for a song downloaded on this device, whose
 * file can be saved in another format (stage 4.2). `onSave` opens the save dialog.
 */
export function useSaveMenuItem(
  onSave: (track: Track) => void,
): (row: DownloadMenuRow) => MenuItem | undefined {
  const statuses = useDownloadStatuses()
  return useCallback(
    (row) => {
      const { track } = row
      if (track === undefined || statuses?.get(downloadId(row)) !== 'completed') return undefined
      return {
        id: 'save-to-device',
        label: 'Save to device…',
        icon: HardDriveDownload,
        onSelect: () => onSave(track),
      }
    },
    [statuses, onSave],
  )
}

/**
 * "Save to Music folder" for the rows of a list whose download is finished, in the Android app
 * only (stage 6.4): a copy in Music/FXM, where every music app finds it. Elsewhere, and for a
 * song that isn't downloaded, no entry.
 */
export function useSaveToMusicMenuItem(): (row: DownloadMenuRow) => MenuItem | undefined {
  const statuses = useDownloadStatuses()
  const android = getDownloads().plugin !== undefined
  return useCallback(
    (row) => {
      if (!android || statuses?.get(downloadId(row)) !== 'completed') return undefined
      const title = row.track?.title ?? 'This song'
      return {
        id: 'save-to-music',
        label: 'Save to Music folder',
        icon: FolderDown,
        onSelect: () => void saveDownloadToMusic({ id: row.id, title }),
      }
    },
    [android, statuses],
  )
}
