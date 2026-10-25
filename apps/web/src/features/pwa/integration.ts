/**
 * Touch-points with stages that run alongside 5.1 and are not merged yet. Each is one small
 * interface with a stand-in; when the stage merges, the integration step replaces the stand-in
 * with the real thing and leaves the rest of the PWA code alone.
 *
 * The others: Now Playing filling a phone's screen (2.5), which `AppLayout` passes to
 * `<PwaShell fullScreen>` for the update toast, and the static host's headers (2.8), in
 * pwa/host.ts.
 *
 * @module
 */

import type { MediaSessionPlayer } from '@fxm/player'

/**
 * Where the app's player comes from. Stage 2.5 (now playing) owns it. The media keys, headset
 * buttons and the system's media controls drive it through the Media Session (2.2), and show
 * the track it plays.
 */
export interface AppPlayerSource {
  /** The app's player, or `undefined` while there is none. Called as a React hook. */
  usePlayer(): MediaSessionPlayer | undefined
}

/**
 * Stand-in until 2.5 merges: the app has no player yet, so the Media Session stays unconnected.
 * Integration: `usePlayer: () => <2.5's app player>`.
 */
export const appPlayerSource: AppPlayerSource = { usePlayer: () => undefined }
