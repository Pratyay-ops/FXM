/**
 * The smoke test's page, in the hidden window of the smoke build. It runs the steps through the
 * app's real native networking and sends each step's result, then the report, to the app, which
 * prints them and exits.
 *
 * @module
 */

import { createPlatform } from '@fxm/platform'
import { emit } from '@tauri-apps/api/event'
import { htmlAudioPlayer } from './player'
import { runSmoke, type SmokeReport } from './steps'
import { interimYouTube } from './youtube'

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

async function smoke(): Promise<SmokeReport> {
  log(`started in ${navigator.userAgent}`)
  const platform = await createPlatform()
  log(`platform ${platform.environment}: ${JSON.stringify(platform.capabilities.current)}`)
  try {
    return await runSmoke({
      context: () => platform.context({ mode: 'music', priority: 'interactive' }),
      capabilities: platform.capabilities.current,
      youtube: interimYouTube,
      player: htmlAudioPlayer(),
      query: 'Radiohead Creep',
      freeTrack: FREE_TRACK,
      onStep: (step) => log(`${step.status} ${step.name}: ${step.detail}`),
    })
  } finally {
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
