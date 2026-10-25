/**
 * Stage 7.3's steps of the live smoke test: "three consecutive full tracks play with the window
 * hidden", through the app's real player (`@fxm/player`), its stream lifecycle and the desktop
 * bridge (`bridge/`), in the hidden window of the smoke build. `runSmoke` runs them after stage
 * 7.2's steps (`extraSteps`).
 *
 * @module
 */

import { choosePlaybackStream, type StreamOption, type Track } from '@fxm/core'
import type { StreamSource } from '@fxm/player'
import { type DesktopEnvironment, desktopPlaySupport } from '../bridge'
import type { RunStep } from './steps'

/** Three tracks and the sources that resolve them. */
export interface SmokePlaylist {
  /** What the tracks are, for the report: `Internet Archive tracks`. */
  readonly label: string
  /** The tracks, in play order. */
  readonly tracks: readonly Track[]
  /** The stream sources the stream lifecycle resolves them with. */
  readonly sources: readonly StreamSource[]
}

/** What became of one track of a playlist. */
export interface PlayedTrack {
  /** Its title. */
  readonly title: string
  /** The media's duration, in seconds. */
  readonly durationS: number
  /** The furthest position playback reached, in seconds. */
  readonly playedS: number
  /** Whether it played to its end: the player moved on because it ended. */
  readonly ended: boolean
  /** The codec of the stream that played it. */
  readonly codec?: StreamOption['codec']
}

/** What happened while a playlist played. */
export interface PlaylistRun {
  /** Each track, in play order. */
  readonly tracks: readonly PlayedTrack[]
  /**
   * Whether the Web Lock was held every time it was checked during playback; `undefined` where
   * the webview has no Web Locks API.
   */
  readonly webLock?: boolean
  /** The titles the Media Session showed, in order; `undefined` without a Media Session. */
  readonly mediaSessionTitles?: readonly string[]
  /** The page's visibility while it played, e.g. `hidden`. */
  readonly visibility: readonly string[]
}

/** Plays a playlist to its end through the app's player, muted. */
export interface QueuePlayer {
  /** Resolves once the last track has ended; rejects when a track fails or time runs out. */
  play(playlist: SmokePlaylist, options: { readonly timeoutMs: number }): Promise<PlaylistRun>
}

/** What the page knows about the webview it runs in. */
export interface PlaybackEnvironment {
  /** What the shell says (`desktop_environment`). */
  readonly shell: DesktopEnvironment
  /** `canPlayType` for YouTube's two audio formats: Opus 251 and AAC 140. */
  readonly canPlayType: { readonly opus: string; readonly aac: string }
  /** Whether the page has the Media Session API. */
  readonly mediaSession: boolean
  /** Whether the page has the Web Locks API (a secure context only). */
  readonly webLocks: boolean
  /** The page's visibility, e.g. `hidden` in the smoke build's window. */
  readonly visibility: string
}

/** Options for {@link runPlaybackSteps}. */
export interface PlaybackSmokeOptions {
  /** Where the app runs. */
  readonly environment: () => Promise<PlaybackEnvironment>
  /** The playlists to play, each built when its step runs; one may throw `Pending`. */
  readonly playlists: readonly { readonly label: string; build(): Promise<SmokePlaylist> }[]
  /** The app's player. */
  readonly player: QueuePlayer
  /** How long one playlist may take to play. Default: 30 minutes. */
  readonly timeoutMs?: number
}

/** How many tracks a playlist plays: stage 7.3's done-when asks for three in a row. */
export const PLAYLIST_LENGTH = 3

/** How far from its end a track may stop and still count as played in full, in seconds. */
export const END_TOLERANCE_S = 3

const DEFAULT_TIMEOUT_MS = 30 * 60_000

/** A probed YouTube stream of the top rung, for rating its format with the desktop rules. */
function youtubeStream(codec: 'opus' | 'aac'): StreamOption {
  return {
    url: `https://rr1---sn-x.googlevideo.com/videoplayback?itag=${codec === 'opus' ? 251 : 140}`,
    codec,
    container: codec === 'opus' ? 'webm' : 'm4a',
    media: 'audio',
    bitrateKbps: codec === 'opus' ? 150 : 130,
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength: 'verified',
  }
}

