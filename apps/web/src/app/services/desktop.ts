/**
 * The desktop app's playback (stage 7.3) in the web app's player: inside Tauri, the app's one
 * player (stage 2.5) plays through `@fxm/desktop/bridge`'s engine and options, the tray and the
 * Web Lock follow it, and the stream lifecycle takes the desktop's URL margin and network
 * monitor, as `apps/desktop/README.md` ("Playback and OS integration") describes:
 *
 * - `DesktopAudioEngine`: `<audio src>` only for URLs that passed the end-of-file probe, and the
 *   codec per `canPlayType` with the real macOS version (AAC before 15.4);
 * - the equalizer's readability rule (stage 8.1, `appEngineOptions()` of
 *   `features/audio-effects/connect.ts`), as the browser's engine has it: the engine routes the
 *   user's files, downloads and the free sources through Web Audio, never googlevideo, which the
 *   webview loads without CORS until stage 7.6;
 * - `DESKTOP_PLAYER_OPTIONS`: streams loaded about 5 hours ago are resolved again, and a song
 *   whose probe got no answer is retried rather than skipped;
 * - the lifecycle's `refreshBeforeExpiryMs` (an hour) and the native network monitor;
 * - `connect(player)`: the tray menu and the Web Lock that keeps a hidden window playing.
 *
 * `main.tsx` calls {@link setUpDesktopPlayback} before the first render, since the player is
 * created with it, and passes what it returns to `startAppServices`. In a browser it does
 * nothing, and the bridge's code is never downloaded.
 *
 * @module
 */

import { isTauriRuntime } from '@fxm/platform'
import type { NetworkMonitor } from '@fxm/player'
import { appEngineOptions } from '../../features/audio-effects/connect'
import { configurePlayback, getPlayer } from '../../features/now-playing/playback'

/** The bridge module, `@fxm/desktop/bridge`. */
export type DesktopBridge = typeof import('@fxm/desktop/bridge')

/** What the stream lifecycle takes from the desktop app. */
export interface DesktopLifecycleOptions {
  /** Resolve URLs again an hour before they expire (`DESKTOP_URL_REFRESH_MARGIN_MS`). */
  readonly refreshBeforeExpiryMs: number
  /** The native network monitor: route changes, plus `online` and `offline`. */
  readonly network: NetworkMonitor
}

/** Options for {@link setUpDesktopPlayback}. Everything has a default; tests pass fakes. */
export interface DesktopPlaybackSetupOptions {
  /** Whether the app runs inside Tauri. Default: `isTauriRuntime()`. */
  readonly tauri?: boolean
  /** Loads the bridge. Default: `import('@fxm/desktop/bridge')`. */
  readonly loadBridge?: () => Promise<Pick<DesktopBridge, 'createDesktopPlayback'>>
  /** Options for the bridge's `createDesktopPlayback`, e.g. a fake shell. */
  readonly playback?: Parameters<DesktopBridge['createDesktopPlayback']>[0]
}

/**
 * Inside Tauri: builds the app's player with the desktop's engine and options, connects it to
 * the tray and the Web Lock, and returns what the stream lifecycle takes. Elsewhere `undefined`.
 * Call it before anything uses the player: it replaces the player it finds.
 */
export async function setUpDesktopPlayback(
  options: DesktopPlaybackSetupOptions = {},
): Promise<DesktopLifecycleOptions | undefined> {
  if (!(options.tauri ?? isTauriRuntime())) return undefined
  const load = options.loadBridge ?? (() => import('@fxm/desktop/bridge'))
  const { createDesktopPlayback } = await load()
  const desktop = createDesktopPlayback(options.playback)
  configurePlayback({
    // Without the app's readability rule, the equalizer would process only the page's own URLs
    // (`blob:`, `data:`, same-origin): not Internet Archive's, which send CORS headers.
    createEngine: () => desktop.createEngine(appEngineOptions()),
    player: desktop.playerOptions,
  })
  desktop.connect(getPlayer())
  return desktop.lifecycleOptions
}
