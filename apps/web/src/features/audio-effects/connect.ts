/**
 * Where the audio effects meet the app's players (stage 8.1): the engine that knows which streams
 * the page can read, and {@link connectAudioEffects}, which keeps a player in step with the
 * settings and the sleep timer. The app's playback connects its player
 * (`features/now-playing/playback.ts`), and so does the local-files player until stage 2.9 makes
 * them one.
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

/** The app's direct audio engine, with the readability rule the equalizer needs. */
export function createAppEngine(options: DirectAudioEngineOptions = {}): DirectAudioEngine {
  return new DirectAudioEngine({ isReadable: isReadableHere, ...options })
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
 * and the sleep timer, which every connected player gets; the one that plays pauses, and that
 * ends the timer for all of them. Returns a function that disconnects it.
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
  const stopSleep = player.on('sleep', () => {
    store.getState().cancelSleepTimer()
    showFeedback(SLEEP_MESSAGE)
  })
  return () => {
    stopStore()
    stopSleep()
    player.setSleepTimer(null)
  }
}
