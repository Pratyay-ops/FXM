import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateStorage, isStoragePersisted, requestStoragePersistence } from './persistence'

/** happy-dom has no `navigator.storage`: give it one for a test. */
function stubStorage(storage: Partial<StorageManager> | undefined) {
  Object.defineProperty(navigator, 'storage', { value: storage, configurable: true })
}

afterEach(() => {
  delete (navigator as { storage?: unknown }).storage
})

describe('storage settings', () => {
  it('report how much room there is', async () => {
    stubStorage({ estimate: async () => ({ usage: 10, quota: 100 }) })
    expect(await estimateStorage()).toEqual({ usage: 10, quota: 100 })
    stubStorage({ estimate: async () => ({ usage: 10 }) })
    expect(await estimateStorage()).toBeUndefined()
    stubStorage({ estimate: () => Promise.reject(new Error('no')) })
    expect(await estimateStorage()).toBeUndefined()
  })

  it('report and request persistence', async () => {
    const persist = vi.fn(async () => true)
    stubStorage({ persisted: async () => false, persist })
    expect(await isStoragePersisted()).toBe(false)
    expect(await requestStoragePersistence()).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    stubStorage({
      persisted: () => Promise.reject(new Error('no')),
      persist: () => Promise.reject(new Error('no')),
    })
    expect(await isStoragePersisted()).toBeUndefined()
    expect(await requestStoragePersistence()).toBeUndefined()
  })

  it('stay quiet where the browser has none', async () => {
    stubStorage(undefined)
    expect(await estimateStorage()).toBeUndefined()
    expect(await isStoragePersisted()).toBeUndefined()
    expect(await requestStoragePersistence()).toBeUndefined()
  })
})
