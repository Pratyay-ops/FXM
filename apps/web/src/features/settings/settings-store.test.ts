import { describe, expect, it } from 'vitest'
import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  syncSettingsAcrossTabs,
} from './settings-store'

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
  [SETTINGS_STORAGE_KEY]: JSON.stringify({ state, version }),
})

describe('settings store', () => {
  it('starts in Music mode with the dark theme', () => {
    const store = createSettingsStore({ storage: () => memoryStorage() })
    expect(store.getState()).toMatchObject({ catalogMode: 'music', theme: 'dark' })
  })

  it('persists changes under the versioned key and restores them after a reload', () => {
    const storage = memoryStorage()
    const store = createSettingsStore({ storage: () => storage })

    store.getState().setCatalogMode('all')
    store.getState().setTheme('light')

    expect(JSON.parse(storage.getItem('fxm.settings.v1') ?? 'null')).toEqual({
      state: { catalogMode: 'all', theme: 'light' },
      version: 1,
    })
    const afterReload = createSettingsStore({ storage: () => storage })
    expect(afterReload.getState()).toMatchObject({ catalogMode: 'all', theme: 'light' })
  })

  it.each([
    ['corrupt JSON', '{"state": {"catalogMode": '],
    ['a bare string', '"all"'],
    ['an array', '[1, 2, 3]'],
    ['null', 'null'],
    ['a state of the wrong type', JSON.stringify({ state: 'all', version: 1 })],
    [
      'unknown values',
      JSON.stringify({ state: { catalogMode: 'karaoke', theme: 42 }, version: 1 }),
    ],
  ])('falls back to the defaults when storage holds %s', (_, raw) => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: raw })
    const store = createSettingsStore({ storage: () => storage })
    expect(store.getState()).toMatchObject(DEFAULT_SETTINGS)
  })

  it('keeps the valid fields of partly invalid data', () => {
    const storage = memoryStorage(saved({ catalogMode: 'all', theme: 'neon' }))
    const store = createSettingsStore({ storage: () => storage })
    expect(store.getState()).toMatchObject({ catalogMode: 'all', theme: 'dark' })
  })

  it('sanitizes data saved by another version instead of discarding it', () => {
    const storage = memoryStorage(saved({ catalogMode: 'all', theme: 'system', legacy: true }, 0))
    const store = createSettingsStore({ storage: () => storage })
    expect(store.getState()).toMatchObject({ catalogMode: 'all', theme: 'system' })
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toEqual({
      state: { catalogMode: 'all', theme: 'system' },
      version: 1,
    })
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
      const store = createSettingsStore({ storage })
      expect(store.getState()).toMatchObject(DEFAULT_SETTINGS)
      expect(() => store.getState().setCatalogMode('all')).not.toThrow()
      expect(store.getState().catalogMode).toBe('all')
    }
  })

  it('picks up changes made in another tab', () => {
    const storage = memoryStorage()
    const store = createSettingsStore({ storage: () => storage })
    const stop = syncSettingsAcrossTabs(store)

    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { catalogMode: 'all', theme: 'light' }, version: 1 }),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_STORAGE_KEY }))
    expect(store.getState()).toMatchObject({ catalogMode: 'all', theme: 'light' })

    stop()
  })
})
