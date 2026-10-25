import { formatId, type Track } from '@fxm/core'
import { create } from 'zustand'

export type RepeatMode = 'off' | 'all' | 'one'

/** What the player shows until real playback arrives (stages 2.2 and 2.5). */
export const PLACEHOLDER_TRACK = {
  title: 'Track title',
  artist: 'Artist name',
  seed: 'fxm-now-playing',
} as const

/**
 * The placeholder as a core track, so the like button can already save it to the library
 * (stage 2.6). The real player hands the like button its current track instead.
 */
export const PLACEHOLDER_NOW_PLAYING: Track = {
  id: formatId('local', 'track', 'fxm-placeholder'),
  source: 'local',
  title: PLACEHOLDER_TRACK.title,
  artists: [{ name: PLACEHOLDER_TRACK.artist }],
  durationMs: 213_000,
  artwork: [],
  kind: 'song',
}

/**
 * Placeholder player UI state: every control works, nothing plays. The real
 * player facade (@fxm/player, stage 2.2) replaces the actions, not the shape.
 */
export interface PlayerUiState {
  isPlaying: boolean
  /** Seconds into the track. */
  position: number
  /** Track length in seconds. */
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

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min

export const usePlayerStore = create<PlayerUiState>()((set) => ({
  isPlaying: false,
  position: 0,
  duration: 213,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',
  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
  play: () => set({ isPlaying: true }),
  seek: (seconds) => set((state) => ({ position: clamp(seconds, 0, state.duration) })),
  previous: () => set({ position: 0 }),
  next: () => set({ position: 0 }),
  setVolume: (volume) => {
    const next = clamp(volume, 0, 1)
    set({ volume: next, muted: next === 0 })
  },
  toggleMute: () =>
    set((state) =>
      state.muted || state.volume === 0
        ? { muted: false, volume: state.volume === 0 ? 0.5 : state.volume }
        : { muted: true },
    ),
  toggleShuffle: () => set((state) => ({ shuffle: !state.shuffle })),
  cycleRepeat: () => set((state) => ({ repeat: NEXT_REPEAT[state.repeat] })),
}))
