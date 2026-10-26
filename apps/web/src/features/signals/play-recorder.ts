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
 *   that ended from one the user skipped, went back from, replaced or that failed. A track that
 *   reaches its end counts as completed only when at least half of it was heard; else it was
 *   skipped when the user sought towards the end, and stopped without a verdict when the stream
 *   simply ended early;
 * - **the context** the queue was started from and **the stream** that played;
 * - the track's length, as the player knew it.
 *
 * A play shorter than {@link MIN_RECORDED_PLAY_MS} that did not complete is not recorded: that
 * is someone skipping through the queue, not listening.
 *
 * **Nothing is lost when the page dies.** A page can be killed in the background without
 * `pagehide` (mobile browsers, the Android app), and a save started during `pagehide` may never
 * finish. So the recorder keeps a checkpoint of the play in progress, and of finished plays
 * until they are saved, in `localStorage`: every {@link CHECKPOINT_INTERVAL_MS} of listening,
 * whenever the page is hidden, and whenever a play ends. The next page records what a page that
 * went away left behind, as plays without a verdict; recording the same play again is safe,
 * because the library keeps one record per track and start (the fuller one).
 *
 * Likes and playlist adds need no wiring: the library records them as it saves them.
 *
 * It also announces each play as it starts, and each play it records as it ends, to the
 * listeners of `play-events.ts`, such as scrobbling. The plays a page that went away left behind
 * are only recorded: that page announced the ones it finished.
 *
 * @module
 */

import {
  COMPLETED_PLAY_SHARE,
  currentQueueItem,
  playStreamOf,
  type QueueContext,
  type QueueItem,
  type StreamOption,
} from '@fxm/core'
import type { Player, PlayerState, TrackChangeCause } from '@fxm/player'
import type { NewPlay } from '../../db/repo'
import { announcePlayEnded, announcePlayStarted } from './play-events'

/** Shorter plays that did not complete are not recorded: quick skips, not listens. */
export const MIN_RECORDED_PLAY_MS = 1000

/** How much listening time passes between two checkpoints of the play in progress. */
export const CHECKPOINT_INTERVAL_MS = 30_000

/** The `localStorage` keys of unsaved plays: one per page, `<prefix><page ID>`. */
export const UNSAVED_PLAYS_PREFIX = 'fxm.plays.unsaved.'

/**
 * How long a page's unsaved plays may go without an update before another page counts the page
 * as gone and records them. A paused page updates nothing, so it may still be open; if it is,
 * the record it saves later replaces the one recorded for it.
 */
export const ABANDONED_AFTER_MS = 10 * 60 * 1000

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
 * Besides, a repeat (the track ends and plays again) and the end of the queue reach the end, and
 * a restart ("previous" more than 3 s in), a failure or the page going away stop it. A play
 * that reaches the end with less than half of it heard is no full listen: see the module
 * documentation.
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

/** The parts of Web Storage the recorder keeps unsaved plays in. */
export type PlayStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

/** Options for {@link connectPlayRecorder}. */
export interface PlayRecorderOptions {
  /** Saves a finished play. Default: the app's library, which starts loading at once. */
  record?: (play: NewPlay) => Promise<unknown>
  /** The clock, as epoch milliseconds. Default: `Date.now`. */
  now?: () => number
  /**
   * Where to listen for `pagehide`, which saves the play in progress when the page goes away,
   * and `visibilitychange`, which checkpoints it when the page is hidden. Default: `window` and
   * `document`, when there are; `null` listens nowhere.
   */
  pageEvents?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  /** Whether the page is hidden now. Default: `document.visibilityState`. */
  isHidden?: () => boolean
  /** Where checkpoints are kept. Default: `localStorage`, when usable; `null` keeps none. */
  storage?: PlayStorage | null
  /** This page's ID among the pages that keep checkpoints. Default: a random one. */
  pageId?: string
}

