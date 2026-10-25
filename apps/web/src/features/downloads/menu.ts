/**
 * Download entries for the menus of track lists: "Download", "Cancel download" and "Remove
 * download", depending on where the track's download stands and whether it can be downloaded
 * here.
 *
 * @module
 */

import type { EntityId, Track } from '@fxm/core'
import { downloadId } from '@fxm/downloads'
import { ArrowDownToLine, CircleMinus, CircleX } from 'lucide-react'
import { useCallback } from 'react'
import type { MenuItem } from '../library/ui/menu'
import { downloadTracks, removeDownloads } from './actions'
import { useCanDownload, useDownloadStatuses } from './hooks'

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

/** Download entries for the rows of a list, from one live read of every download. */
export function useDownloadMenuItem(): DownloadMenuItem {
  const statuses = useDownloadStatuses()
  const canDownload = useCanDownload()
  return useCallback<DownloadMenuItem>(
    (row, { inDownloads = false } = {}) => {
      const title = row.track?.title
      const status = statuses.get(downloadId(row))
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
