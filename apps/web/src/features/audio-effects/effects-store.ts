/**
 * The audio effects settings (stage 8.1): the equalizer, loudness normalization, crossfade and
 * playback speed, persisted under their own key like the other settings, and the sleep timer,
 * which lasts only as long as the page. The players follow the store (`connect.ts`).
 *
 * @module
 */

import {
  type AudioEffectsSettings,
  clampCrossfadeMs,
  clampEqualizerGain,
  clampPlaybackRate,
  DEFAULT_AUDIO_EFFECTS,
  type EqualizerPresetId,
  equalizerPreset,
  type LoudnessSettings,
  presetOfGains,
  sanitizeAudioEffects,
  sanitizeLoudness,
} from '@fxm/core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * The sleep timer the user set: pause at `endsAt` (epoch milliseconds), or at the end of the
 * current track. Not persisted: a reload ends it.
 */
export type SleepTimerSetting =
  | { readonly endsAt: number; readonly minutes: number }
  | { readonly endOfTrack: true }

export interface AudioEffectsState {
  /** The effects, always valid (`sanitizeAudioEffects`). */
  effects: AudioEffectsSettings
  /** The sleep timer, while one runs. */
  sleepTimer: SleepTimerSetting | undefined
  /** Switches the equalizer on or off. */
  setEqualizerEnabled: (enabled: boolean) => void
  /** Sets one band's gain, in dB; the preset becomes `custom` unless the gains match one. */
  setEqualizerGain: (band: number, gainDb: number) => void
  /**
   * Applies a preset's gains and switches the equalizer on; Flat (a reset) leaves the switch as
   * it is.
   */
  applyEqualizerPreset: (id: EqualizerPresetId) => void
  /** Changes loudness normalization. */
  setLoudness: (patch: Partial<LoudnessSettings>) => void
  /** Sets the crossfade, in milliseconds (0 is off). */
  setCrossfadeMs: (durationMs: number) => void
  /** Whether to crossfade between tracks of one album too. */
  setCrossfadeSameAlbum: (sameAlbum: boolean) => void
  /** Sets the playback speed. */
  setPlaybackRate: (rate: number) => void
  /** Starts a sleep timer of `minutes` from now. */
  sleepAfter: (minutes: number) => void
  /** Starts a sleep timer for the end of the current track. */
  sleepAtEndOfTrack: () => void
  /** Cancels the sleep timer, or forgets it once it paused playback. */
  cancelSleepTimer: () => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const AUDIO_EFFECTS_STORAGE_KEY = 'fxm.audio-effects.v1'
const AUDIO_EFFECTS_VERSION = 1

type Persisted = { effects: AudioEffectsSettings }

/** Valid persisted state from an untrusted value. */
export function sanitizePersistedEffects(value: unknown): Persisted {
  const stored =
    typeof value === 'object' && value !== null && Object.hasOwn(value, 'effects')
      ? (value as { effects: unknown }).effects
      : undefined
  return { effects: sanitizeAudioEffects(stored) }
}

export interface AudioEffectsStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
  /** The clock, in epoch milliseconds, for the sleep timer. Default: `Date.now`. */
  now?: () => number
}

/** Creates the store, persisted to Web Storage (one per app; tests make their own). */
export function createAudioEffectsStore({
  storage,
  now = Date.now,
}: AudioEffectsStoreOptions = {}) {
  return create<AudioEffectsState>()(
    persist(
      (set, get) => {
        const update = (change: (effects: AudioEffectsSettings) => AudioEffectsSettings) =>
          set({ effects: sanitizeAudioEffects(change(get().effects)) })
        return {
          effects: sanitizeAudioEffects(DEFAULT_AUDIO_EFFECTS),
          sleepTimer: undefined,
          setEqualizerEnabled: (enabled) =>
            update((effects) => ({ ...effects, equalizer: { ...effects.equalizer, enabled } })),
          setEqualizerGain: (band, gainDb) =>
            update((effects) => {
              const gainsDb = effects.equalizer.gainsDb.map((gain, index) =>
                index === band ? clampEqualizerGain(gainDb) : gain,
              )
              return {
                ...effects,
                equalizer: { ...effects.equalizer, gainsDb, preset: presetOfGains(gainsDb) },
              }
            }),
          applyEqualizerPreset: (id) =>
            update((effects) => ({
              ...effects,
              equalizer: {
                enabled: id === 'flat' ? effects.equalizer.enabled : true,
                gainsDb: equalizerPreset(id).gainsDb,
                preset: id,
              },
            })),
          setLoudness: (patch) =>
            update((effects) => ({
              ...effects,
              loudness: sanitizeLoudness({ ...effects.loudness, ...patch }),
            })),
          setCrossfadeMs: (durationMs) =>
            update((effects) => ({
              ...effects,
              crossfade: { ...effects.crossfade, durationMs: clampCrossfadeMs(durationMs) },
            })),
          setCrossfadeSameAlbum: (sameAlbum) =>
            update((effects) => ({ ...effects, crossfade: { ...effects.crossfade, sameAlbum } })),
          setPlaybackRate: (rate) =>
            update((effects) => ({ ...effects, playbackRate: clampPlaybackRate(rate) })),
          sleepAfter: (minutes) =>
            set({
              sleepTimer: {
                endsAt: now() + Math.max(0, minutes) * 60_000,
                minutes: Math.max(0, minutes),
              },
            }),
          sleepAtEndOfTrack: () => set({ sleepTimer: { endOfTrack: true } }),
          cancelSleepTimer: () => set({ sleepTimer: undefined }),
        }
      },
      {
        name: AUDIO_EFFECTS_STORAGE_KEY,
        version: AUDIO_EFFECTS_VERSION,
        storage: createSafeStorage<Persisted>(storage),
        // The sleep timer is about this session: never stored.
        partialize: ({ effects }) => ({ effects }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizePersistedEffects(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizePersistedEffects(persisted) }),
      },
    ),
  )
}

export type AudioEffectsStore = ReturnType<typeof createAudioEffectsStore>

/** The app's audio effects. */
export const useAudioEffectsStore: AudioEffectsStore = createAudioEffectsStore()

/**
 * Re-reads the settings when another tab changes them, so two open tabs sound the same. Returns
 * the unsubscribe function.
 */
export function syncAudioEffectsAcrossTabs(
  store: AudioEffectsStore = useAudioEffectsStore,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === AUDIO_EFFECTS_STORAGE_KEY || event.key === null) {
      void store.persist.rehydrate()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