/** The play in progress. */
interface Session {
  /** Its queue item, as last seen (a candidate may be recorded on it meanwhile). */
  item: QueueItem
  /** When it started playing. */
  startedAt: number
  /** Where its queue was started from: the queue's context, as the library stores it. */
  context: QueueContext | undefined
  /** Listening time so far, in milliseconds. */
  heardMs: number
  /** The listening time at the last checkpoint. */
  checkpointMs: number
  /** The clock at the last mark: the last position update, or the last start or stop. */
  markAt: number
  /** The position at the last mark. */
  markPositionMs: number
  /** Whether it was playing at the last mark. */
  playing: boolean
  /** Whether the user moved the position, which is how a play reaches the end unheard. */
  sought: boolean
  /** The track's length, as the player last knew it. */
  durationMs: number | undefined
  /** The stream that played last. */
  stream: StreamOption | undefined
}

/** What a page keeps in `localStorage`. */
interface UnsavedPlays {
  /** When it last wrote them. */
  savedAt: number
  /** Finished plays not saved yet, and a snapshot of the play in progress. */
  plays: NewPlay[]
}

/** Saves a play in the app's library, which loads lazily, like the rest of the library. */
async function recordInLibrary(play: NewPlay): Promise<void> {
  const { getLibrary } = await import('../../db/repo')
  await getLibrary().recordPlay(play)
}

/**
 * Loads the library now, while the page is alive: a page that is going away may not get to
 * fetch the library's code or open its database.
 */
function preloadLibrary(): void {
  import('../../db/repo').then(({ getLibrary }) => getLibrary()).catch(() => {})
}

function browserStorage(): PlayStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // Storage blocked, e.g. site data disabled.
    return null
  }
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function randomPageId(): string {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

function sameItem(a: QueueItem | undefined, b: QueueItem): boolean {
  return a !== undefined && a.uid === b.uid && a.track.id === b.track.id
}

/** How a play that reached the end ended: see the module documentation. */
function endOutcome(session: Session): Outcome {
  const { heardMs, durationMs, sought } = session
  const enough =
    durationMs !== undefined && durationMs > 0
      ? heardMs >= durationMs * COMPLETED_PLAY_SHARE
      : heardMs >= MIN_RECORDED_PLAY_MS
  if (enough) return COMPLETED
  return sought ? SKIPPED : STOPPED
}

/** The play a session makes with `outcome`, or `undefined` when it is too short to count. */
function playOf(session: Session, outcome: Outcome, now: number): NewPlay | undefined {
  if (!outcome.completed && session.heardMs < MIN_RECORDED_PLAY_MS) return undefined
  const play: NewPlay = {
    track: session.item.track,
    playedAt: Math.min(session.startedAt, now),
    playedMs: Math.round(session.heardMs),
    completed: outcome.completed,
    skipped: outcome.skipped,
    stream: playStreamOf(session.item, session.stream),
  }
  if (session.durationMs !== undefined) play.durationMs = session.durationMs
  if (session.context !== undefined) play.context = session.context
  return play
}

/** The keys of every page's unsaved plays. */
function unsavedKeys(storage: PlayStorage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(UNSAVED_PLAYS_PREFIX)) keys.push(key)
  }
  return keys
}

/** A page's unsaved plays as stored, or `undefined` when they are unreadable. */
function readUnsaved(storage: PlayStorage, key: string): UnsavedPlays | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    if (typeof value !== 'object' || value === null) return undefined
    const { savedAt, plays } = value as Partial<UnsavedPlays>
    if (typeof savedAt !== 'number' || !Array.isArray(plays)) return undefined
    return { savedAt, plays }
  } catch {
    return undefined
  }
}

/** Plays read back from storage, checked like any data from outside the app. */
async function restorePlays(values: readonly unknown[]): Promise<NewPlay[]> {
  if (values.length === 0) return []
  const { sanitizeHistoryRecord, sanitizeTrack } = await import('../../db/validate')
  return values.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return []
    const raw = value as Record<string, unknown>
    const track = sanitizeTrack(raw.track)
    const entry = track === null ? null : sanitizeHistoryRecord({ ...raw, trackId: track.id })
    if (track === null || entry === null) return []
    const { trackId: _trackId, id: _id, ...play } = entry
    return [{ ...play, track }]
  })
}

/**
 * Records every play of `player` (see the module documentation). Call it once, where the app
 * creates its player: it also records what pages that went away left unsaved. Returns a function
 * that stops recording; a play in progress then goes unrecorded.
 */
