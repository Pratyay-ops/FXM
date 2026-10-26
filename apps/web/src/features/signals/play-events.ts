/**
 * The player's plays as events, for the rest of the app: the play recorder announces each play
 * as it starts and once it ends (what it records in the library), and features that follow the
 * listening, such as scrobbling (stage 8.2), listen here instead of watching the player again.
 *
 * Only the player's own plays come through here. A listening history imported from another
 * service (stage 3.6) goes straight to the library and is never announced.
 *
 * @module
 */

import type { QueueContext, Track } from '@fxm/core'
import type { NewPlay } from '../../db/repo'

/** A play that started. */
export interface PlayStarted {
  /** The track. */
  track: Track
  /** When it started playing, as epoch milliseconds. */
  startedAt: number
  /** Where its queue was started from: the queue's context, as the library stores it. */
  context?: QueueContext
}

/** What a listener hears. Both are optional. */
export interface PlayListener {
  /** A play started. */
  started?(play: PlayStarted): void
  /** A play ended and counts: the play the recorder saves in the library. */
  ended?(play: NewPlay): void
}

const listeners = new Set<PlayListener>()

/** Listens to the player's plays. Returns the function that stops listening. */
export function onPlays(listener: PlayListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Calls each listener; one that fails never keeps the others, or the recorder, from going on. */
function announce(call: (listener: PlayListener) => void): void {
  for (const listener of [...listeners]) {
    try {
      call(listener)
    } catch (error) {
      console.error('A play listener failed', error)
    }
  }
}

/** Announces a play that started. The play recorder calls it. */
export function announcePlayStarted(play: PlayStarted): void {
  announce((listener) => listener.started?.(play))
}

/** Announces a play that ended and counts. The play recorder calls it. */
export function announcePlayEnded(play: NewPlay): void {
  announce((listener) => listener.ended?.(play))
}
