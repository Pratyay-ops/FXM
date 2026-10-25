/**
 * Records what the player plays as listening signals (stage 3.1): one play for each time a track
 * is heard, saved to the library's history, which also scores it in the listening affinity.
 *
 * A play starts when its queue item starts playing, and ends when another item becomes current,
 * the track ends or restarts, the queue ends, the track fails, or the page goes away. It
 * records:
 *
 * - **the time played**: listening time only. Each stretch between two position updates while
 *   playing counts the shorter of the time that passed and the distance the position moved, so
 *   pauses, buffering, seeks ahead and a device that slept in the middle never count;
 * - **completion and skips**: see {@link PLAY_OUTCOMES}. The player's event causes tell a track
 *   that ended from one the user skipped, went back from, replaced or that failed;
 * - **the context** the queue was started from and **the stream** that played;
 * - the track's length, as the player knew it.
 *
 * A play shorter than {@link MIN_RECORDED_PLAY_MS} that did not reach the end is not recorded:
 * that is someone skipping through the queue, not listening.
 *
 * Likes and playlist adds need no wiring: the library records them as it saves them.
 *
 * It also announces each play as it starts, and each play it records, to the listeners of
 * `play-events.ts`, such as scrobbling.
 *
 * @module
 */

import {
  currentQueueItem,
  type PlayContext,
  playContextOf,
  playStreamOf,
  type QueueItem,
  type StreamOption,
} from '@fxm/core'
import type { Player, PlayerState, TrackChangeCause } from '@fxm/player'
import type { NewPlay } from '../../db/repo'
import { announcePlayEnded, announcePlayStarted } from './play-events'

/** Shorter plays that did not reach the end are not recorded: quick skips, not listens. */
export const MIN_RECORDED_PLAY_MS = 1000

/** How a play ended: whether it reached the end, and whether the user skipped the rest. */
interface Outcome {
  completed: boolean
  skipped: boolean
}

const COMPLETED: Outcome = { completed: true, skipped: false }
const SKIPPED: Outcome = { completed: false, skipped: true }
const STOPPED: Outcome = { completed: false, skipped: false }

/**
 * How a play ends when the player's current item changes, by the change's cause:
 *
 * - `ended`: it played to the end
 * - `next`, `jump`, `removed`: the user moved on, picked another item or removed the playing
 *   one, so the rest was skipped
 * - `previous`, `queue`, `failed`, `restore`: it stopped without a verdict: the user went back
 *   or started something else, or the track failed
 *
 * Besides, a repeat (the track ends and plays again) and the end of the queue complete it, and
 * a restart ("previous" more than 3 s in), a failure or the page going away stop it.
 */
export const PLAY_OUTCOMES: Readonly<Record<TrackChangeCause, Readonly<Outcome>>> = Object.freeze({
  ended: COMPLETED,
  next: SKIPPED,
  jump: SKIPPED,
  removed: SKIPPED,
  previous: STOPPED,
  queue: STOPPED,
  failed: STOPPED,
  restore: STOPPED,
})

/** The parts of the player the recorder listens to. */
export type RecordablePlayer = Pick<Player, 'getState' | 'subscribe' | 'on'>

/** Options for {@link connectPlayRecorder}. */
export interface PlayRecorderOptions {
  /** Saves a finished play. Default: the app's library, loaded on the first save. */
  record?: (play: NewPlay) => Promise<unknown>
  /** The clock, as epoch milliseconds. Default: `Date.now`. */
  now?: () => number
  /**
   * Where to listen for `pagehide`, which saves the play in progress when the page goes away.
   * Default: `window`, when there is one; `null` listens nowhere.
   */
  pageEvents?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
}

/** The play in progress. */
interface Session {
  /** Its queue item, as last seen (a candidate may be recorded on it meanwhile). */
  item: QueueItem
  /** When it started playing. */
  startedAt: number
  /** Where its queue was started from. */
  context: PlayContext | undefined
  /** Listening time so far, in milliseconds. */
  heardMs: number
  /** The clock at the last mark: the last position update, or the last start or stop. */
  markAt: number
  /** The position at the last mark. */
  markPositionMs: number
  /** Whether it was playing at the last mark. */
  playing: boolean
  /** The track's length, as the player last knew it. */
  durationMs: number | undefined
  /** The stream that played last. */
  stream: StreamOption | undefined
}