export function connectPlayRecorder(
  player: RecordablePlayer,
  options: PlayRecorderOptions = {},
): () => void {
  const now = options.now ?? Date.now
  const record = options.record ?? recordInLibrary
  if (options.record === undefined) preloadLibrary()
  const pageEvents =
    options.pageEvents === undefined
      ? typeof window === 'undefined'
        ? null
        : window
      : options.pageEvents
  const visibilityEvents =
    options.pageEvents === undefined
      ? typeof document === 'undefined'
        ? null
        : document
      : options.pageEvents
  const isHidden = options.isHidden ?? documentHidden
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const pageKey = `${UNSAVED_PLAYS_PREFIX}${options.pageId ?? randomPageId()}`
  const unsaved = new Map<number, NewPlay>()
  let nextUnsaved = 0
  let session: Session | undefined

  /** Writes this page's unsaved plays and a snapshot of the play in progress, if any. */
  function checkpoint(): void {
    if (session !== undefined) session.checkpointMs = session.heardMs
    if (storage === null) return
    const plays = [...unsaved.values()]
    const snapshot = session === undefined ? undefined : playOf(session, STOPPED, now())
    if (snapshot !== undefined) plays.push(snapshot)
    try {
      if (plays.length === 0) storage.removeItem(pageKey)
      else storage.setItem(pageKey, JSON.stringify({ savedAt: now(), plays }))
    } catch {
      // Storage full or blocked: the play is still saved when it ends.
    }
  }

  /** Saves a finished play, keeping it in the checkpoint until it is saved. */
  function save(play: NewPlay): void {
    const id = nextUnsaved++
    unsaved.set(id, play)
    checkpoint()
    record(play)
      .catch((error: unknown) => console.error('The play could not be saved', error))
      .finally(() => {
        unsaved.delete(id)
        checkpoint()
      })
  }

  /** Ends the play in progress, and saves it if it counts. */
  function finish(outcome: Outcome): void {
    const ended = session
    session = undefined
    if (ended === undefined) return
    const play = playOf(ended, outcome.completed ? endOutcome(ended) : outcome, now())
    if (play === undefined) {
      checkpoint()
      return
    }
    save(play)
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
        context: state.queue.context,
        heardMs: 0,
        checkpointMs: 0,
        markAt: at,
        markPositionMs: state.positionMs,
        playing: true,
        sought: false,
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
    if (session.heardMs - session.checkpointMs >= CHECKPOINT_INTERVAL_MS) checkpoint()
  }

  /** Records the plays that pages which went away left unsaved. */
  async function recover(): Promise<void> {
    if (storage === null) return
    for (const key of unsavedKeys(storage)) {
      if (key === pageKey) continue
      const left = readUnsaved(storage, key)
      if (left !== undefined && now() - left.savedAt < ABANDONED_AFTER_MS) continue
      try {
        storage.removeItem(key)
      } catch {
        // Blocked storage: whoever reads it next tries again, and records nothing twice.
      }
      for (const play of await restorePlays(left?.plays ?? [])) {
        await record(play).catch((error: unknown) => {
          console.error('A play a closed page left unsaved could not be saved', error)
        })
      }
    }
  }

  const onPageHide = () => finish(STOPPED)
  const onVisibilityChange = () => {
    if (isHidden()) checkpoint()
  }
  pageEvents?.addEventListener('pagehide', onPageHide)
  visibilityEvents?.addEventListener('visibilitychange', onVisibilityChange)
  const stops = [
    player.subscribe((state) => observe(state)),
    player.on('trackchange', ({ cause }) => finish(PLAY_OUTCOMES[cause] ?? STOPPED)),
    player.on('seek', ({ cause }) => {
      if (cause === 'repeat') finish(COMPLETED)
      else if (cause === 'restart') finish(STOPPED)
      else if (session !== undefined) session.sought = true
    }),
    player.on('queueend', () => finish(COMPLETED)),
    player.on('trackfailed', ({ item }) => {
      if (session !== undefined && sameItem(item, session.item)) finish(STOPPED)
    }),
  ]
  observe(player.getState())
  recover().catch((error: unknown) => console.error('Unsaved plays could not be read', error))
  return () => {
    session = undefined
    checkpoint()
    pageEvents?.removeEventListener('pagehide', onPageHide)
    visibilityEvents?.removeEventListener('visibilitychange', onVisibilityChange)
    for (const stop of stops) stop()
  }
}
