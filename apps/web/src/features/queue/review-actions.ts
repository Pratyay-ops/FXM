/**
 * What the user does with the queue's review list: approve a best guess, pick another version,
 * approve every best guess at once, or play one best guess without approving it. Call these
 * straight from event handlers, so playback starts inside the user's gesture.
 *
 * @module
 */

import type { AudioCandidate, QueueItem, Track } from '@fxm/core'
import { getPlayback } from '../now-playing/playback'
import { useQueueReviewStore } from './review-store'

/** Whether two candidates are the same audio: the same source and native ID. */
export function sameAudio(a: AudioCandidate | undefined, b: AudioCandidate | undefined): boolean {
  return a !== undefined && b !== undefined && a.source === b.source && a.ref === b.ref
}

/**
 * Makes `candidate` the audio of `track`: the version the user approved or picked. Every queue
 * item of the track plays it from now on, the policy remembers it (a pin in the match cache),
 * and the track leaves the review list. If the track is playing another version, it switches at
 * once and carries on at the same position; if it already plays this one, nothing interrupts it.
 */
export function chooseVersion(track: Track, candidate: AudioCandidate): void {
  const { player, policy } = getPlayback()
  policy.pin(track, candidate)
  for (const item of player.getState().queue.items) {
    if (item.track.id === track.id && !sameAudio(item.candidate, candidate)) {
      player.setCandidate(item.uid, candidate)
    }
  }
  useQueueReviewStore.getState().dismiss(track.id)
}

/**
 * Approves the best guess of every track in the review list that is in the queue. The tracks
 * the queue already skipped (before the current item) move up to play next, in their order;
 * the others keep their place.
 */
export function approveAllBestGuesses(): void {
  const { player } = getPlayback()
  const { entries } = useQueueReviewStore.getState()
  const { queue } = player.getState()
  const approved = new Map<string, { track: Track; bestGuess: AudioCandidate }>()
  const skipped: number[] = []
  queue.items.forEach((item, index) => {
    const bestGuess = entries[item.track.id]
    if (bestGuess === undefined) return
    approved.set(item.track.id, { track: item.track, bestGuess })
    if (index < queue.index) skipped.push(item.uid)
  })
  for (const { track, bestGuess } of approved.values()) chooseVersion(track, bestGuess)
  let moved = 0
  for (const uid of skipped) {
    const { items, index } = player.getState().queue
    const from = items.findIndex((item) => item.uid === uid)
    if (from < 0 || from >= index) continue
    // Right after the current item and the ones moved before it. Taking an item from before
    // the current one shifts that one back by one, so its old index is the slot after it.
    player.move(from, index + moved)
    moved++
  }
}

/**
 * Plays the item at `index` with its best guess, without approving it: playing it is the
 * explicit action a Suggest-band match needs, but the track stays in the review list until the
 * user says the version is right.
 */
export function playBestGuess(item: QueueItem, index: number, bestGuess: AudioCandidate): void {
  const { player } = getPlayback()
  player.setCandidate(item.uid, bestGuess)
  void player.play(index)
}
