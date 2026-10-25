/**
 * Connects the web app's player to the desktop shell's tray (stage 7.3): the tray menu shows
 * the current track and whether it plays, and its Play/Pause, Next and Previous items act on
 * the player. The shell's close button also reads whether music plays: while it does, closing
 * the window keeps FXM running in the tray.
 *
 * @module
 */

import { currentQueueItem } from '@fxm/core'
import type { Player, PlayerState, PlayerStatus } from '@fxm/player'
import type { DesktopShell, MediaAction, NowPlaying } from './shell'

/** The parts of the player the tray uses. */
export type TrayPlayer = Pick<Player, 'getState' | 'subscribe' | 'toggle' | 'next' | 'previous'>

/** Player statuses in which audio plays or is about to. */
const ACTIVE_STATUSES: ReadonlySet<PlayerStatus> = new Set(['playing', 'loading'])

/** Whether audio plays or is about to: the player is `playing` or `loading`. */
export function isPlaybackActive(state: Pick<PlayerState, 'status'>): boolean {
  return ACTIVE_STATUSES.has(state.status)
}

/** What the tray shows for the player's `state`. */
export function nowPlayingOf(state: PlayerState): NowPlaying {
  const track = currentQueueItem(state.queue)?.track
  if (track === undefined) return { playing: false }
  const artist = track.artists.map((credit) => credit.name).join(', ')
  return {
    playing: isPlaybackActive(state),
    title: track.title,
    ...(artist === '' ? {} : { artist }),
  }
}

function sameNowPlaying(a: NowPlaying, b: NowPlaying): boolean {
  return a.playing === b.playing && a.title === b.title && a.artist === b.artist
}

/** Options for {@link connectTray}. */
export interface TrayOptions {
  /** Where a failed update of the tray is reported. Default: `console.error`. */
  onError?: (error: unknown) => void
}

/**
 * Keeps the tray in step with `player` and routes the tray's media actions to it. Sends the
 * state at once, then only when what the tray shows changes. Returns a function that
 * disconnects the tray and tells the shell that nothing plays.
 */
export function connectTray(
  player: TrayPlayer,
  shell: DesktopShell,
  options: TrayOptions = {},
): () => void {
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  let shown: NowPlaying | undefined
  const send = (now: NowPlaying) => {
    if (shown !== undefined && sameNowPlaying(shown, now)) return
    shown = now
    shell.setNowPlaying(now).catch(onError)
  }
  const actions: Record<MediaAction, () => void> = {
    toggle: () => void player.toggle(),
    next: () => void player.next(),
    previous: () => void player.previous(),
  }
  send(nowPlayingOf(player.getState()))
  const unsubscribe = player.subscribe((state) => send(nowPlayingOf(state)))
  const stopActions = shell.onMediaAction((action) => actions[action]())
  return () => {
    unsubscribe()
    stopActions()
    send({ playing: false })
  }
}
