import { create } from 'zustand'

/**
 * What autoplay is doing (stage 3.4), for the queue panel: whether songs are on their way, and
 * what autoplay last changed in the queue, which the panel tells screen readers. Only
 * `connectAutoplay` writes it. Not saved.
 */
export interface AutoplayActivity {
  /**
   * - `waiting`: the queue is low, and autoplay waits a moment for it to settle;
   * - `planning`: autoplay is finding the songs to add;
   * - `idle`: neither: the queue has enough, autoplay is off or can't run here, or it found
   *   nothing for the queue as it is.
   */
  readonly status: 'idle' | 'waiting' | 'planning'
  /** What autoplay last changed in the queue; a new object for every change. */
  readonly change?: AutoplayChange
}

/** One change autoplay made to the queue. */
export interface AutoplayChange {
  /** `added`: it added songs; `withdrawn`: switched off, it took its songs out. */
  readonly type: 'added' | 'withdrawn'
  /** The songs it added or took out, in queue order: at least one. */
  readonly titles: readonly string[]
}

/** Creates the activity store (one per app; tests make their own). */
export function createAutoplayActivityStore() {
  return create<AutoplayActivity>()(() => ({ status: 'idle' }))
}

export type AutoplayActivityStore = ReturnType<typeof createAutoplayActivityStore>

export const useAutoplayActivity: AutoplayActivityStore = createAutoplayActivityStore()

/** Whether autoplay is about to add songs: the queue panel says it is finding them. */
export function isFindingSongs(activity: AutoplayActivity): boolean {
  return activity.status !== 'idle'
}

/** What to tell screen readers about `change`, e.g. "Autoplay added 4 songs, starting with …". */
export function autoplayChangeMessage(change: AutoplayChange): string {
  const [first = 'a song'] = change.titles
  const count = change.titles.length
  if (change.type === 'added') {
    return count === 1
      ? `Autoplay added ${first}.`
      : `Autoplay added ${count} songs, starting with ${first}.`
  }
  return count === 1
    ? `Autoplay is off. It took out ${first}, the song it added.`
    : `Autoplay is off. It took out the ${count} songs it added.`
}