/**
 * Which of YouTube's formats the desktop app plays where `environment` was found: the playback
 * policy's choice between Opus 251 and AAC 140, from the webview's `canPlayType` answers and the
 * desktop rules.
 */
export function youtubeFormat(environment: PlaybackEnvironment): string {
  const answers = environment.canPlayType
  const picked = choosePlaybackStream([youtubeStream('opus'), youtubeStream('aac')], {
    ceiling: 'high',
    support: (stream) => {
      const answer = stream.codec === 'opus' ? answers.opus : answers.aac
      const support = answer === 'probably' || answer === 'maybe' ? answer : 'no'
      return desktopPlaySupport(stream, support, environment.shell)
    },
  })
  if (picked === undefined) return 'neither format'
  return picked.codec === 'opus' ? 'Opus 251' : 'AAC 140'
}

/** The report's line about the environment. */
export function describeEnvironment(environment: PlaybackEnvironment): string {
  const { shell, canPlayType } = environment
  const os = [shell.os, shell.osVersion].filter(Boolean).join(' ')
  const yesNo = (value: boolean) => (value ? 'yes' : 'no')
  return [
    `${os}, webview ${shell.webviewVersion ?? 'unknown'}`,
    `canPlayType Opus "${canPlayType.opus}", AAC "${canPlayType.aac}": plays ${youtubeFormat(environment)}`,
    `Media Session ${yesNo(environment.mediaSession)}, Web Locks ${yesNo(environment.webLocks)}`,
    `tray ${yesNo(shell.tray)}, page ${environment.visibility}`,
  ].join('; ')
}

/** Why a playlist's run doesn't show three full tracks in a row, or `undefined` when it does. */
export function runProblem(run: PlaylistRun, playlist: SmokePlaylist): string | undefined {
  if (run.tracks.length !== playlist.tracks.length) {
    return `${run.tracks.length} of ${playlist.tracks.length} tracks played`
  }
  for (const track of run.tracks) {
    if (!(track.durationS > 0)) return `${track.title} had no duration`
    if (!track.ended) return `${track.title} stopped at ${track.playedS.toFixed(1)} s`
    if (track.playedS < track.durationS - END_TOLERANCE_S) {
      return `${track.title} ended after ${track.playedS.toFixed(1)} of ${track.durationS.toFixed(1)} s`
    }
  }
  if (run.webLock === false) return 'the Web Lock was not held while music played'
  const expected = playlist.tracks.map((track) => track.title)
  const shown = run.mediaSessionTitles
  if (shown !== undefined && shown.join('\n') !== expected.join('\n')) {
    return `the Media Session showed ${JSON.stringify(shown)}, not ${JSON.stringify(expected)}`
  }
  return undefined
}

/** The report's line about a playlist that played. */
export function describeRun(run: PlaylistRun): string {
  const lengths = run.tracks.map((track) => `${track.durationS.toFixed(1)} s`).join(' + ')
  const codecs = [...new Set(run.tracks.map((track) => track.codec ?? 'unknown'))].join(', ')
  const lock =
    run.webLock === undefined ? 'no Web Locks API' : 'the Web Lock held while music played'
  const session =
    run.mediaSessionTitles === undefined
      ? 'no Media Session'
      : `the Media Session showed each title`
  const visibility = [...new Set(run.visibility)].join(', ') || 'unknown'
  return `${lengths} of ${codecs}, one after another; ${lock}; ${session}; page ${visibility}`
}

/**
 * Runs stage 7.3's steps: where the app runs, then each playlist played to its end, three
 * tracks in a row, in the hidden window.
 */
export async function runPlaybackSteps(
  step: RunStep,
  options: PlaybackSmokeOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await step('where the app runs', async () => {
    const environment = await options.environment()
    return [environment, describeEnvironment(environment)]
  })
  for (const playlist of options.playlists) {
    await step(
      `${PLAYLIST_LENGTH} ${playlist.label} play to the end, one after another, hidden`,
      async () => {
        const built = await playlist.build()
        if (built.tracks.length !== PLAYLIST_LENGTH) {
          throw new Error(`the playlist has ${built.tracks.length} tracks`)
        }
        const run = await options.player.play(built, { timeoutMs })
        const problem = runProblem(run, built)
        if (problem !== undefined) throw new Error(problem)
        return [run, describeRun(run)]
      },
    )
  }
}
