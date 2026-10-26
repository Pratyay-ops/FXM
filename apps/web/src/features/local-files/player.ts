/**
 * How local files play: through the app's player (`features/now-playing/playback.ts`, stage
 * 2.5), from object URLs.
 *
 * - {@link withLocalFiles} wraps any `StreamResolver`: queue items that are local tracks (or
 *   whose recorded audio is a local file) resolve to their file's object URL, everything else
 *   goes to the wrapped resolver. The composition root (`src/app/services`, stage 2.9) puts it in
 *   front of the app's playback policy ({@link withLocalFilesFirst}), so local files never
 *   reach the stream lifecycle, and nothing about them reaches the network.
 * - {@link getLocalPlayer} is the `Player` the local-files UI plays through: the app's, which
 *   the player bars, Now playing and the system media controls show.
 *
 * @module
 */

import {
  currentQueueItem,
  FxmError,
  isFxmError,
  type QueueItem,
  type StreamOption,
  tierOf,
} from '@fxm/core'
import {
  type Engine,
  mimeTypeOf,
  type Player,
  type PlayerEventMap,
  type PlayerState,
  type PlaySupport,
  type StreamResolver,
} from '@fxm/player'
import {
  configurePlayback,
  getPlayer,
  type PlaybackOptions,
  resetPlayback,
  subscribePlayer,
  usePlayerState,
} from '../now-playing/playback'
import { createPendingPolicy, type PlaybackPolicy } from '../now-playing/playback-policy'
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

/**
 * `policy` with local files in front of its resolver ({@link withLocalFiles}): what the app's
 * player plays with. Its other members are `policy`'s.
 */
export function withLocalFilesFirst(
  policy: PlaybackPolicy,
  files: () => LocalFiles = getLocalFiles,
): PlaybackPolicy {
  return {
    resolver: withLocalFiles(policy.resolver, files),
    onNeedsReview: (listener) => policy.onNeedsReview(listener),
    alternatives: (track, signal) => policy.alternatives(track, signal),
    pin: (track, candidate) => policy.pin(track, candidate),
    setPlayBestGuesses: (on) => policy.setPlayBestGuesses(on),
  }
}

/** How tests put the app's player together for local files ({@link configureLocalPlayer}). */
export interface LocalPlayerOptions {
  /** Default: a `DirectAudioEngine`. */
  engine?: Engine
  /** Whether to show the playing track in the system media controls. Default: true. */
  mediaSession?: boolean
  /** Default: the app's local files. */
  files?: () => LocalFiles
  /** Tuning passed on to the player, e.g. shorter retry delays in tests. */
  player?: PlaybackOptions['player']
}

/** The engine {@link configureLocalPlayer} was given, which answers {@link formatSupport}. */
let testEngine: Engine | undefined
const failureListeners = new Set<(failure: PlayerEventMap['trackfailed']) => void>()
/** The player whose `trackfailed` events reach {@link failureListeners}. */
let failures: { readonly player: Player; readonly stop: () => void } | undefined

/** Passes the `trackfailed` events of `player`, the app's player, on to the listeners. */
function followFailures(player: Player): Player {
  if (failures?.player === player) return player
  failures?.stop()
  failures = {
    player,
    stop: player.on('trackfailed', (failure) => {
      for (const listener of [...failureListeners]) listener(failure)
    }),
  }
  return player
}

/**
 * Calls `listener` whenever the app's player gives up on a track, also a player that replaced
 * it (tests). Returns a function that stops it.
 */
export function onTrackFailed(
  listener: (failure: PlayerEventMap['trackfailed']) => void,
): () => void {
  failureListeners.add(listener)
  followFailures(getPlayer())
  return () => {
    failureListeners.delete(listener)
  }
}

/** The player local files play through: the app's (see the module documentation). */
export function getLocalPlayer(): Player {
  return followFailures(getPlayer())
}

/** Calls `listener` when the player's state changes or the player is replaced. */
export function subscribeLocalPlayer(listener: () => void): () => void {
  return subscribePlayer(listener)
}

/**
 * Tests only: replaces the app's player with one built from `next`, which plays local files and
 * refuses everything else (`Unsupported`, as where the app's music services don't run), and,
 * like `setupTestPlayback`, keeps no listening history.
 */
export function configureLocalPlayer(next: LocalPlayerOptions): Player {
  testEngine = next.engine
  const { engine } = next
  const { player } = configurePlayback({
    ...(engine === undefined ? {} : { createEngine: () => engine }),
    policy: withLocalFilesFirst(createPendingPolicy(), next.files),
    recordPlays: false,
    ...(next.mediaSession === undefined ? {} : { mediaSession: next.mediaSession }),
    ...(next.player === undefined ? {} : { player: next.player }),
  })
  return followFailures(player)
}

/** Tests only: destroys the app's player and goes back to its default options. */
export function resetLocalPlayer(): void {
  testEngine = undefined
  failures?.stop()
  failures = undefined
  resetPlayback()
}

const support = new Map<string, PlaySupport>()
let probe: HTMLAudioElement | undefined

/**
 * How sure this browser is that it can play files of `format`, answered as the direct audio
 * engine answers it: `canPlayType` for the format's MIME type (Chromium and Firefox say `no` to
 * ALAC, for one). A configured engine (tests) answers for itself.
 */
export function formatSupport(format: Pick<StreamOption, 'codec' | 'container'>): PlaySupport {
  if (testEngine?.canPlay !== undefined) {
    return testEngine.canPlay({
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

/**
 * Selects a value from the app's player's state and re-renders when it changes. The selector
 * must return a value from the state or a primitive, not a new object on every call.
 */
export function useLocalPlayerState<T>(selector: (state: PlayerState) => T): T {
  return usePlayerState(selector)
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
