import { MATCHING_CONFIG } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  appAutoMatch,
  appMatchOptions,
  autoMatchOffered,
  createMatchingStore,
  MATCHING_STORAGE_KEY,
  sanitizeMatchingSettings,
} from './matching-store'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}

const AVAILABLE = { ...MATCHING_CONFIG, auto: true }

describe('the Auto setting', () => {
  it('is off, and not offered, while the matching config keeps the band off', () => {
    const store = createMatchingStore({ storage: () => memoryStorage() })
    store.getState().setAutoMatch(true)

    expect(MATCHING_CONFIG.auto).toBe(false)
    expect(autoMatchOffered()).toBe(false)
    // A value stored by a build that offered it never lets a guess play unasked here.
    expect(appAutoMatch(store)).toBe(false)
    expect(appMatchOptions('music', store)).toEqual({ mode: 'music' })
  })

  it('counts where the config makes the band available, with its thresholds and fallback', () => {
    const store = createMatchingStore({ storage: () => memoryStorage() })
    const config = { ...AVAILABLE, requireReleaseAgreement: true, thresholds: { auto: 0.9 } }

    expect(autoMatchOffered(config)).toBe(true)
    expect(appAutoMatch(store, config)).toBe(false)
    store.getState().setAutoMatch(true)
    expect(appAutoMatch(store, config)).toBe(true)
    expect(appMatchOptions('all', store, config)).toEqual({
      auto: true,
      mode: 'all',
      requireReleaseAgreement: true,
      thresholds: { auto: 0.9 },
    })
  })

  it('reads only a stored true as on', () => {
    expect(sanitizeMatchingSettings({ autoMatch: 'true' })).toEqual({ autoMatch: false })
    expect(sanitizeMatchingSettings(null)).toEqual({ autoMatch: false })
    const storage = memoryStorage({
      [MATCHING_STORAGE_KEY]: JSON.stringify({ state: { autoMatch: true }, version: 1 }),
    })
    expect(createMatchingStore({ storage: () => storage }).getState().autoMatch).toBe(true)
  })
})
