/**
 * Saves the queue in Web Storage and puts it back after a reload, paused where it was.
 *
 * Two keys, so that the position, which changes every second, never rewrites the queue:
 *
 * - {@link QUEUE_STORAGE_KEY}: the `QueueState` as JSON, written shortly after each change. A
 *   long queue is saved as a window of {@link MAX_SAVED_ITEMS} around the current item.
 * - {@link PLAYBACK_STORAGE_KEY}: the position (with the uid of the item it belongs to), volume
 *   and mute, written every few seconds while playing, on every pause and track change, and
 *   when the page is hidden.
 *
 * What comes back is untrusted: the player's `restore` runs the queue through `restoreQueue`,
 * and the numbers are checked here. Storage that is missing or blocked is ignored. When storage
 * is full, the saved queue is removed rather than left behind, so a reload never puts back an
 * older queue.
 *
 * @module
 */

import type { QueueItem, QueueState } from '@fxm/core'
import type { Player, PlayerState } from '@fxm/player'

/** localStorage key of the saved queue. Bump the suffix on incompatible changes. */
export const QUEUE_STORAGE_KEY = 'fxm.queue.v1'

/** localStorage key of the saved position, volume and mute. */
export const PLAYBACK_STORAGE_KEY = 'fxm.playback.v1'

/**
 * The most queue items saved. A longer queue (say, "play all" on thousands of liked songs) is
 * saved as a window around the current item, so writing it stays quick and inside the storage
 * quota (about 5 MB per site; an item takes about 1 KB).
 */
export const MAX_SAVED_ITEMS = 1000

/** How many of the saved items may come before the current one, for "previous". */
const SAVED_BEFORE = 100

/** What {@link loadSavedPlayback} found. */
export interface SavedPlayback {
  /** The saved queue: untrusted JSON for `player.restore`. Absent when nothing was saved. */
  queue?: unknown
  /** Where the current track was, in milliseconds. */
  positionMs: number
  /** The uid of the item the position belongs to, when saved. */
  uid?: number
  /** The volume, from 0 to 1, when saved. */
  volume?: number
  /** Whether the output was muted, when saved. */
  muted?: boolean
}

/** Timings of {@link persistPlayback}. */
export interface PersistOptions {
  /** Wait this long after a queue change before writing it, so a drag writes once. */
  queueDelayMs?: number
  /** Write the position at most this often while playing. */
  positionIntervalMs?: number
}

type GetStorage = () => Storage | undefined

const defaultStorage: GetStorage = () => globalThis.localStorage

function read(getStorage: GetStorage, key: string): unknown {
  try {
    const raw = getStorage()?.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : undefined
  } catch {
    return undefined
  }
}

