/**
 * The smoke test's page, in the hidden window of the smoke build. It runs the steps through the
 * app's real native networking and sends each step's result, then the report, to the app, which
 * prints them and exits. Stage 7.6 put in the real YouTube Music search and stream ladder
 * (`youtube.ts`) and the readable audio path's check (`readable.ts`).
 *
 * @module
 */

import { createPlatform } from '@fxm/platform'
import { connectMediaSession, mimeTypeOf } from '@fxm/player'
import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { createDesktopPlayback, type DesktopPlayback, PLAYBACK_LOCK, pageLocks } from '../bridge'
import { type PlaybackEnvironment, runPlaybackSteps } from './playback-steps'
import { htmlAudioPlayer } from './player'
import { FREE_PLAYLIST, youtubeSongs } from './playlists'
import { appQueuePlayer, type PlaybackSample } from './queue-player'
import { readablePath, webAudioProbe } from './readable'
import { runSmoke, type SmokeReport } from './steps'
import { smokeYouTube } from './youtube'

/** The events `src-tauri/src/smoke.rs` prints: a line of progress, and the final report. */
const LOG_EVENT = 'fxm-smoke-log'
const REPORT_EVENT = 'fxm-smoke-report'

/** A public-domain recording of 27 s on Internet Archive (the Public Domain Mark). */
const FREE_TRACK = {
  url: 'https://archive.org/download/long_temple_bell/long_temple_bell.mp3',
  label: 'Internet Archive track',
}

function log(line: string): void {
  void emit(LOG_EVENT, line).catch(() => {})
}

addEventListener('error', (event) => log(`page error: ${event.message}`))
addEventListener('unhandledrejection', (event) => log(`unhandled: ${String(event.reason)}`))

/** Where the app runs, from the shell and from the webview itself (stage 7.3). */
async function playbackEnvironment(desktop: DesktopPlayback): Promise<PlaybackEnvironment> {
  const shell = (await desktop.ready) ?? (await desktop.shell.environment())
  const audio = document.createElement('audio')
  const canPlay = (codec: 'opus' | 'aac', container: 'webm' | 'm4a') =>
    audio.canPlayType(mimeTypeOf({ codec, container }) ?? '')
  return {
    shell,
    canPlayType: { opus: canPlay('opus', 'webm'), aac: canPlay('aac', 'm4a') },
    mediaSession: 'mediaSession' in navigator,
    webLocks: pageLocks() !== undefined,
    visibility: document.visibilityState,
  }
}

/** Whether the playback lock is held, and what the Media Session shows, right now. */
async function samplePage(): Promise<PlaybackSample> {
  let webLock: boolean | undefined
  if (typeof navigator.locks?.query === 'function') {
    const { held = [] } = await navigator.locks.query()
    webLock = held.some((lock) => lock.name === PLAYBACK_LOCK)
  }
  const mediaSessionTitle =
    'mediaSession' in navigator ? (navigator.mediaSession.metadata?.title ?? '') : undefined
  return {
    ...(webLock === undefined ? {} : { webLock }),
    ...(mediaSessionTitle === undefined ? {} : { mediaSessionTitle }),
    visibility: document.visibilityState,
    pageS: performance.now() / 1000,
  }
}

async function smoke(): Promise<SmokeReport> {
  log(`started in ${navigator.userAgent}`)
  const platform = await createPlatform()
  log(`platform ${platform.environment}: ${JSON.stringify(platform.capabilities.current)}`)
  const desktop = createDesktopPlayback({ onError: (error) => log(`desktop: ${String(error)}`) })
  try {
    return await runSmoke({
      context: () => platform.context({ mode: 'music', priority: 'interactive' }),
      capabilities: platform.capabilities.current,
      youtube: smokeYouTube(),
      // Stage 7.6: the verified streams through fxm-media and Web Audio.
      readable: readablePath(webAudioProbe()),
      player: htmlAudioPlayer(),
      query: 'Radiohead Creep',
      freeTrack: FREE_TRACK,
      // Untyped on purpose: the hook step sends a Map, which InvokeArgs doesn't list.
      invoke: (command, payload) => invoke(command, payload as InvokeArgs),
      onStep: (step) => log(`${step.status} ${step.name}: ${step.detail}`),
      // Stage 7.3: three tracks in a row through the app's player, in this hidden window.
      extraSteps: (step) =>
        runPlaybackSteps(step, {
          environment: () => playbackEnvironment(desktop),
          playlists: [
            { label: 'YouTube Music songs', build: youtubeSongs },
            { label: FREE_PLAYLIST.label, build: async () => FREE_PLAYLIST },
          ],
          player: appQueuePlayer({
            context: () => platform.context({ mode: 'music', priority: 'current-track' }),
            createEngine: () => desktop.createEngine(),
            playerOptions: desktop.playerOptions,
            lifecycleOptions: desktop.lifecycleOptions,
            connect: (player) => {
              const disconnects = [desktop.connect(player), connectMediaSession(player)]
              return () => {
                for (const disconnect of disconnects) disconnect()
              }
            },
            sample: samplePage,
          }),
        }),
    })
  } finally {
    desktop.dispose()
    platform.dispose()
  }
}

function show(report: SmokeReport): void {
  const output = document.getElementById('report')
  if (output) output.textContent = JSON.stringify(report, null, 2)
}

void smoke()
  .catch(
    (error: unknown): SmokeReport => ({
      ok: false,
      steps: [{ name: 'smoke test', status: 'failed', detail: String(error), ms: 0 }],
    }),
  )
  .then(async (report) => {
    show(report)
    await emit(REPORT_EVENT, report)
  })
