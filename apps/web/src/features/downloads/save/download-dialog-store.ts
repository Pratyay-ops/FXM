/**
 * Which songs the Download dialog is open for, if any: any menu or button opens it with
 * {@link openDownloadDialog} (or {@link openSaveDialog} for "Save to device…"), and the shell
 * renders it once (`DownloadDialogHost`), loading its code on first use.
 *
 * @module
 */

import type { Track } from '@fxm/core'
import { create } from 'zustand'

/** What the Download dialog is for. */
export interface DownloadDialogRequest {
  /** The songs: one, or a collection (an album, a playlist, a selection). */
  readonly tracks: readonly Track[]
  /** What to call a collection in the dialog and its messages: an album's or a playlist's name. */
  readonly title?: string | undefined
  /**
   * "Save to device…": a downloaded song's file, in the format the user picks, without
   * downloading. Otherwise the dialog downloads what isn't downloaded yet first.
   */
  readonly save?: boolean
}

/** A request, numbered in the order the requests were made. */
export interface NumberedDownloadRequest extends DownloadDialogRequest {
  readonly serial: number
}

interface DownloadDialogState {
  request: NumberedDownloadRequest | null
  open: (request: DownloadDialogRequest) => void
  close: () => void
}

let requestCount = 0

/** The Download dialog's request. */
export const useDownloadDialogStore = create<DownloadDialogState>()((set) => ({
  request: null,
  open: (request) => {
    requestCount += 1
    set({ request: { ...request, serial: requestCount } })
  },
  close: () => set({ request: null }),
}))

/** Opens the Download dialog for `request`'s songs. */
export function openDownloadDialog(request: DownloadDialogRequest): void {
  useDownloadDialogStore.getState().open(request)
}

/** Opens the dialog as "Save to device" for a downloaded song. */
export function openSaveDialog(track: Track): void {
  openDownloadDialog({ tracks: [track], save: true })
}