/** Writes `value` as JSON. Returns false when storage refused it (blocked, or full). */
function write(getStorage: GetStorage, key: string, value: unknown): boolean {
  try {
    getStorage()?.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function remove(getStorage: GetStorage, key: string): void {
  try {
    getStorage()?.removeItem(key)
  } catch {
    // Storage blocked: nothing to remove.
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * What was saved: the queue (absent when none was), and the position with its item's uid, the
 * volume and mute, each checked. A missing or malformed position is 0; a malformed uid, volume
 * or mute is left out.
 */
export function loadSavedPlayback(getStorage: GetStorage = defaultStorage): SavedPlayback {
  const queue = read(getStorage, QUEUE_STORAGE_KEY)
  const raw = read(getStorage, PLAYBACK_STORAGE_KEY)
  const saved = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const { positionMs, uid, volume, muted } = saved
  return {
    ...(queue === undefined ? {} : { queue }),
    positionMs: isFiniteNumber(positionMs) && positionMs > 0 ? positionMs : 0,
    ...(Number.isSafeInteger(uid) && (uid as number) >= 0 ? { uid: uid as number } : {}),
    ...(isFiniteNumber(volume) && volume >= 0 && volume <= 1 ? { volume } : {}),
    ...(typeof muted === 'boolean' ? { muted } : {}),
  }
}

/**
 * Where to put back `item`, the current item of the restored queue: the saved position when it
 * was saved for that item, kept inside its length; otherwise its start. (The position is written
 * more often than the queue, so after a crash it can belong to another item.)
 */
export function restoredPosition(saved: SavedPlayback, item: QueueItem | undefined): number {
  if (item === undefined || saved.uid !== item.uid) return 0
  const durationMs = item.candidate?.durationMs ?? item.track.durationMs
  return durationMs === undefined ? saved.positionMs : Math.min(saved.positionMs, durationMs)
}

/**
 * The part of `queue` to save: all of it, or for a queue longer than {@link MAX_SAVED_ITEMS} a
 * window of that many items, starting a little before the current one. `restoreQueue` reads
 * either the same way.
 */
export function queueToSave(queue: QueueState): QueueState {
  const { items } = queue
  if (items.length <= MAX_SAVED_ITEMS) return queue
  const current = Math.max(0, queue.index)
  const start = Math.max(0, Math.min(current - SAVED_BEFORE, items.length - MAX_SAVED_ITEMS))
  const kept = items.slice(start, start + MAX_SAVED_ITEMS)
  const uids = new Set(kept.map((item) => item.uid))
  const { unshuffled } = queue
  return {
    ...queue,
    items: kept,
    index: queue.index < 0 ? -1 : queue.index - start,
    playedUids: queue.playedUids.filter((uid) => uids.has(uid)),
    ...(unshuffled === undefined ? {} : { unshuffled: unshuffled.filter((uid) => uids.has(uid)) }),
  }
}

function positionOf(state: PlayerState): {
  positionMs: number
  uid?: number
  volume: number
  muted: boolean
} {
  const { queue } = state
  const uid = queue.items[queue.index]?.uid
  // After the end of the queue, a reload starts the last track over.
  const positionMs = state.status === 'ended' ? 0 : Math.round(state.positionMs)
  return {
    positionMs,
    ...(uid === undefined ? {} : { uid }),
    volume: state.volume,
    muted: state.muted,
  }
}

/**
 * Keeps the player's queue, position, volume and mute saved until the returned function is
 * called, which drops a write that is still waiting (the page itself saves on `pagehide`). An
 * empty queue removes the saved one, and so does a queue that storage refuses.
 */
export function persistPlayback(
  player: Player,
  getStorage: GetStorage = defaultStorage,
  { queueDelayMs = 500, positionIntervalMs = 5000 }: PersistOptions = {},
): () => void {
  let queueTimer: ReturnType<typeof setTimeout> | undefined
  let lastPositionWrite = Number.NEGATIVE_INFINITY

  const writeQueue = () => {
    if (queueTimer !== undefined) clearTimeout(queueTimer)
    queueTimer = undefined
    const { queue } = player.getState()
    if (queue.items.length === 0) remove(getStorage, QUEUE_STORAGE_KEY)
    // Full storage: an older queue left behind would come back after a reload. None is better.
    else if (!write(getStorage, QUEUE_STORAGE_KEY, queueToSave(queue))) {
      remove(getStorage, QUEUE_STORAGE_KEY)
    }
  }

  const writePosition = () => {
    lastPositionWrite = Date.now()
    write(getStorage, PLAYBACK_STORAGE_KEY, positionOf(player.getState()))
  }

  const flush = () => {
    if (queueTimer !== undefined) writeQueue()
    writePosition()
  }

  const unsubscribe = player.subscribe((state, previous) => {
    if (state.queue !== previous.queue) {
      if (queueTimer !== undefined) clearTimeout(queueTimer)
      queueTimer = setTimeout(writeQueue, queueDelayMs)
    }
    const settled =
      state.status !== previous.status ||
      state.volume !== previous.volume ||
      state.muted !== previous.muted ||
      // A seek or a new track: positions jump rather than creep.
      Math.abs(state.positionMs - previous.positionMs) > 2000
    if (settled || Date.now() - lastPositionWrite >= positionIntervalMs) writePosition()
  })

  const onHide = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', onHide)

  return () => {
    unsubscribe()
    window.removeEventListener('pagehide', flush)
    document.removeEventListener('visibilitychange', onHide)
    if (queueTimer !== undefined) clearTimeout(queueTimer)
  }
}
