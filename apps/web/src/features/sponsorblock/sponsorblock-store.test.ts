import { describe, expect, it } from 'vitest'
import {
  createSponsorBlockStore,
  SPONSORBLOCK_STORAGE_KEY,
  sanitizeSponsorBlock,
  syncSponsorBlockAcrossTabs,
} from './sponsorblock-store'

/** An in-memory Web Storage. */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(entries))
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

const saved = (state: unknown) => ({
  [SPONSORBLOCK_STORAGE_KEY]: JSON.stringify({ state, version: 1 }),
})

describe('SponsorBlock store', () => {
  it('starts off, with the offer not yet answered', () => {
    const store = createSponsorBlockStore({ storage: () => memoryStorage() })
    expect(store.getState()).toMatchObject({ enabled: false, offered: false })
  })

  it('counts setting the switch as answering the offer', () => {
    const store = createSponsorBlockStore({ storage: () => memoryStorage() })
    store.getState().setEnabled(true)
    expect(store.getState()).toMatchObject({ enabled: true, offered: true })
    store.getState().setEnabled(false)
    expect(store.getState()).toMatchObject({ enabled: false, offered: true })
  })

  it('keeps skipping off when the offer is dismissed', () => {
    const store = createSponsorBlockStore({ storage: () => memoryStorage() })
    store.getState().dismissOffer()
    expect(store.getState()).toMatchObject({ enabled: false, offered: true })
  })

  it('persists under its own versioned key and restores it after a reload', () => {
    const storage = memoryStorage()
    createSponsorBlockStore({ storage: () => storage })
      .getState()
      .setEnabled(true)
    expect(JSON.parse(storage.getItem(SPONSORBLOCK_STORAGE_KEY) ?? 'null')).toEqual({
      state: { enabled: true, offered: true },
      version: 1,
    })
    const afterReload = createSponsorBlockStore({ storage: () => storage })
    expect(afterReload.getState()).toMatchObject({ enabled: true, offered: true })
  })

  it.each([
    ['corrupt JSON', '{"state": {"enabled": '],
    ['an array', '[true]'],
    [
      'values that are not true',
      JSON.stringify({ state: { enabled: 'yes', offered: 1 }, version: 1 }),
    ],
  ])('stays off when storage holds %s', (_, raw) => {
    const store = createSponsorBlockStore({
      storage: () => memoryStorage({ [SPONSORBLOCK_STORAGE_KEY]: raw }),
    })
    expect(store.getState()).toMatchObject({ enabled: false, offered: false })
  })

  it('counts skipping that is on as answered', () => {
    expect(sanitizeSponsorBlock({ enabled: true, offered: false })).toEqual({
      enabled: true,
      offered: true,
    })
    const store = createSponsorBlockStore({
      storage: () => memoryStorage(saved({ enabled: true })),
    })
    expect(store.getState()).toMatchObject({ enabled: true, offered: true })
  })

  it('follows changes made in another tab', async () => {
    const storage = memoryStorage()
    const store = createSponsorBlockStore({ storage: () => storage })
    const stop = syncSponsorBlockAcrossTabs(store)

    createSponsorBlockStore({ storage: () => storage })
      .getState()
      .setEnabled(true)
    window.dispatchEvent(new StorageEvent('storage', { key: SPONSORBLOCK_STORAGE_KEY }))
    await Promise.resolve()
    expect(store.getState().enabled).toBe(true)

    stop()
    createSponsorBlockStore({ storage: () => storage })
      .getState()
      .setEnabled(false)
    window.dispatchEvent(new StorageEvent('storage', { key: SPONSORBLOCK_STORAGE_KEY }))
    await Promise.resolve()
    expect(store.getState().enabled).toBe(true)
  })
})
