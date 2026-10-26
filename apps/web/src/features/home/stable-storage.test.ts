import { formatId, type StableShelves } from '@fxm/core'
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

const kept: StableShelves = {
  entries: [
    {
      kind: 'discover',
      mode: 'music',
      period: '2026-W44',
      items: [
        {
          track: {
            id: formatId('ytm', 'track', 'v1'),
            source: 'ytm',
            title: 'Copper Sun',
            artists: [{ name: 'Aurora Lane' }],
            artwork: [],
            kind: 'song',
          },
          score: 1,
          familiar: false,
        },
      ],
    },
  ],
}

describe('the stable store', () => {
  it('keeps what a build hands it, and reads garbage as nothing kept', () => {
    const storage = memoryStorage()
    const store = createStableStore(() => storage)
    expect(store.load(1000)).toEqual({ entries: [] })
    store.save(kept, 1000)
    expect(store.load(1000)).toEqual(kept)
    store.save({ entries: [] }, 1000)
    expect(storage.items.has(STABLE_STORAGE_KEY)).toBe(false)
    storage.items.set(STABLE_STORAGE_KEY, '{not json')
    expect(store.load(1000)).toEqual({ entries: [] })
  })

  it('keeps lists only for the listening history they were built from', () => {
    const storage = memoryStorage()
    const store = createStableStore(() => storage)
    store.save(kept, 1000)
    // The history was cleared, replaced or got older plays: its start moved.
    expect(store.load(null)).toEqual({ entries: [] })
    expect(store.load(500)).toEqual({ entries: [] })
    expect(store.load(1000)).toEqual(kept)
    // Lists made before there were any plays count for an empty history only.
    store.save(kept, null)
    expect(store.load(null)).toEqual(kept)
    expect(store.load(1000)).toEqual({ entries: [] })
    // Lists stored without their history are out of date.
    storage.items.set(STABLE_STORAGE_KEY, JSON.stringify(kept))
    expect(store.load(null)).toEqual({ entries: [] })
  })

  it('never throws when storage is blocked', () => {
    const store = createStableStore(() => {
      throw new Error('SecurityError')
    })
    expect(store.load(null)).toEqual({ entries: [] })
    expect(() => store.save(kept, null)).not.toThrow()
  })
})
