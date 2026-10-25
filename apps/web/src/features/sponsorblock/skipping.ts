/**
 * Skipping the non-music parts of videos (stage 8.7): the player's segment skipper from
 * `@fxm/player`, fed by SponsorBlock (`sponsorblock-source.ts`) and following the setting and
 * the catalog mode. The app's playback connects it (`features/now-playing/playback.ts`).
 *
 * @module
 */

import { connectSegmentSkipper, type Player, type SegmentSkipper } from '@fxm/player'
import { create } from 'zustand'
import { useSettingsStore } from '../settings/settings-store'
import { segmentsFor } from './sponsorblock-source'
import { useSponsorBlockStore } from './sponsorblock-store'

/** The last skip, for the notice that offers to undo it. */
export interface SkipNotice {
  /** Tells notices apart: a new skip is a new notice. */
  id: number
  /** The queue item the skip happened in, by its uid; "Undo" works only while it plays. */
  uid: number
  /** The track's title, for the notice. */
  title: string
  /** Whether the skip ran to the end of the track, which then ended. */
  toEnd: boolean
}

interface SkipNoticeState {
  /** The notice to show, until it is dismissed or replaced. */
  notice: SkipNotice | undefined
  dismiss: () => void
}

/** The skip notice. Not persisted: it is about the last few seconds. */
export const useSkipNoticeStore = create<SkipNoticeState>()((set) => ({
  notice: undefined,
  dismiss: () => set({ notice: undefined }),
}))

let active: SegmentSkipper | undefined
let notices = 0

/**
 * Connects SponsorBlock skipping to the app's `player`: the skipper asks `segmentsFor` for each
 * track, which answers only for videos in Music + Video mode while the setting is on, and asks
 * again whenever the setting or the mode changes. Each skip becomes the skip notice. Returns a
 * function that disconnects it.
 */
export function connectSponsorBlock(player: Player): () => void {
  const skipper = connectSegmentSkipper(player, { segmentsFor })
  active = skipper
  const disconnects = [
    skipper.on('skip', ({ item, segment, toMs }) => {
      notices += 1
      useSkipNoticeStore.setState({
        notice: {
          id: notices,
          uid: item.uid,
          title: item.track.title,
          toEnd: toMs < segment.endMs,
        },
      })
    }),
    useSponsorBlockStore.subscribe((state, previous) => {
      if (state.enabled === previous.enabled) return
      if (!state.enabled) useSkipNoticeStore.getState().dismiss()
      skipper.refresh()
    }),
    useSettingsStore.subscribe((state, previous) => {
      if (state.catalogMode !== previous.catalogMode) skipper.refresh()
    }),
  ]
  return () => {
    for (const disconnect of disconnects) disconnect()
    skipper.disconnect()
    if (active === skipper) active = undefined
    useSkipNoticeStore.getState().dismiss()
  }
}

/**
 * Undoes the last skip: playback goes back to where it jumped from, and that part plays this
 * time. Returns whether there was a skip to undo in the track playing.
 */
export function undoLastSkip(): boolean {
  const undone = active?.undo() ?? false
  useSkipNoticeStore.getState().dismiss()
  return undone
}
