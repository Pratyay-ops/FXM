/**
 * The web app's player: one `Player` facade from `@fxm/player` for the whole app, created on
 * first use. It
 *
 * - plays through the direct audio engine, two `<audio>` elements, or in the Android app through
 *   the native engine, Media3 in a foreground service (stage 6.3), connected before the saved
 *   queue is restored (see {@link AppPlayback.ready}); when Media3's service turns out to be
 *   unavailable there, the same player plays through the direct audio engine from then on
 *   (`android-engine.ts`);
 * - gets its streams from the playback policy (stage 2.3, see `playback-policy.ts`);
 * - follows the catalog mode setting;
 * - shows the current track in the system media controls (Media Session);
 * - keeps its queue, position and volume across reloads (`features/queue/queue-storage.ts`);
 * - keeps the queue's review list (`features/queue/review-store.ts`) in step with the policy;
 * - records each play as a listening signal (stage 3.1, `features/signals/play-recorder.ts`);
 * - skips the non-music parts of videos when SponsorBlock is on (`features/sponsorblock/`);
 * - keeps the queue going with songs like the last plays when autoplay is on
 *   (stage 3.4, `features/autoplay/`);
 * - applies the audio effects and the sleep timer (stage 8.1, `features/audio-effects/`).
 *
 * Components read it with {@link usePlayerState} and call the player's methods straight from
 * event handlers, so playback starts inside the user's gesture (see the player's README).
 *
 * @module
 */

import { currentQueueItem, type QueueItem } from '@fxm/core'
import {
  connectMediaSession,
  type Engine,
  type NativeConnection,
  NativeEngine,
  type NetworkMonitor,
  Player,
  type PlayerEventMap,
  type PlayerOptions,
  type PlayerState,
} from '@fxm/player'
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import { connectAudioEffects, createAppEngine } from '../audio-effects/connect'
import { connectAutoplay } from '../autoplay/autoplay'
import { autoplayContextOf } from '../autoplay/autoplay-marks'
import {
  loadSavedPlayback,
  type PersistOptions,
  persistPlayback,
  restoredPosition,
} from '../queue/queue-storage'
import { useQueueReviewStore } from '../queue/review-store'
import { useSettingsStore } from '../settings/settings-store'
import { connectPlayRecorder } from '../signals/play-recorder'
import { connectSponsorBlock } from '../sponsorblock/skipping'
import { AndroidEngine } from './android-engine'
import { createAppPolicy, type PlaybackPolicy } from './playback-policy'

