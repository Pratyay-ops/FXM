/**
 * The web app's player: one `Player` facade from `@fxm/player` for the whole app, created on
 * first use. It
 *
 * - plays through the direct audio engine, two `<audio>` elements;
 * - gets its streams from the playback policy (stage 2.3, see `playback-policy.ts`);
 * - follows the catalog mode setting;
 * - shows the current track in the system media controls (Media Session);
 * - keeps its queue, position and volume across reloads (`features/queue/queue-storage.ts`);
 * - keeps the queue's review list (`features/queue/review-store.ts`) in step with the policy;
 * - records each play as a listening signal (stage 3.1, `features/signals/play-recorder.ts`).
 *
 * Components read it with {@link usePlayerState} and call the player's methods straight from
 * event handlers, so playback starts inside the user's gesture (see the player's README).
 *
 * @module
 */

import { currentQueueItem, type QueueItem } from '@fxm/core'
import {
  connectMediaSession,
  DirectAudioEngine,
  type Engine,
  Player,
  type PlayerEventMap,
  type PlayerOptions,
  type PlayerState,
} from '@fxm/player'
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import {
  loadSavedPlayback,
  type PersistOptions,
  persistPlayback,
  restoredPosition,
} from '../queue/queue-storage'
import { useQueueReviewStore } from '../queue/review-store'
import { useSettingsStore } from '../settings/settings-store'
import { connectPlayRecorder } from '../signals/play-recorder'
import { createAppPolicy, type PlaybackPolicy } from './playback-policy'

/** How the app's playback is put together. Every field has a default; tests pass fakes. */
export interface PlaybackOptions {
  /** Creates the engine. Default: a `DirectAudioEngine`. */
  createEngine?: () => Engine
  /** The playback policy. Default: {@link createAppPolicy}. */
  policy?: PlaybackPolicy
  /** Where the queue is saved. Default: `localStorage`. */
  storage?: () => Storage | undefined
  /** Timings of the queue's saving. */
  persist?: PersistOptions
  /** Whether to connect the system media controls. Default: true. */
  mediaSession?: boolean
  /** Whether to record each play in the library's listening history. Default: true. */
  recordPlays?: boolean
  /** Tuning passed on to the player, e.g. shorter retry delays in tests. */
  player?: Omit<PlayerOptions, 'engine' | 'resolver' | 'queue' | 'volume' | 'muted'>
}

/** The app's player and the policy it plays with. */
export interface AppPlayback {
  readonly player: Player
  readonly policy: PlaybackPolicy
}

interface Connected extends AppPlayback {
  /** Disconnects everything and destroys the player. */
  dispose(): void
}

/** The track IDs in the player's queue. */
function queuedTrackIds(player: Player): Set<string> {
  return new Set(player.getState().queue.items.map((item) => item.track.id))
}

/** Keeps the review list in step with the policy and the queue. */
function connectReview(player: Player, policy: PlaybackPolicy): () => void {
  const review = useQueueReviewStore
  review.getState().keepOnly(queuedTrackIds(player))
  policy.setPlayBestGuesses(review.getState().playBestGuesses)
  const stopReports = policy.onNeedsReview((track, bestGuess) => {
    // A report about a track that has left the queue meanwhile is stale.
    if (queuedTrackIds(player).has(track.id)) review.getState().report(track, bestGuess)
  })
  const stopSetting = review.subscribe((state, previous) => {
    if (state.playBestGuesses !== previous.playBestGuesses) {
      policy.setPlayBestGuesses(state.playBestGuesses)
    }
  })
  const stopQueue = player.subscribe((state, previous) => {
    if (state.queue.items !== previous.queue.items)
      review.getState().keepOnly(queuedTrackIds(player))
  })
  return () => {
    stopReports()
    stopSetting()
    stopQueue()
  }
}

function createPlayback(options: PlaybackOptions, notify: () => void): Connected {
  const policy = options.policy ?? createAppPolicy()
  const storage = options.storage
  const saved = loadSavedPlayback(storage)
  const player = new Player({
    ...options.player,
    engine: options.createEngine?.() ?? new DirectAudioEngine(),
    resolver: policy.resolver,
    queue: { mode: useSettingsStore.getState().catalogMode },
    ...(saved.volume === undefined ? {} : { volume: saved.volume }),
    ...(saved.muted === undefined ? {} : { muted: saved.muted }),
  })
  if (saved.queue !== undefined && player.restore(saved.queue)) {
    // Nothing listens yet: the seek only puts the restored item where it was.
    const positionMs = restoredPosition(saved, currentQueueItem(player.getState().queue))
    if (positionMs > 0) player.seek(positionMs)
  }
  const disconnects = [
    player.subscribe(notify),
    options.mediaSession === false ? () => {} : connectMediaSession(player),
    options.recordPlays === false ? () => {} : connectPlayRecorder(player),
    persistPlayback(player, storage, options.persist),
    connectReview(player, policy),
    useSettingsStore.subscribe((state, previous) => {
      if (state.catalogMode === previous.catalogMode) return
      // Matches depend on the mode, so the review list starts over.
      useQueueReviewStore.getState().clear()
      player.setCatalogMode(state.catalogMode)
    }),
  ]
  return {
    player,
    policy,
    dispose() {
      for (const disconnect of disconnects) disconnect()
      player.destroy()
    },
  }
}

let options: PlaybackOptions = {}
let current: Connected | undefined
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** The app's playback, created on first use. */
export function getPlayback(): AppPlayback {
  current ??= createPlayback(options, notify)
  return current
}

/** The app's player. */
export function getPlayer(): Player {
  return getPlayback().player
}

/**
 * Calls `listener` whenever the player's state changes, or the player is replaced (tests).
 * Returns a function that stops it.
 */
export function subscribePlayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Replaces the app's playback with one built from `next`, e.g. with a fake engine and policy in
 * tests. The old player is destroyed. Returns the new playback.
 */
export function configurePlayback(next: PlaybackOptions): AppPlayback {
  current?.dispose()
  current = undefined
  options = next
  const playback = getPlayback()
  notify()
  return playback
}

/**
 * Destroys the app's playback and goes back to the default options: the next use creates a
 * default playback from what storage holds then. For tests, after clearing storage.
 */
export function resetPlayback(): void {
  current?.dispose()
  current = undefined
  options = {}
  notify()
}

/**
 * Selects a value from the player's state and re-renders when it changes. The selector must
 * return a value from the state or a primitive, not a new object or array on every call.
 */
export function usePlayerState<T>(selector: (state: PlayerState) => T): T {
  const read = () => selector(getPlayer().getState())
  return useSyncExternalStore(subscribePlayer, read, read)
}

/** The app's player, for event handlers. Re-renders only when the player is replaced. */
export function usePlayer(): Player {
  return useSyncExternalStore(subscribePlayer, getPlayer, getPlayer)
}

function currentItemOf(state: PlayerState): QueueItem | undefined {
  return currentQueueItem(state.queue)
}

/** The queue item playing or selected, or `undefined` when the queue is empty. */
export function useCurrentItem(): QueueItem | undefined {
  return usePlayerState(currentItemOf)
}

/** Calls `handler` on every `type` event of the app's player while the component is mounted. */
export function usePlayerEvent<K extends keyof PlayerEventMap>(
  type: K,
  handler: (payload: PlayerEventMap[K]) => void,
): void {
  const player = usePlayer()
  const onEvent = useEffectEvent(handler)
  useEffect(() => player.on(type, (payload) => onEvent(payload)), [player, type])
}