/** Saves a play in the app's library, which loads lazily, like the rest of the library. */
async function recordInLibrary(play: NewPlay): Promise<void> {
  const { getLibrary } = await import('../../db/repo')
  await getLibrary().recordPlay(play)
}

function sameItem(a: QueueItem | undefined, b: QueueItem): boolean {
  return a !== undefined && a.uid === b.uid && a.track.id === b.track.id
}

/**
 * Records every play of `player` (see the module documentation). Call it once, where the app
 * creates its player. Returns a function that stops recording; a play in progress then goes
 * unrecorded.
 */
export function connectPlayRecorder(
  player: RecordablePlayer,
  options: PlayRecorderOptions = {},
): () => void {
  const now = options.now ?? Date.now
  const record = options.record ?? recordInLibrary
  const pageEvents =
    options.pageEvents === undefined
      ? typeof window === 'undefined'
        ? null
        : window
      : options.pageEvents
  let session: Session | undefined

  /** Ends the play in progress, and saves it if it counts. */
  function finish(outcome: Outcome): void {
    const ended = session
    session = undefined
    if (ended === undefined) return
    if (!outcome.completed && ended.heardMs < MIN_RECORDED_PLAY_MS) return
    const play: NewPlay = {
      track: ended.item.track,
      playedAt: ended.startedAt,
      playedMs: Math.round(ended.heardMs),
      completed: outcome.completed,
      skipped: outcome.skipped,
      stream: playStreamOf(ended.item, ended.stream),
    }
    if (ended.durationMs !== undefined) play.durationMs = ended.durationMs
    if (ended.context !== undefined) play.context = ended.context
    record(play).catch((error: unknown) => console.error('The play could not be saved', error))
    announcePlayEnded(play)
  }

  /** Follows the player's state: starts a play, and counts the time it plays. */
  function observe(state: PlayerState): void {
    const item = currentQueueItem(state.queue)
    const playing = state.status === 'playing'
    const at = now()
    if (session === undefined) {
      if (!playing || item === undefined) return
      session = {
        item,
        startedAt: at,
        context: playContextOf(state.queue.context),
        heardMs: 0,
        markAt: at,
        markPositionMs: state.positionMs,
        playing: true,
        durationMs: state.durationMs,
        stream: state.stream,
      }
      const { context } = session
      announcePlayStarted({
        track: item.track,
        startedAt: at,
        ...(context === undefined ? {} : { context }),
      })
      return
    }
    // Another item is current: the track change that follows ends this play.
    if (item === undefined || !sameItem(item, session.item)) return
    session.item = item
    if (state.durationMs !== undefined) session.durationMs = state.durationMs
    if (state.stream !== undefined) session.stream = state.stream
    const positionMs = state.positionMs
    if (positionMs !== session.markPositionMs) {
      if (session.playing) {
        const elapsedMs = at - session.markAt
        const movedMs = positionMs - session.markPositionMs
        if (elapsedMs > 0 && movedMs > 0) session.heardMs += Math.min(elapsedMs, movedMs)
      }
    } else if (playing === session.playing) {
      return
    }
    session.markAt = at
    session.markPositionMs = positionMs
    session.playing = playing
  }

  const onPageHide = () => finish(STOPPED)
  pageEvents?.addEventListener('pagehide', onPageHide)
  const stops = [
    player.subscribe((state) => observe(state)),
    player.on('trackchange', ({ cause }) => finish(PLAY_OUTCOMES[cause] ?? STOPPED)),
    player.on('seek', ({ cause }) => {
      if (cause === 'repeat') finish(COMPLETED)
      else if (cause === 'restart') finish(STOPPED)
    }),
    player.on('queueend', () => finish(COMPLETED)),
    player.on('trackfailed', ({ item }) => {
      if (session !== undefined && sameItem(item, session.item)) finish(STOPPED)
    }),
  ]
  observe(player.getState())
  return () => {
    session = undefined
    pageEvents?.removeEventListener('pagehide', onPageHide)
    for (const stop of stops) stop()
  }
}