/** How the app's playback is put together. Every field has a default; tests pass fakes. */
export interface PlaybackOptions {
  /**
   * Creates the engine. Default: in the Android app the native engine on its `FxmPlayer`
   * plugin, else (or when it can't attach) a `DirectAudioEngine` that knows which streams the
   * equalizer can read (`createAppEngine`). A `NativeEngine` is connected to the player before
   * the saved queue is restored, and gives way to
   * {@link PlaybackOptions.createFallbackEngine}'s engine, in the same player, when its `connect`
   * rejects: Media3's service is unavailable.
   */
  createEngine?: () => Engine
  /**
   * The engine that takes over from an unavailable `NativeEngine`. Default: the app's
   * `DirectAudioEngine` (`createAppEngine`).
   */
  createFallbackEngine?: () => Engine
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
  /**
   * Resolves once the player plays for the app, with the saved queue back. At once with the
   * direct audio engine; in the Android app once the native engine connected: when the page was
   * recreated while Media3 played on, the player has Media3's queue and position then, and the
   * saved one is not restored. Never rejects.
   */
  readonly ready: Promise<void>
  /**
   * In the Android app, the native engine's network: Android's own callbacks, which keep
   * arriving with the screen off, and the WebView's events once the player gave up on Media3.
   * The stream lifecycle follows it (the composition root passes it on); elsewhere `undefined`,
   * and the lifecycle follows the browser's events.
   */
  readonly network: NetworkMonitor | undefined
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

/**
 * The engine the app plays through: the Android app's native engine (Media3), else two
 * `<audio>` elements (`createAppEngine`). `NativeEngine.ifAvailable()` attaches to Media3 in the
 * background, so the player is made at once; `connect` then waits for it.
 */
function defaultEngine(): Engine {
  try {
    const native = NativeEngine.ifAvailable()
    if (native !== undefined) return native
  } catch (error) {
    // Another engine plays on the plugin: a bug, but the app still plays, in the WebView.
    console.error(error)
  }
  return createAppEngine()
}

function createPlayback(options: PlaybackOptions, notify: () => void): Connected {
  const created = options.createEngine?.() ?? defaultEngine()
  // In the Android app: Media3, and the WebView's own audio if Media3's service is unavailable.
  const android =
    created instanceof NativeEngine
      ? new AndroidEngine(created, {
          createFallback: options.createFallbackEngine ?? (() => createAppEngine()),
        })
      : undefined
  const policy = options.policy ?? createAppPolicy()
  const storage = options.storage
  const saved = loadSavedPlayback(storage)
  const player = new Player({
    ...options.player,
    engine: android ?? created,
    // Taking over what Media3 already plays makes no request (the native engine's README).
    resolver: android?.wrapResolver(policy.resolver) ?? policy.resolver,
    queue: { mode: useSettingsStore.getState().catalogMode },
    ...(saved.volume === undefined ? {} : { volume: saved.volume }),
    ...(saved.muted === undefined ? {} : { muted: saved.muted }),
  })
  const restoreSaved = () => {
    if (saved.queue === undefined || !player.restore(saved.queue)) return
    // Nothing plays yet: the seek only puts the restored item where it was.
    const positionMs = restoredPosition(saved, currentQueueItem(player.getState().queue))
    if (positionMs > 0) player.seek(positionMs)
  }
  let disposed = false
  let connection: NativeConnection | undefined
  let stopMediaSession: (() => void) | undefined
  let ready: Promise<void>
  if (android === undefined) {
    restoreSaved()
    ready = Promise.resolve()
  } else {
    // Connect first: when the page was recreated while Media3 played on (its renderer died),
    // connect picks up Media3's queue, and the saved one must not replace it. A queue the user
    // started meanwhile stays too.
    ready = android
      .connect({ player, resolver: policy.resolver })
      .then(
        (connected) => {
          if (disposed) {
            connected.disconnect()
            return
          }
          connection = connected
          if (!connected.resumed && player.getState().queue.items.length === 0) restoreSaved()
        },
        (error: unknown) => {
          if (disposed) return
          // Media3's service could not be bound: the same player plays in the WebView from now
          // on (the engine fell back), with the WebView's Media Session for the system controls.
          console.error('FXM: the native player is unavailable; playing in the WebView', error)
          if (options.mediaSession !== false) stopMediaSession = connectMediaSession(player)
          if (player.getState().queue.items.length === 0) restoreSaved()
        },
      )
      .catch((error: unknown) => console.error(error))
  }
  const disconnects = [
    // First: applying the effects updates the state, which must not notify before the
    // playback exists (a listener that reads the player would create a second one).
    connectAudioEffects(player),
    player.subscribe(notify),
    // Media3's own session drives the notification and the lock screen in the Android app.
    options.mediaSession === false || android !== undefined
      ? () => {}
      : connectMediaSession(player),
    options.recordPlays === false
      ? () => {}
      : connectPlayRecorder(player, { contextOf: autoplayContextOf }),
    persistPlayback(player, storage, options.persist),
    connectReview(player, policy),
    useSettingsStore.subscribe((state, previous) => {
      if (state.catalogMode === previous.catalogMode) return
      // Matches depend on the mode, so the review list starts over.
      useQueueReviewStore.getState().clear()
      player.setCatalogMode(state.catalogMode)
    }),
    connectSponsorBlock(player),
    connectAutoplay(player),
    () => connection?.disconnect(),
    () => stopMediaSession?.(),
  ]
  return {
    player,
    policy,
    ready,
    network: android?.network,
    dispose() {
      disposed = true
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
