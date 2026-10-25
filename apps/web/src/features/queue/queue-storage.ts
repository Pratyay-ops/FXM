/**
 * Saves the queue in Web Storage and puts it back after a reload, paused where it was.
 *
 * Two keys, so that the position, which changes every second, never rewrites the queue:
 *
 * - {@link QUEUE_STORAGE_KEY}: the `QueueState` as JSON, written shortly after each change.
 * - {@link PLAYBACK_STORAGE_KEY}: the position, volume and mute, written every few seconds while
 *   playing, on every pause and track change, and when the page is hidden.
 *
 * What comes back is untrusted: the player's `restore` runs the queue through `restoreQueue`,
 * and the numbers are checked here. Storage that is missing, blocked or full is ignored.
 *
 * @module
 */

import type { Player, PlayerState } from '@fxm/player'

/** localStorage key of the saved queue. Bump the suffix on incompatible changes. */
export const QUEUE_STORAGE_KEY = 'fxm.queue.v1'

/** localStorage key of the saved position, volume and mute. */
export const PLAYBACK_STORAGE_KEY = 'fxm.playback.v1'

/** What {@link loadSavedPlayback} found. */
export interface SavedPlayback {
  /** The saved queue: untrusted JSON for `player.restore`. Absent when nothing was saved. */
  queue?: unknown
  /** Where the current track was, in milliseconds. */
  positionMs: number
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

function write(getStorage: GetStorage, key: string, value: unknown): void {
  try {
    getStorage()?.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked or full: the queue just isn't saved.
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
 * What was saved: the queue (absent when none was), and the position, volume and mute, each
 * checked. A missing or malformed position is 0; a malformed volume or mute is left out.
 */
export function loadSavedPlayback(getStorage: GetStorage = defaultStorage): SavedPlayback {
  const queue = read(getStorage, QUEUE_STORAGE_KEY)
  const raw = read(getStorage, PLAYBACK_STORAGE_KEY)
  const saved = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const { positionMs, volume, muted } = saved
  return {
    ...(queue === undefined ? {} : { queue }),
    positionMs: isFiniteNumber(positionMs) && positionMs > 0 ? positionMs : 0,
    ...(isFiniteNumber(volume) && volume >= 0 && volume <= 1 ? { volume } : {}),
    ...(typeof muted === 'boolean' ? { muted } : {}),
  }
}

function positionOf(state: PlayerState): { positionMs: number; volume: number; muted: boolean } {
  // After the end of the queue, a reload starts the last track over.
  const positionMs = state.status === 'ended' ? 0 : Math.round(state.positionMs)
  return { positionMs, volume: state.volume, muted: state.muted }
}

/**
 * Keeps the player's queue, position, volume and mute saved until the returned function is
 * called, which drops a write that is still waiting (the page itself saves on `pagehide`). An
 * empty queue removes the saved one.
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
    else write(getStorage, QUEUE_STORAGE_KEY, queue)
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
