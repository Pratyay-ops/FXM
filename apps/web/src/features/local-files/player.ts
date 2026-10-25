/**
 * How local files play: through the player core (`@fxm/player`, stage 2.2), from object URLs.
 *
 * - {@link withLocalFiles} wraps any `StreamResolver`: queue items that are local tracks (or
 *   whose recorded audio is a local file) resolve to their file's object URL, everything else
 *   goes to the wrapped resolver.
 * - {@link getLocalPlayer} is the `Player` the local-files UI plays through.
 *
 * **Until stage 2.5 wires the app's player** (`features/now-playing/playback.ts`, not merged
 * when this was written), the feature makes its own: a direct-audio engine, the local resolver
 * and the system media controls. 2.5 has merged since; wiring it in replaces two things and
 * nothing else in this feature changes:
 *
 * 1. `getLocalPlayer()` returns 2.5's `getPlayer()`, and `subscribeLocalPlayer` its
 *    `subscribePlayer`;
 * 2. 2.5's `createAppPolicy()` wraps its resolver: `resolver: withLocalFiles(policy.resolver)`
 *    (or, with 2.3's policy, registers `createLocalAudioSource()` as the offline copy).
 *
 * @module
 */

import {
  createQueue,
  currentQueueItem,
  FxmError,
  isFxmError,
  type QueueItem,
  type StreamOption,
  tierOf,
} from '@fxm/core'
import {
  connectMediaSession,
  DirectAudioEngine,
  type Engine,
  mimeTypeOf,
  Player,
  type PlayerEventMap,
  type PlayerOptions,
  type PlayerState,
  type PlaySupport,
  type StreamResolver,
} from '@fxm/player'
import { useSyncExternalStore } from 'react'
import { useSettingsStore } from '../settings/settings-store'
import { localNativeIdOf } from './audio-source'
import { formatName } from './format'
import { getLocalFiles, type LocalFiles } from './local-files'

/** The local file a queue item plays, as a native ID, or `undefined` when it plays no file. */
export function localFileOf(item: QueueItem): string | undefined {
  const { candidate } = item
  if (candidate !== undefined) return candidate.source === 'local' ? candidate.ref : undefined
  return localNativeIdOf(item.track)
}

/**
 * `fallback`, plus local files: an item whose track is a local track (or whose recorded audio
 * is a local file) resolves to its file's object URL. A format the engine says it can't play
 * (`canPlay` answers `no`, e.g. ALAC outside Safari) is refused as `Unavailable`, so the player
 * skips it at once instead of retrying.
 */
export function withLocalFiles(
  fallback: StreamResolver,
  files: () => LocalFiles = getLocalFiles,
): StreamResolver {
  return {
    async resolve(item, request) {
      const nativeId = localFileOf(item)
      if (nativeId === undefined) return fallback.resolve(item, request)
      const stream = await files().streamFor(nativeId)
      if (request.canPlay(stream) === 'no') {
        throw new FxmError('Unavailable', `This browser can’t play ${formatName(stream)} files`)
      }
      return { stream }
    },
  }
}

/** The resolver for everything that isn't a local file, until stage 2.3's policy is wired in. */
export const NO_STREAMS: StreamResolver = {
  resolve: () =>
    Promise.reject(new FxmError('Unsupported', 'Only local files can play here for now')),
}

/** How the local-files player is put together. Tests pass a fake engine. */
export interface LocalPlayerOptions {
  /** Default: a `DirectAudioEngine`. */
  engine?: Engine
  /** Whether to show the playing track in the system media controls. Default: true. */
  mediaSession?: boolean
  /** Default: the app's local files. */
  files?: () => LocalFiles
  /** Tuning passed on to the player, e.g. shorter retry delays in tests. */
  player?: Omit<PlayerOptions, 'engine' | 'resolver' | 'queue'>
}

interface Playback {
  player: Player
  dispose(): void
}

let options: LocalPlayerOptions = {}
let current: Playback | undefined
const listeners = new Set<() => void>()
const failureListeners = new Set<(failure: PlayerEventMap['trackfailed']) => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Calls `listener` whenever the player gives up on a track, whichever player is current, also
 * one created later. Returns a function that stops it.
 */
