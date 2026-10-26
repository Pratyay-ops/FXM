import { DEFAULT_QUALITY_PREFS, DEFAULT_STREAMING_SETTINGS } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  createQualityStore,
  lifecycleQualityOptions,
  QUALITY_STORAGE_KEY,
  sanitizeQualitySettings,
  syncQualityAcrossTabs,
} from './quality-store'

/** An in-memory stand-in for localStorage. */
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
      data.set(key, String(value))
    },
  }
}

const saved = (state: unknown, version = 1) => ({
  [QUALITY_STORAGE_KEY]: JSON.stringify({ state, version }),
})

const DEFAULTS = {
  prefs: { streaming: { wifi: 'high', cellular: 'normal' }, download: { format: 'original' } },
  streaming: { connection: 'auto', dataSaver: false },
}

describe('quality store', () => {
  it('starts with core’s defaults: High on Wi-Fi, Normal on mobile data, original downloads', () => {
    const store = createQualityStore({ storage: () => memoryStorage() })
    expect(store.getState()).toMatchObject(DEFAULTS)
    expect(store.getState().prefs).toEqual(DEFAULT_QUALITY_PREFS)
    expect(store.getState().streaming).toEqual(DEFAULT_STREAMING_SETTINGS)
  })

  it('persists every change under the versioned key and restores it after a reload', () => {
    const storage = memoryStorage()
    const store = createQualityStore({ storage: () => storage })
    const actions = store.getState()

    actions.setStreamingTier('wifi', 'lossless')
    actions.setStreamingTier('cellular', 'low')
    actions.setConnection('cellular')
    actions.setDataSaver(true)
    actions.setDownloadFormat('mp3')
    actions.setMp3Bitrate(192)

    const expected = {
      prefs: {
        streaming: { wifi: 'lossless', cellular: 'low' },
        download: { format: 'mp3', mp3Kbps: 192 },
      },
      streaming: { connection: 'cellular', dataSaver: true },
    }
    expect(JSON.parse(storage.getItem('fxm.quality.v1') ?? 'null')).toEqual({
      state: expected,
      version: 1,
    })
    const afterReload = createQualityStore({ storage: () => storage })
    expect(afterReload.getState()).toMatchObject(expected)
  })

  it('replaces the objects it changes, so selectors see the change', () => {
    const store = createQualityStore({ storage: () => memoryStorage() })
    const before = store.getState()
    store.getState().setStreamingTier('cellular', 'low')
    expect(store.getState().prefs).not.toBe(before.prefs)
    expect(store.getState().prefs.streaming).toEqual({ wifi: 'high', cellular: 'low' })
    expect(store.getState().streaming).toBe(before.streaming)
    store.getState().setDataSaver(true)
    expect(store.getState().streaming).not.toBe(before.streaming)
  })

  it.each([
    ['corrupt JSON', '{"state": {"prefs": '],
    ['a bare string', '"lossless"'],
    ['an array', '[1, 2, 3]'],
    ['null', 'null'],
    ['a state of the wrong type', JSON.stringify({ state: 'lossless', version: 1 })],
    [
      'unknown values',
      JSON.stringify({
        state: {
          prefs: { streaming: { wifi: 'ultra' }, download: { format: 'wma' } },
          streaming: { connection: 'ethernet', dataSaver: 'yes' },
        },
        version: 1,
      }),
    ],
  ])('falls back to the defaults when storage holds %s', (_, raw) => {
    const storage = memoryStorage({ [QUALITY_STORAGE_KEY]: raw })
    const store = createQualityStore({ storage: () => storage })
    expect(store.getState()).toMatchObject(DEFAULTS)
  })

  it('keeps the valid fields of partly invalid data', () => {
    const storage = memoryStorage(
      saved({
        prefs: { streaming: { wifi: 'low', cellular: 'ultra' }, download: { mp3Kbps: 96 } },
        streaming: { connection: 'wifi', dataSaver: 1 },
      }),
    )
    const store = createQualityStore({ storage: () => storage })
    expect(store.getState()).toMatchObject({
      prefs: { streaming: { wifi: 'low', cellular: 'normal' }, download: { format: 'original' } },
      streaming: { connection: 'wifi', dataSaver: false },
    })
    expect('mp3Kbps' in store.getState().prefs.download).toBe(false)
  })

  it('sanitizes data saved by another version instead of discarding it', () => {
    const storage = memoryStorage(saved({ streaming: { dataSaver: true }, legacy: true }, 0))
    const store = createQualityStore({ storage: () => storage })
    expect(store.getState().streaming).toEqual({ connection: 'auto', dataSaver: true })
    expect(JSON.parse(storage.getItem(QUALITY_STORAGE_KEY) ?? 'null')).toEqual({
      state: { ...DEFAULTS, streaming: { connection: 'auto', dataSaver: true } },
      version: 1,
    })
  })

  it('never reads inherited fields', () => {
    const inherited = Object.create({ streaming: { dataSaver: true } }) as object
    expect(sanitizeQualitySettings(inherited)).toEqual(DEFAULTS)
  })

  it('keeps working when storage is missing, blocked or full', () => {
    const failing: Storage = {
      ...memoryStorage(),
      getItem: () => {
        throw new DOMException('Access denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      },
    }
    const storages: Array<() => Storage | undefined> = [
      () => undefined,
      () => {
        throw new DOMException('Access denied', 'SecurityError')
      },
      () => failing,
    ]
    for (const storage of storages) {
      const store = createQualityStore({ storage })
      expect(store.getState()).toMatchObject(DEFAULTS)
      expect(() => store.getState().setDataSaver(true)).not.toThrow()
      expect(store.getState().streaming.dataSaver).toBe(true)
    }
  })

  it('picks up changes made in another tab', () => {
    const storage = memoryStorage()
    const store = createQualityStore({ storage: () => storage })
    const stop = syncQualityAcrossTabs(store)

    storage.setItem(
      QUALITY_STORAGE_KEY,
      JSON.stringify({ state: { streaming: { connection: 'auto', dataSaver: true } }, version: 1 }),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: QUALITY_STORAGE_KEY }))
    expect(store.getState().streaming.dataSaver).toBe(true)

    stop()
    storage.setItem(QUALITY_STORAGE_KEY, JSON.stringify({ state: {}, version: 1 }))
    window.dispatchEvent(new StorageEvent('storage', { key: QUALITY_STORAGE_KEY }))
    expect(store.getState().streaming.dataSaver).toBe(true)
  })

  it('gives the stream lifecycle the current settings every time it asks', () => {
    const store = createQualityStore({ storage: () => memoryStorage() })
    const { qualityPrefs, streaming } = lifecycleQualityOptions(store)
    expect(qualityPrefs().streaming.wifi).toBe('high')
    expect(streaming().dataSaver).toBe(false)

    store.getState().setStreamingTier('wifi', 'normal')
    store.getState().setDataSaver(true)

    expect(qualityPrefs().streaming.wifi).toBe('normal')
    expect(streaming().dataSaver).toBe(true)
  })
})
