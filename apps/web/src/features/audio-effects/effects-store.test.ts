import { DEFAULT_AUDIO_EFFECTS, equalizerPreset } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  AUDIO_EFFECTS_STORAGE_KEY,
  createAudioEffectsStore,
  sanitizePersistedEffects,
  syncAudioEffectsAcrossTabs,
} from './effects-store'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

function setup(initial: Record<string, string> = {}, now = () => 1_000_000) {
  const storage = memoryStorage(initial)
  const store = createAudioEffectsStore({ storage: () => storage, now })
  const stored = () => JSON.parse(storage.getItem(AUDIO_EFFECTS_STORAGE_KEY) ?? 'null')
  return { store, storage, stored }
}

describe('the audio effects store', () => {
  it('starts from the defaults', () => {
    const { store } = setup()
    expect(store.getState().effects).toEqual(DEFAULT_AUDIO_EFFECTS)
    expect(store.getState().sleepTimer).toBeUndefined()
  })

  it('moves bands, naming the preset the gains match', () => {
    const { store } = setup()
    store.getState().setEqualizerGain(0, 6.2)
    expect(store.getState().effects.equalizer.gainsDb[0]).toBe(6)
    expect(store.getState().effects.equalizer.preset).toBe('custom')
    store.getState().setEqualizerGain(0, 0)
    expect(store.getState().effects.equalizer.preset).toBe('flat')
    store.getState().setEqualizerGain(3, 99)
    expect(store.getState().effects.equalizer.gainsDb[3]).toBe(12)
  })

  it('applies presets and switches the equalizer on, but a reset keeps the switch', () => {
    const { store } = setup()
    store.getState().applyEqualizerPreset('rock')
    expect(store.getState().effects.equalizer).toEqual({
      enabled: true,
      gainsDb: [...equalizerPreset('rock').gainsDb],
      preset: 'rock',
    })
    store.getState().setEqualizerEnabled(false)
    store.getState().applyEqualizerPreset('flat')
    expect(store.getState().effects.equalizer.enabled).toBe(false)
    expect(store.getState().effects.equalizer.preset).toBe('flat')
  })

  it('validates loudness, crossfade and speed', () => {
    const { store } = setup()
    store.getState().setLoudness({ targetLufs: -18, mode: 'album' })
    expect(store.getState().effects.loudness).toEqual({
      enabled: true,
      targetLufs: -18,
      mode: 'album',
    })
    store.getState().setLoudness({ targetLufs: -3 })
    expect(store.getState().effects.loudness.targetLufs).toBe(-14)
    store.getState().setCrossfadeMs(6400)
    store.getState().setCrossfadeSameAlbum(true)
    expect(store.getState().effects.crossfade).toEqual({ durationMs: 6000, sameAlbum: true })
    store.getState().setPlaybackRate(1.27)
    expect(store.getState().effects.playbackRate).toBe(1.25)
  })

  it('keeps the effects across reloads, but never the sleep timer', () => {
    const { store, storage, stored } = setup()
    store.getState().applyEqualizerPreset('jazz')
    store.getState().sleepAfter(30)
    expect(stored().state).toEqual({ effects: store.getState().effects })
    const reloaded = createAudioEffectsStore({ storage: () => storage })
    expect(reloaded.getState().effects.equalizer.preset).toBe('jazz')
    expect(reloaded.getState().sleepTimer).toBeUndefined()
  })

  it('falls back to the defaults for stored data that is broken', () => {
    const value = JSON.stringify({
      state: { effects: { equalizer: 'x', playbackRate: 9, loudness: { enabled: false } } },
      version: 1,
    })
    const { store } = setup({ [AUDIO_EFFECTS_STORAGE_KEY]: value })
    expect(store.getState().effects.equalizer).toEqual(DEFAULT_AUDIO_EFFECTS.equalizer)
    expect(store.getState().effects.playbackRate).toBe(2)
    expect(store.getState().effects.loudness.enabled).toBe(false)
    expect(sanitizePersistedEffects(null).effects).toEqual(DEFAULT_AUDIO_EFFECTS)
  })

  it('sets the sleep timer from the clock, and cancels it', () => {
    const { store } = setup({}, () => 5000)
    store.getState().sleepAfter(15)
    expect(store.getState().sleepTimer).toEqual({ endsAt: 5000 + 15 * 60_000, minutes: 15 })
    store.getState().sleepAtEndOfTrack()
    expect(store.getState().sleepTimer).toEqual({ endOfTrack: true })
    store.getState().cancelSleepTimer()
    expect(store.getState().sleepTimer).toBeUndefined()
  })

  it('follows changes made in another tab', async () => {
    const { store, storage } = setup()
    const stop = syncAudioEffectsAcrossTabs(store)
    const other = createAudioEffectsStore({ storage: () => storage })
    other.getState().setPlaybackRate(1.5)
    window.dispatchEvent(new StorageEvent('storage', { key: AUDIO_EFFECTS_STORAGE_KEY }))
    await Promise.resolve()
    expect(store.getState().effects.playbackRate).toBe(1.5)
    stop()
  })
})
