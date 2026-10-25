/**
 * `@fxm/desktop/bridge`: the web app's side of the desktop shell's playback and OS integration
 * (stage 7.3). In the desktop app, the web app builds its player with these pieces:
 *
 * ```ts
 * import { createDesktopPlayback } from '@fxm/desktop/bridge'
 * import { isTauriRuntime } from '@fxm/platform'
 *
 * const desktop = isTauriRuntime() ? createDesktopPlayback() : undefined
 * const lifecycle = new StreamLifecycle({ ...options, ...desktop?.lifecycleOptions })
 * const player = new Player({
 *   ...desktop?.playerOptions,
 *   engine: desktop?.createEngine() ?? new DirectAudioEngine(),
 *   resolver: lifecycle,
 * })
 * const disconnect = desktop?.connect(player) // the tray and the Web Lock
 * ```
 *
 * The Media Session stays the web app's (`connectMediaSession` from `@fxm/player`): the
 * webviews hand it to each system's media controls. See `apps/desktop/README.md`.
 *
 * @module
 */

import type { DirectAudioEngineOptions, NetworkMonitor } from '@fxm/player'
import { DesktopAudioEngine } from './engine'
import { type KeepAwakePlayer, keepAwakeWhilePlaying, type LockManagerLike } from './keep-awake'
import { createDesktopNetworkMonitor } from './network'
import { DESKTOP_PLAYER_OPTIONS, DESKTOP_URL_REFRESH_MARGIN_MS } from './options'
import { createDesktopShell, type DesktopEnvironment, type DesktopShell } from './shell'
import { connectTray, type TrayPlayer } from './tray'

export * from './engine'
export * from './keep-awake'
export * from './network'
export * from './options'
export * from './shell'
export * from './tray'

/** The parts of the player the desktop app connects to. */
export type DesktopPlayer = TrayPlayer & KeepAwakePlayer

/** Options for {@link createDesktopPlayback}. Everything has a default; tests pass fakes. */
export interface DesktopPlaybackOptions {
  /** The desktop shell. Default: {@link createDesktopShell}`()`. */
  shell?: DesktopShell
  /** The Web Locks API. Default: the page's; `undefined` for none. */
  locks?: LockManagerLike | undefined
  /** Where `online` and `offline` fire. Default: the page. */
  target?: EventTarget
  /** Where failures of the shell's commands are reported. Default: `console.error`. */
  onError?: (error: unknown) => void
}

/** The desktop app's playback pieces (see the module documentation). */
export interface DesktopPlayback {
  /** The desktop shell. */
  readonly shell: DesktopShell
  /** Where the app runs, once the shell has answered; `undefined` until then. */
  environment(): DesktopEnvironment | undefined
  /** Resolves with the environment once the shell has answered, or `undefined` if it failed. */
  readonly ready: Promise<DesktopEnvironment | undefined>
  /** For `new Player(...)`: resolve again streams loaded about 5 hours ago. */
  readonly playerOptions: typeof DESKTOP_PLAYER_OPTIONS
  /**
   * For `new StreamLifecycle(...)`: URLs leave the cache when they are about 5 hours old, and
   * the cache is flushed when the network changes.
   */
  readonly lifecycleOptions: {
    readonly refreshBeforeExpiryMs: number
    readonly network: NetworkMonitor
  }
  /** The engine for the player: {@link DesktopAudioEngine}. */
  createEngine(options?: DirectAudioEngineOptions): DesktopAudioEngine
  /**
   * Connects `player` to the tray and keeps the page running while it plays (the Web Lock).
   * Returns a function that disconnects both.
   */
  connect(player: DesktopPlayer): () => void
  /** Stops watching the network. */
  dispose(): void
}

/** Creates the desktop app's playback pieces. Asks the shell where the app runs at once. */
export function createDesktopPlayback(options: DesktopPlaybackOptions = {}): DesktopPlayback {
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  const shell = options.shell ?? createDesktopShell({ onError })
  let environment: DesktopEnvironment | undefined
  const ready = shell.environment().then(
    (found) => {
      environment = found
      return found
    },
    (error: unknown) => {
      onError(error)
      return undefined
    },
  )
  const network = createDesktopNetworkMonitor({
    shell,
    ...(options.target === undefined ? {} : { target: options.target }),
  })
  const lockOptions = 'locks' in options ? { locks: options.locks } : {}
  return {
    shell,
    environment: () => environment,
    ready,
    playerOptions: DESKTOP_PLAYER_OPTIONS,
    lifecycleOptions: { refreshBeforeExpiryMs: DESKTOP_URL_REFRESH_MARGIN_MS, network },
    createEngine: (engineOptions = {}) =>
      new DesktopAudioEngine({ ...engineOptions, environment: () => environment }),
    connect(player) {
      const stopTray = connectTray(player, shell, { onError })
      const stopLock = keepAwakeWhilePlaying(player, { ...lockOptions, onError })
      return () => {
        stopTray()
        stopLock()
      }
    },
    dispose: () => network.destroy(),
  }
}
