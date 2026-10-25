/**
 * The app's player until stage 2.5 is on `develop`. Stage 2.5 builds the real one in
 * `features/now-playing/playback.ts`, with the saved queue, the review list, Now playing and a
 * player bar that shows what plays. When it lands:
 *
 * 1. its `createAppPolicy()` returns `getAppServices().policy`;
 * 2. its `createPlayback()` calls `getAppServices().connectPlayer(player)` and keeps the
 *    function it returns with its other disconnects;
 * 3. this module and its call in `index.ts` go.
 *
 * Until then it makes a basic play work: one `Player` on the direct audio engine, resolving
 * through the stream lifecycle, in the catalog mode of the settings, in the system media
 * controls (Media Session), and driving the shell's player bar (stage 2.1), whose play, pause,
 * previous, next, seek, volume, shuffle and repeat controls then act on it. The bar keeps its
 * placeholder title, which 2.5 replaces.
 *
 * @module
 */

import {
  connectMediaSession,
  DirectAudioEngine,
  type Engine,
  Player,
  type PlayerState,
  type StreamResolver,
} from '@fxm/player'
import { type RepeatMode, usePlayerStore } from '../../features/player/player-store'
import { useSettingsStore } from '../../features/settings/settings-store'

/** Options for {@link createInterimPlayer}. */
export interface InterimPlayerOptions {
  /** Where the streams come from: the stream lifecycle. */
  readonly resolver: StreamResolver
  /** The engine. Default: a `DirectAudioEngine` (two `<audio>` elements). */
  readonly engine?: Engine
  /** Whether to show the track in the system media controls. Default: true. */
  readonly mediaSession?: boolean
}

/** The interim player and how to take it down. */
export interface InterimPlayer {
  /** The player. */
  readonly player: Player
  /** Disconnects it from the settings, the media controls and the bar, and destroys it. */
  dispose(): void
}

const NEXT_REPEAT: Readonly<Record<RepeatMode, RepeatMode>> = { off: 'all', all: 'one', one: 'off' }

/** What the shell's player bar shows of the player's state, in its units. */
function barView(state: PlayerState) {
  return {
    isPlaying: state.status === 'playing' || state.status === 'loading',
    position: state.positionMs / 1000,
    duration: (state.durationMs ?? 0) / 1000,
    volume: state.volume,
    muted: state.muted,
    shuffle: state.queue.shuffle,
    repeat: state.queue.repeat,
  }
}

/**
 * Makes the shell's player bar (`features/player/player-store.ts`, stage 2.1) follow `player`
 * and act on it. Returns a function that puts the bar's placeholder state back.
 */
export function bindPlayerBar(player: Player): () => void {
  const initial = usePlayerStore.getState()
  usePlayerStore.setState({
    ...barView(player.getState()),
    togglePlay: () => void player.toggle(),
    play: () => void player.play(),
    seek: (seconds) => player.seek(seconds * 1000),
    previous: () => void player.previous(),
    next: () => void player.next(),
    setVolume: (volume) => {
      player.setVolume(volume)
      player.setMuted(player.getState().volume === 0)
    },
    toggleMute: () => {
      const { muted, volume } = player.getState()
      if (!muted && volume > 0) {
        player.setMuted(true)
        return
      }
      // Unmuting at volume zero would stay silent: come back at half volume.
      if (volume === 0) player.setVolume(0.5)
      player.setMuted(false)
    },
    toggleShuffle: () => player.setShuffle(!player.getState().queue.shuffle),
    cycleRepeat: () => player.setRepeat(NEXT_REPEAT[player.getState().queue.repeat]),
  })
  const stop = player.subscribe((state) => usePlayerStore.setState(barView(state)))
  return () => {
    stop()
    usePlayerStore.setState(initial, true)
  }
}

/** Creates the interim player: see the module documentation. */
export function createInterimPlayer(options: InterimPlayerOptions): InterimPlayer {
  const player = new Player({
    engine: options.engine ?? new DirectAudioEngine(),
    resolver: options.resolver,
    queue: { mode: useSettingsStore.getState().catalogMode },
  })
  const stops = [
    options.mediaSession === false ? () => {} : connectMediaSession(player),
    useSettingsStore.subscribe((state, previous) => {
      if (state.catalogMode !== previous.catalogMode) player.setCatalogMode(state.catalogMode)
    }),
    bindPlayerBar(player),
  ]
  return {
    player,
    dispose() {
      for (const stop of stops) stop()
      player.destroy()
    },
  }
}
