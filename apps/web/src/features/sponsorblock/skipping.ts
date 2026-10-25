/**
 * Skipping the non-music parts of videos (stage 8.7): the player's segment skipper from
 * `@fxm/player`, fed by SponsorBlock (`sponsorblock-source.ts`) and following the setting and
 * the catalog mode. The app's playback connects it (`features/now-playing/playback.ts`).
 *
 * @module
 */

import {
  connectSegmentSkipper,
  type Player,
  type SegmentSkip,
  type SegmentSkipper,
} from '@fxm/player'
import { create } from 'zustand'
import { useSettingsStore } from '../settings/settings-store'
import { segmentsFor } from './sponsorblock-source'
import { useSponsorBlockStore } from './sponsorblock-store'

/**
 * The part of a track a skip passed, as the notice names it: the intro (it started the track),
 * the outro (it ended the track) or another part.
 */
export type SkipPart = 'intro' | 'outro' | 'other'

/** The last skip, for the notice that offers to undo it. */
export interface SkipNotice {
  /** Tells notices apart: a new skip is a new notice. */
  id: number
  /** The queue item the skip happened in, by its uid; "Undo" works only while it plays. */
  uid: number
  /** The track's title, for the notice. */
  title: string
  /** The part skipped. An outro ended the track, so it has nothing to undo. */
  part: SkipPart
}

interface SkipNoticeState {
  /**
   * The notice to show, until it is dismissed or replaced. A notice with Undo also goes once
   * Undo stops working: the track changed or started over, or the user moved playback.
   */
  notice: SkipNotice | undefined
  dismiss: () => void
}

/** The skip notice. Not persisted: it is about the track playing. */
export const useSkipNoticeStore = create<SkipNoticeState>()((set) => ({
  notice: undefined,
  dismiss: () => set({ notice: undefined }),
}))

/** A part that starts within this time of the start of the track is its intro. */
const INTRO_START_MS = 1000

/** Which part `skip` passed. */
export function skipPart({ segment, toMs }: SegmentSkip): SkipPart {
  // A skip to the end stops a moment short of the segment's end, from where the track ends.
  if (toMs < segment.endMs) return 'outro'
  return segment.startMs < INTRO_START_MS ? 'intro' : 'other'
}

let active: SegmentSkipper | undefined
let notices = 0

/**
 * Connects SponsorBlock skipping to the app's `player`: the skipper asks `segmentsFor` for each
 * track, which answers only for videos in Music + Video mode while the setting is on, and asks
 * again whenever the setting or the mode changes. Each skip becomes the skip notice, which keeps
 * its Undo for as long as the skipper can undo the skip. Returns a function that disconnects it.
 */
export function connectSponsorBlock(player: Player): () => void {
  const skipper = connectSegmentSkipper(player, { segmentsFor })
  active = skipper
  /** The skip the notice shows. */
  let shown: SegmentSkip | undefined
  const disconnects = [
    skipper.on('skip', (skip) => {
      notices += 1
      shown = skip
      useSkipNoticeStore.setState({
        notice: {
          id: notices,
          uid: skip.item.uid,
          title: skip.item.track.title,
          part: skipPart(skip),
        },
      })
    }),
    skipper.on('undoexpire', (skip) => {
      const { notice, dismiss } = useSkipNoticeStore.getState()
      // An outro's notice has no Undo, and goes by itself.
      if (skip === shown && notice !== undefined && notice.part !== 'outro') dismiss()
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
