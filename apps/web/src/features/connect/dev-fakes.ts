/**
 * The connect feature's development fake mode: a fake stream resolver, so the Diagnostics
 * self-test can be seen working before stage 1.4's ladder is wired in. Only `make dev` and builds
 * made with `VITE_FXM_FAKES=on` (the Playwright tests) load this module; production builds leave
 * it out.
 *
 * Open the app with `?fake-song=plays`, `capped`, `fails`, `bot-check` or `unavailable` to turn
 * it on for the tab, and with `?fake-song=off` to turn it off. The fake streams are WAV files made
 * on the device (a soft tone), and the failing one is a file no browser can decode.
 *
 * @module
 */

import { createFakeResolver, FAKE_SONG_SCENARIOS, type FakeSongScenario } from './fake-resolver'
import { setSongResolver } from './resolver'
import { wavTone } from './wav'

/** sessionStorage key that keeps the scenario while the app navigates. */
export const FAKE_SONG_KEY = 'fxm.dev.fake-song'

function isScenario(value: unknown): value is FakeSongScenario {
  return typeof value === 'string' && (FAKE_SONG_SCENARIOS as readonly string[]).includes(value)
}

/**
 * The scenario for this tab: `?fake-song=<scenario>` sets it, `?fake-song=off` clears it, and
 * otherwise the one set earlier in this tab, if any.
 */
export function readFakeSongScenario(
  search: string = window.location.search,
  storage: () => Storage | undefined = () => window.sessionStorage,
): FakeSongScenario | undefined {
  const requested = new URLSearchParams(search).get('fake-song')
  try {
    const session = storage()
    if (requested === 'off') {
      session?.removeItem(FAKE_SONG_KEY)
      return undefined
    }
    if (isScenario(requested)) {
      session?.setItem(FAKE_SONG_KEY, requested)
      return requested
    }
    const stored = session?.getItem(FAKE_SONG_KEY)
    return isScenario(stored) ? stored : undefined
  } catch {
    // Storage blocked: the URL still decides for this page load.
    return isScenario(requested) ? requested : undefined
  }
}

/** Turns the fake resolver on when this tab asked for it. */
export function installConnectFakes(): void {
  const scenario = readFakeSongScenario()
  if (scenario === undefined) return
  const good = URL.createObjectURL(
    new Blob([wavTone({ seconds: 4, frequency: 440, volume: 0.15 })], { type: 'audio/wav' }),
  )
  // Bytes that are no media file at all: the browser fails to decode them at once.
  const bad = URL.createObjectURL(
    new Blob([new Uint8Array(2048).fill(0x5a)], { type: 'audio/webm' }),
  )
  setSongResolver(createFakeResolver(scenario, { urls: { good, bad }, latencyMs: 300 }))
  console.info(
    `FXM: fake song resolver on (${scenario}). Open the app with ?fake-song=off to leave it.`,
  )
}
