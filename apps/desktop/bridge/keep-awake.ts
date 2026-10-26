/**
 * Keeps a hidden window's page running while music plays (stage 7.3): it holds a Web Lock for
 * as long as the player is playing or loading the next track.
 *
 * Tauri turns background throttling off only on macOS 14 and later (`backgroundThrottling` in
 * `tauri.conf.json`, WebKit's inactive scheduling policy). WebView2 (Windows) and WebKitGTK
 * (Linux) have no such switch, and Tauri's documentation suggests a pending Web Lock instead.
 * Chromium, and so WebView2, never freezes a page that holds a Web Lock, so another page waiting
 * for the lock is never stuck behind a frozen one. Whether the lock also spares the page the
 * intensive throttling that starts after 5 minutes hidden, when a page that plays nothing
 * audible may wake its timers only once a minute, is what the smoke test's 9-minute playlist
 * shows on WebView2: the player's timers matter then, for retries and for the stall watch, while
 * it moves between tracks on media events. Whether WebKitGTK gains anything from the lock is part
 * of the manual check in `apps/desktop/README.md`.
 *
 * The lock is released while paused, so an idle FXM in the tray is throttled as usual. Holding
 * it costs nothing, so it is held on macOS too, including macOS 11 to 13, which have no inactive
 * scheduling policy (whether the lock helps WebKit there is untested).
 *
 * @module
 */

import type { Player } from '@fxm/player'
import { isPlaybackActive } from './tray'

/** The name of the lock: one per page, so two FXM pages never wait on each other. */
export const PLAYBACK_LOCK = 'fxm-background-playback'

/** The parts of the Web Locks API (`navigator.locks`) the keeper uses. */
export interface LockManagerLike {
  request(
    name: string,
    options: { readonly mode: 'shared' },
    callback: () => Promise<void>,
  ): Promise<unknown>
}

/** The parts of the player the keeper uses. */
export type KeepAwakePlayer = Pick<Player, 'getState' | 'subscribe'>

/** The page's Web Locks API, where it has one (a secure context). */
export function pageLocks(): LockManagerLike | undefined {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks
  return typeof locks?.request === 'function' ? locks : undefined
}

/** Options for {@link keepAwakeWhilePlaying}. */
export interface KeepAwakeOptions {
  /** The Web Locks API. Default: the page's ({@link pageLocks}); without one, nothing is held. */
  locks?: LockManagerLike | undefined
  /** The lock's name. Default: {@link PLAYBACK_LOCK}. */
  name?: string
  /** Where a refused lock is reported. Default: `console.error`. */
  onError?: (error: unknown) => void
}

/**
 * Holds a shared Web Lock while `player` is playing or loading, and releases it otherwise.
 * Returns a function that stops watching and releases the lock.
 */
export function keepAwakeWhilePlaying(
  player: KeepAwakePlayer,
  options: KeepAwakeOptions = {},
): () => void {
  const locks = 'locks' in options ? options.locks : pageLocks()
  if (locks === undefined) return () => {}
  const name = options.name ?? PLAYBACK_LOCK
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  let release: (() => void) | undefined

  const hold = () => {
    if (release !== undefined) return
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // Shared: granted at once, since nothing takes this lock exclusively.
    locks.request(name, { mode: 'shared' }, () => held).catch(onError)
  }
  const drop = () => {
    release?.()
    release = undefined
  }
  const follow = (active: boolean) => (active ? hold() : drop())

  follow(isPlaybackActive(player.getState()))
  const unsubscribe = player.subscribe((state) => follow(isPlaybackActive(state)))
  return () => {
    unsubscribe()
    drop()
  }
}
