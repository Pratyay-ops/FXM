import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createStableStore, STABLE_STORAGE_KEY } from './stable-storage'

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  } as unknown as Storage & { items: Map<string, string> }
}

describe('the stable store', () => {
  it('keeps what a build hands it, and reads garbage as nothing kept', () => {
    const storage = memoryStorage()
    const store = createStableStore(() => storage)
    expect(store.load()).toEqual({ entries: [] })
    const entry = {
      kind: 'discover' as const,
      mode: 'music' as const,
      period: '2026-W44',
      items: [
        {
          track: {
            id: formatId('ytm', 'track', 'v1'),
            source: 'ytm' as const,
            title: 'Copper Sun',
            artists: [{ name: 'Aurora Lane' }],
            artwork: [],
            kind: 'song' as const,
          },
          score: 1,
          familiar: false,
        },
      ],
    }
    store.save({ entries: [entry] })
    expect(store.load()).toEqual({ entries: [entry] })
    store.save({ entries: [] })
    expect(storage.items.has(STABLE_STORAGE_KEY)).toBe(false)
    storage.items.set(STABLE_STORAGE_KEY, '{not json')
    expect(store.load()).toEqual({ entries: [] })
  })

  it('never throws when storage is blocked', () => {
    const store = createStableStore(() => {
      throw new Error('SecurityError')
    })
    expect(store.load()).toEqual({ entries: [] })
    expect(() => store.save({ entries: [] })).not.toThrow()
  })
})
