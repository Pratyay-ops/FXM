/**
 * Small builders for the queue tests. Not exported from the package.
 *
 * @module
 */

import { formatId } from '../ids'
import type { Track, TrackKind } from '../model'
import type { AudioCandidate } from '../providers'
import type { QueueState } from './queue'

/** A YouTube Music track whose title is `name`, so tests can read the queue by title. */
export function track(name: string, kind: TrackKind = 'song'): Track {
  return {
    id: formatId('ytm', 'track', name),
    source: 'ytm',
    title: name,
    artists: [{ name: 'Artist' }],
    artwork: [],
    kind,
    durationMs: 200_000,
  }
}

/** One song per name. */
export function songs(...names: string[]): Track[] {
  return names.map((name) => track(name))
}

/** An audio candidate for the YouTube video `ref`. */
export function candidate(ref: string, kind: TrackKind = 'song'): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind,
    title: ref,
    artists: ['Artist'],
    confidence: 0.9,
    evidence: ['test'],
  }
}

/** The titles of the queue's items, in play order. */
export function titles(state: QueueState): string[] {
  return state.items.map((item) => item.track.title)
}

/** The title of the current item. */
export function currentTitle(state: QueueState): string | undefined {
  return state.items[state.index]?.track.title
}

/** The titles of the played items, oldest first. */
export function playedTitles(state: QueueState): string[] {
  return state.playedUids.map(
    (uid) => state.items.find((item) => item.uid === uid)?.track.title ?? `missing ${uid}`,
  )
}
