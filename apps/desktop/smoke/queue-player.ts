/**
 * The smoke test's {@link QueuePlayer}: plays a playlist through the app's real player
 * (`@fxm/player`) and stream lifecycle, connected the way the web app connects them in the
 * desktop app: the desktop engine, the tray, the Web Lock and the Media Session. Muted: the test
 * runs unattended, often at night.
 *
 * @module
 */

import { currentQueueItem, type ProviderContext } from '@fxm/core'
import {
  type Engine,
  Player,
  type PlayerOptions,
  StreamLifecycle,
  type StreamLifecycleOptions,
} from '@fxm/player'
import type { PlayedTrack, PlaylistRun, QueuePlayer, SmokePlaylist } from './playback-steps'

/** What the page looks like at one moment of playback. */
export interface PlaybackSample {
  /** Whether the Web Lock is held; `undefined` without a Web Locks API. */
  readonly webLock?: boolean
  /** The title the Media Session shows; `undefined` without a Media Session. */
  readonly mediaSessionTitle?: string
  /** The page's visibility, e.g. `hidden`. */
  readonly visibility: string
  /** How long the page has been loaded, in seconds; in the smoke build, how long it was hidden. */
  readonly pageS?: number
}

/** Options for {@link appQueuePlayer}. */
export interface QueuePlayerOptions {
  /** The provider context the stream lifecycle resolves with. */
  readonly context: () => ProviderContext
  /** Creates the engine: the desktop app's. */
  readonly createEngine: () => Engine
  /** The desktop app's player options. */
  readonly playerOptions?: Omit<PlayerOptions, 'engine' | 'resolver'>
  /** The desktop app's stream lifecycle options: its URL refresh margin and network monitor. */
  readonly lifecycleOptions?: Partial<StreamLifecycleOptions>
  /** Connects the player as the app does: the tray, the Web Lock and the Media Session. */
  readonly connect: (player: Player) => () => void
  /** Looks at the page; called each time a track starts playing. */
  readonly sample: () => Promise<PlaybackSample>
}

/** What is known about one queue item while the playlist plays. */
interface Tally {
  title: string
  durationMs: number
  playedMs: number
  ended: boolean
  codec?: PlayedTrack['codec']
  sampled: boolean
}

/** Plays playlists through the app's player (see the module documentation). */
export function appQueuePlayer(options: QueuePlayerOptions): QueuePlayer {
  return {
    async play(playlist, { timeoutMs }) {
      const lifecycle = new StreamLifecycle({
        ...options.lifecycleOptions,
        sources: playlist.sources,
        context: options.context,
      })
      const player = new Player({
        ...options.playerOptions,
        engine: options.createEngine(),
        resolver: lifecycle,
        muted: true,
      })
      lifecycle.attach(player)
      const disconnect = options.connect(player)
      try {
        return await playToEnd(player, playlist, timeoutMs, options.sample)
      } finally {
        disconnect()
        player.destroy()
        lifecycle.destroy()
      }
    },
  }
}

/** Plays `playlist` on `player` until its last track ends. */
function playToEnd(
  player: Player,
  playlist: SmokePlaylist,
  timeoutMs: number,
  sample: () => Promise<PlaybackSample>,
): Promise<PlaylistRun> {
  return new Promise<PlaylistRun>((resolve, reject) => {
    const tallies = new Map<number, Tally>()
    const samples: Promise<PlaybackSample>[] = []
    const stops: (() => void)[] = []
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const stop of stops.splice(0)) stop()
      if (error !== undefined) {
        reject(error)
        return
      }
      Promise.all(samples).then((seen) => resolve(runOf([...tallies.values()], seen)), reject)
    }
    const timer = setTimeout(() => {
      const state = player.getState()
      const title = currentQueueItem(state.queue)?.track.title ?? 'nothing'
      finish(
        new Error(
          `still playing after ${timeoutMs / 1000} s: ${title}, ${state.status}, at ` +
            `${(state.positionMs / 1000).toFixed(1)} s`,
        ),
      )
    }, timeoutMs)
    const tallyOf = (uid: number, title: string) => {
      let tally = tallies.get(uid)
      if (tally === undefined) {
        tally = { title, durationMs: 0, playedMs: 0, ended: false, sampled: false }
        tallies.set(uid, tally)
      }
      return tally
    }
    stops.push(
      player.subscribe((state) => {
        const item = currentQueueItem(state.queue)
        if (item === undefined) return
        const tally = tallyOf(item.uid, item.track.title)
        tally.playedMs = Math.max(tally.playedMs, state.positionMs)
        if (state.durationMs !== undefined && state.stream !== undefined) {
          tally.durationMs = state.durationMs
        }
        if (state.stream !== undefined) tally.codec = state.stream.codec
        if (state.status === 'playing' && !tally.sampled) {
          tally.sampled = true
          samples.push(sample())
        }
        if (state.status === 'error' && state.error !== undefined) {
          finish(
            new Error(`playback stopped (${state.error.reason}): ${state.error.error.message}`),
          )
        }
      }),
      player.on('trackchange', ({ previous, cause }) => {
        if (previous !== undefined && cause === 'ended') {
          tallyOf(previous.uid, previous.track.title).ended = true
        }
      }),
      player.on('queueend', () => {
        const item = currentQueueItem(player.getState().queue)
        if (item !== undefined) tallyOf(item.uid, item.track.title).ended = true
        finish()
      }),
      player.on('trackfailed', ({ item, error }) => {
        finish(new Error(`${item.track.title} failed: ${error.message}`))
      }),
    )
    void player.setQueue([...playlist.tracks])
  })
}

/** The run's report from the tallies and the samples taken while it played. */
function runOf(tallies: readonly Tally[], samples: readonly PlaybackSample[]): PlaylistRun {
  const tracks = tallies.map(
    (tally): PlayedTrack => ({
      title: tally.title,
      durationS: tally.durationMs / 1000,
      playedS: tally.playedMs / 1000,
      ended: tally.ended,
      ...(tally.codec === undefined ? {} : { codec: tally.codec }),
    }),
  )
  const locks = samples.flatMap((seen) => (seen.webLock === undefined ? [] : [seen.webLock]))
  const titles = samples.flatMap((seen) =>
    seen.mediaSessionTitle === undefined ? [] : [seen.mediaSessionTitle],
  )
  const starts = samples.flatMap((seen) => (seen.pageS === undefined ? [] : [seen.pageS]))
  return {
    tracks,
    ...(locks.length === 0 ? {} : { webLock: locks.every(Boolean) }),
    ...(titles.length === 0 ? {} : { mediaSessionTitles: titles }),
    visibility: samples.map((seen) => seen.visibility),
    ...(starts.length === 0 ? {} : { startsS: starts }),
  }
}