export function onTrackFailed(
  listener: (failure: PlayerEventMap['trackfailed']) => void,
): () => void {
  failureListeners.add(listener)
  return () => {
    failureListeners.delete(listener)
  }
}

function createPlayback(config: LocalPlayerOptions): Playback {
  const player = new Player({
    ...config.player,
    engine: config.engine ?? new DirectAudioEngine(),
    resolver: withLocalFiles(NO_STREAMS, config.files),
    queue: { mode: useSettingsStore.getState().catalogMode },
  })
  const disconnects = [
    player.subscribe(notify),
    player.on('trackfailed', (failure) => {
      for (const listener of [...failureListeners]) listener(failure)
    }),
    config.mediaSession === false ? () => {} : connectMediaSession(player),
    useSettingsStore.subscribe((state, previous) => {
      if (state.catalogMode !== previous.catalogMode) player.setCatalogMode(state.catalogMode)
    }),
  ]
  return {
    player,
    dispose() {
      for (const disconnect of disconnects) disconnect()
      player.destroy()
    },
  }
}

/** The player local files play through, created on first use (see the module documentation). */
export function getLocalPlayer(): Player {
  current ??= createPlayback(options)
  return current.player
}

/** Calls `listener` when the player's state changes or the player is replaced. */
export function subscribeLocalPlayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tests only: replaces the player with one built from `next`. */
export function configureLocalPlayer(next: LocalPlayerOptions): Player {
  current?.dispose()
  current = undefined
  options = next
  const player = getLocalPlayer()
  notify()
  return player
}

/** Tests only: destroys the player and goes back to the default options. */
export function resetLocalPlayer(): void {
  current?.dispose()
  current = undefined
  options = {}
  notify()
}

const support = new Map<string, PlaySupport>()
let probe: HTMLAudioElement | undefined

/**
 * How sure this browser is that it can play files of `format`, answered as the direct audio
 * engine answers it: `canPlayType` for the format's MIME type (Chromium and Firefox say `no` to
 * ALAC, for one). A configured engine (tests) answers for itself.
 */
export function formatSupport(format: Pick<StreamOption, 'codec' | 'container'>): PlaySupport {
  if (options.engine?.canPlay !== undefined) {
    return options.engine.canPlay({
      url: '',
      codec: format.codec,
      container: format.container,
      media: 'audio',
      tier: tierOf({ codec: format.codec }),
      protocol: 'progressive',
      ipBound: false,
      fullLength: 'verified',
    })
  }
  const key = `${format.codec}/${format.container}`
  let answer = support.get(key)
  if (answer === undefined) {
    const type = mimeTypeOf(format)
    if (type === undefined || typeof document === 'undefined') {
      answer = 'maybe'
    } else {
      probe ??= document.createElement('audio')
      const result = probe.canPlayType(type)
      answer = result === '' ? 'no' : result
    }
    support.set(key, answer)
  }
  return answer
}

/** What the player's state reads as before anything played: no player is made just to look. */
const IDLE: PlayerState = {
  queue: createQueue(),
  status: 'idle',
  buffering: false,
  positionMs: 0,
  durationMs: undefined,
  volume: 1,
  muted: false,
  stream: undefined,
  error: undefined,
}

/**
 * Selects a value from the player's state and re-renders when it changes. The selector must
 * return a value from the state or a primitive, not a new object on every call.
 */
export function useLocalPlayerState<T>(selector: (state: PlayerState) => T): T {
  const read = () => selector(current?.player.getState() ?? IDLE)
  return useSyncExternalStore(subscribeLocalPlayer, read, read)
}

/** The local track playing or selected, as a track ID, and whether it plays. */
export function usePlayingTrack(): { id: string | undefined; playing: boolean } {
  const id = useLocalPlayerState((state) => currentQueueItem(state.queue)?.track.id)
  const playing = useLocalPlayerState(
    (state) => state.status === 'playing' || state.status === 'loading',
  )
  return { id, playing }
}

/** A failure's message for people, when it is one of FXM's own (they say what to do). */
export function failureMessage(error: Error): string | undefined {
  return isFxmError(error) ? error.message : undefined
}
