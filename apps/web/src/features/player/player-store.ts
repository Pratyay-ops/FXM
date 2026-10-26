import type { RepeatMode } from '@fxm/core'
import type { PlayerState } from '@fxm/player'
import { create } from 'zustand'
import { getPlayer, subscribePlayer } from '../now-playing/playback'

export type { RepeatMode } from '@fxm/core'

/**
 * What the player showed before real playback arrived (stages 2.2 and 2.5).
 *
 * @deprecated The bars show the queue's current item now. Kept for stage 2.6's placeholder
 * like button, until the like button takes the current track instead.
 */
export const PLACEHOLDER_TRACK = {
  title: 'Track title',
  artist: 'Artist name',
  seed: 'fxm-now-playing',
} as const

/**
 * The player bar's view of the app's player (`features/now-playing/playback.ts`): what the
 * controls show, in the units they show it, and actions that drive the player. The player is
 * the source of truth; this store follows every change it makes. Call the actions straight from
 * event handlers, so playback starts inside the user's gesture. Likes live in the library
 * (`features/library/use-track-like.ts`).
 */
export interface PlayerUiState {
  /** Whether a track is playing or selected; the controls are disabled without one. */
  hasTrack: boolean
  /** Playing, or getting ready to: the button shows "Pause". */
  isPlaying: boolean
  /** Waiting for the stream or for data. */
  busy: boolean
  /** Seconds into the track. */
  position: number
  /** Track length in seconds, 0 when unknown. */
  duration: number
  /** 0 to 1, kept while muted so unmuting restores it. */
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  togglePlay: () => void
  play: () => void
  seek: (seconds: number) => void
  previous: () => void
  next: () => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
}

const NEXT_REPEAT: Readonly<Record<RepeatMode, RepeatMode>> = { off: 'all', all: 'one', one: 'off' }

/** The fields of {@link PlayerUiState} that follow the player. */
function view(state: PlayerState) {
  return {
    hasTrack: state.queue.index >= 0,
    isPlaying: state.status === 'playing' || state.status === 'loading',
    busy: state.status === 'loading' || state.buffering,
    position: state.positionMs / 1000,
    duration: (state.durationMs ?? 0) / 1000,
    volume: state.volume,
    muted: state.muted,
    shuffle: state.queue.shuffle,
    repeat: state.queue.repeat,
  }
}

export const usePlayerStore = create<PlayerUiState>()(() => ({
  ...view(getPlayer().getState()),
  togglePlay: () => void getPlayer().toggle(),
  play: () => void getPlayer().play(),
  seek: (seconds) => getPlayer().seek(seconds * 1000),
  previous: () => void getPlayer().previous(),
  next: () => void getPlayer().next(),
  setVolume: (volume) => {
    const player = getPlayer()
    player.setVolume(volume)
    player.setMuted(player.getState().volume === 0)
  },
  toggleMute: () => {
    const player = getPlayer()
    const { muted, volume } = player.getState()
    if (!muted && volume > 0) {
      player.setMuted(true)
      return
    }
    // Unmuting at volume zero would stay silent: come back at half volume.
    if (volume === 0) player.setVolume(0.5)
    player.setMuted(false)
  },
  toggleShuffle: () => {
    const player = getPlayer()
    player.setShuffle(!player.getState().queue.shuffle)
  },
  cycleRepeat: () => {
    const player = getPlayer()
    player.setRepeat(NEXT_REPEAT[player.getState().queue.repeat])
  },
}))

subscribePlayer(() => usePlayerStore.setState(view(getPlayer().getState())))
