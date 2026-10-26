/**
 * Where the audio effects meet the app's player (stage 8.1): the engine that knows which streams
 * the page can read, and {@link connectAudioEffects}, which keeps a player in step with the
 * settings and the sleep timer. The app's playback connects its player
 * (`features/now-playing/playback.ts`), which plays local files too.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import {
  DirectAudioEngine,
  type DirectAudioEngineOptions,
  isMediaReadable,
  type Player,
  type SleepTimerRequest,
} from '@fxm/player'
import { useConnection } from '../connect/connection'
import { showFeedback } from '../search/feedback'
import {
  type AudioEffectsStore,
  type SleepTimerSetting,
  useAudioEffectsStore,
} from './effects-store'

/**
 * Whether the page can read `stream`'s bytes, which the equalizer needs, with what the app knows
 * about its platform now: `isMediaReadable` with the connection's platform and capabilities.
 */
export function isReadableHere(stream: Pick<StreamOption, 'url'>): boolean {
  const { platform, capabilities } = useConnection.getState()
  return isMediaReadable(stream, { platform, capabilities })
}

/**
 * What the app's engines take for the audio effects: the readability rule the equalizer needs
 * ({@link isReadableHere}). The browser's engine gets it from {@link createAppEngine}; the desktop
 * app's, `DesktopAudioEngine`, from the composition root (`src/app/services/desktop.ts`).
 */
export function appEngineOptions(): DirectAudioEngineOptions {
  return { isReadable: isReadableHere }
}

/** The app's direct audio engine, with the readability rule the equalizer needs. */
export function createAppEngine(options: DirectAudioEngineOptions = {}): DirectAudioEngine {
  return new DirectAudioEngine({ ...appEngineOptions(), ...options })
}

/** The player's request for a sleep timer the user set, as of `now`. */
export function sleepRequestOf(
  setting: SleepTimerSetting | undefined,
  now: number,
): SleepTimerRequest | null {
  if (setting === undefined) return null
  if ('endOfTrack' in setting) return { endOfTrack: true }
  return { afterMs: Math.max(0, setting.endsAt - now) }
}

/** What the confirmation says when the sleep timer paused playback. */
export const SLEEP_MESSAGE = 'Sleep timer paused playback'

/**
 * Keeps `player` in step with the audio effects: their settings now and whenever they change,
 * and the sleep timer. When the player's timer ends, so does the setting that Settings and the
 * Sound dialog show: with "Sleep timer paused playback" when it paused something, quietly when
 * nothing played at its time. Returns a function that disconnects it.
 */
export function connectAudioEffects(
  player: Player,
  store: AudioEffectsStore = useAudioEffectsStore,
  now: () => number = Date.now,
): () => void {
  const state = store.getState()
  player.setAudioEffects(state.effects)
  if (state.sleepTimer !== undefined) player.setSleepTimer(sleepRequestOf(state.sleepTimer, now()))
  const stopStore = store.subscribe((next, previous) => {
    if (next.effects !== previous.effects) player.setAudioEffects(next.effects)
    if (next.sleepTimer !== previous.sleepTimer) {
      player.setSleepTimer(sleepRequestOf(next.sleepTimer, now()))
    }
  })
  // The player's timer ended by itself (cancelling it in the store ends it there first).
  const stopTimer = player.subscribe((next, previous) => {
    if (previous.sleepTimer === undefined || next.sleepTimer !== undefined) return
    if (store.getState().sleepTimer !== undefined) store.getState().cancelSleepTimer()
  })
  const stopSleep = player.on('sleep', () => showFeedback(SLEEP_MESSAGE))
  return () => {
    stopStore()
    stopTimer()
    stopSleep()
    player.setSleepTimer(null)
  }
}
