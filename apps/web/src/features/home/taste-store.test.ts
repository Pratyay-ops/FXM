import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  cleanPicks,
  createTasteStore,
  MAX_PICKED_ARTISTS,
  sanitizeTaste,
  TASTE_STORAGE_KEY,
} from './taste-store'

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  } as unknown as Storage & { items: Map<string, string> }
}

describe('cleanPicks', () => {
  it('trims names, keeps each once whatever its case, and keeps only artist IDs', () => {
    const id = formatId('ytm', 'artist', 'UCa')
    expect(
      cleanPicks({
        artists: [
          { name: '  Aurora   Lane ', id },
          { name: 'aurora lane' },
          { name: 'Basalt', id: formatId('ytm', 'track', 'x') },
          { name: '' },
          'Cinder',
          null,
        ],
        genres: ['Pop', 'pop', ' Jazz ', 7],
      }),
    ).toEqual({
      artists: [{ name: 'Aurora Lane', id }, { name: 'Basalt' }],
      genres: ['Pop', 'Jazz'],
    })
  })

  it('keeps at most so many artists', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ name: `Artist ${index}` }))
    expect(cleanPicks({ artists: many }).artists).toHaveLength(MAX_PICKED_ARTISTS)
  })
})

describe('sanitizeTaste', () => {
  it('keeps valid picks and dismissals, and drops everything else', () => {
    expect(
      sanitizeTaste({
        picks: { artists: [{ name: 'Basalt' }], genres: [], at: 5 },
        dismissedAt: 9,
      }),
    ).toEqual({
      picks: { artists: [{ name: 'Basalt' }], genres: [], at: 5 },
      dismissedAt: 9,
    })
    expect(sanitizeTaste({ picks: { artists: [], genres: [], at: 5 } })).toEqual({})
    expect(
      sanitizeTaste({ picks: { artists: [{ name: 'Basalt' }], at: 'x' }, dismissedAt: -1 }),
    ).toEqual({})
    expect(sanitizeTaste('nope')).toEqual({})
  })
})

describe('the taste store', () => {
  it('saves picks, dismisses and reopens, and persists them', () => {
    const storage = memoryStorage()
    const store = createTasteStore(() => storage)
    store
      .getState()
      .savePicks({ artists: [{ name: 'Basalt' }, { name: 'basalt' }], genres: ['Jazz'] }, 42)
    expect(store.getState().picks).toEqual({
      artists: [{ name: 'Basalt' }],
      genres: ['Jazz'],
      at: 42,
    })
    store.getState().dismiss(50)
    expect(store.getState().dismissedAt).toBe(50)
    store.getState().reopen()
    expect(store.getState().dismissedAt).toBeUndefined()
    expect(JSON.parse(storage.items.get(TASTE_STORAGE_KEY) ?? '{}').state).toEqual({
      picks: { artists: [{ name: 'Basalt' }], genres: ['Jazz'], at: 42 },
    })
  })

  it('reads stored picks back, and ignores corrupt ones', () => {
    const good = createTasteStore(() =>
      memoryStorage({
        [TASTE_STORAGE_KEY]: JSON.stringify({
          state: { picks: { artists: [{ name: 'Basalt' }], genres: [], at: 7 } },
          version: 1,
        }),
      }),
    )
    expect(good.getState().picks?.artists).toEqual([{ name: 'Basalt' }])
    const bad = createTasteStore(() =>
      memoryStorage({ [TASTE_STORAGE_KEY]: JSON.stringify({ state: { picks: 'x' }, version: 1 }) }),
    )
    expect(bad.getState().picks).toBeUndefined()
  })
})
