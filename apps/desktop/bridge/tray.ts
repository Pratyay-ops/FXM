/**
 * Connects the web app's player to the desktop shell's tray (stage 7.3): the tray menu shows
 * the current track and whether it plays, is paused or stopped on an error, and its Play/Pause,
 * Next and Previous items act on the player.
 *
 * @module
 */

import { currentQueueItem } from '@fxm/core'
import type { Player, PlayerState, PlayerStatus } from '@fxm/player'
import type { DesktopShell, MediaAction, NowPlaying, PlaybackState } from './shell'

/** The parts of the player the tray uses. */
export type TrayPlayer = Pick<Player, 'getState' | 'subscribe' | 'toggle' | 'next' | 'previous'>

/** Player statuses in which audio plays or is about to. */
const ACTIVE_STATUSES: ReadonlySet<PlayerStatus> = new Set(['playing', 'loading'])

/** Whether audio plays or is about to: the player is `playing` or `loading`. */
export function isPlaybackActive(state: Pick<PlayerState, 'status'>): boolean {
  return ACTIVE_STATUSES.has(state.status)
}

/** What the tray says the player is doing (see {@link PlaybackState}). */
export function playbackStateOf(state: Pick<PlayerState, 'status'>): PlaybackState {
  if (isPlaybackActive(state)) return 'playing'
  return state.status === 'error' ? 'error' : 'paused'
}

/** What the tray shows for the player's `state`. */
export function nowPlayingOf(state: PlayerState): NowPlaying {
  const track = currentQueueItem(state.queue)?.track
  if (track === undefined) return { state: 'paused' }
  const artist = track.artists.map((credit) => credit.name).join(', ')
  return {
    state: playbackStateOf(state),
    title: track.title,
    ...(artist === '' ? {} : { artist }),
  }
}

function sameNowPlaying(a: NowPlaying, b: NowPlaying): boolean {
  return a.state === b.state && a.title === b.title && a.artist === b.artist
}

/**
 * After a failed update of the tray, how long until it is sent again: 1 s, doubling with each
 * failure in a row, at most a minute.
 */
export const TRAY_RETRY_MS = Object.freeze({ first: 1000, max: 60_000 })

/** The wait before resending after `failures` failed updates in a row. */
export function trayRetryDelay(failures: number): number {
  return Math.min(TRAY_RETRY_MS.max, TRAY_RETRY_MS.first * 2 ** Math.max(0, failures - 1))
}

/** Options for {@link connectTray}. */
export interface TrayOptions {
  /**
   * Where a failed update of the tray is reported: the first of each run of failures. Default:
   * `console.error`.
   */
  onError?: (error: unknown) => void
}

/**
 * Keeps the tray in step with `player` and routes the tray's media actions to it. Sends the
 * state at once, then only when what the tray shows changes. An update that fails is sent again,
 * with the latest state, after {@link trayRetryDelay}; updates wait for that retry, so a tray
 * that keeps failing is asked at most once a minute. Returns a function that disconnects the
 * tray and tells the shell that nothing plays.
 */
export function connectTray(
  player: TrayPlayer,
  shell: DesktopShell,
  options: TrayOptions = {},
): () => void {
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  /** What the shell shows, or is being sent; `undefined` after a failed update. */
  let shown: NowPlaying | undefined
  /** What the tray should show. */
  let latest = nowPlayingOf(player.getState())
  /** Updates that failed in a row. */
  let failures = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let connected = true

  const send = () => {
    // A retry is due, and it sends whatever is latest by then.
    if (retry !== undefined) return
    const now = latest
    if (shown !== undefined && sameNowPlaying(shown, now)) return
    shown = now
    shell.setNowPlaying(now).then(
      () => {
        if (shown === now) failures = 0
      },
      (error: unknown) => {
        // A newer state went out since, and the shell has that one, or will.
        if (shown !== now) return
        shown = undefined
        if (failures === 0) onError(error)
        failures += 1
        if (!connected) return
        retry = setTimeout(() => {
          retry = undefined
          send()
        }, trayRetryDelay(failures))
      },
    )
  }
  const show = (now: NowPlaying) => {
    latest = now
    send()
  }
  const actions: Record<MediaAction, () => void> = {
    toggle: () => void player.toggle(),
    next: () => void player.next(),
    previous: () => void player.previous(),
  }
  send()
  const unsubscribe = player.subscribe((state) => show(nowPlayingOf(state)))
  const stopActions = shell.onMediaAction((action) => actions[action]())
  return () => {
    unsubscribe()
    stopActions()
    connected = false
    clearTimeout(retry)
    retry = undefined
    show({ state: 'paused' })
  }
}
