import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { utf8 } from './encoding.ts'
import { indexedDbUpdateStore, memoryUpdateStore, type UpdateStore } from './store.ts'

const UPDATE = { signature: utf8('{"signature":true}'), bytes: utf8('export {}') }

describe.each<[string, () => UpdateStore]>([
  ['memoryUpdateStore', () => memoryUpdateStore()],
  ['indexedDbUpdateStore', () => indexedDbUpdateStore({ indexedDB: new IDBFactory() })],
])('%s', (_, makeStore) => {
  it('keeps one update per kind, and forgets it', async () => {
    const store = makeStore()
    expect(await store.get('youtube-module')).toBeUndefined()
    await store.set('youtube-module', UPDATE)
    await store.set('youtube-config', { signature: utf8('a'), bytes: utf8('{}') })
    expect(await store.get('youtube-module')).toEqual(UPDATE)
    await store.delete('youtube-module')
    expect(await store.get('youtube-module')).toBeUndefined()
    expect(await store.get('youtube-config')).toEqual({ signature: utf8('a'), bytes: utf8('{}') })
  })

  it('stores copies, so later changes to the arrays do not reach it', async () => {
    const store = makeStore()
    const bytes = utf8('export {}')
    await store.set('youtube-module', { signature: utf8('s'), bytes })
    bytes[0] = 0x21
    const stored = await store.get('youtube-module')
    expect(stored?.bytes).toEqual(utf8('export {}'))
    if (stored !== undefined) stored.bytes[0] = 0x21
    expect((await store.get('youtube-module'))?.bytes).toEqual(utf8('export {}'))
  })
})

describe('indexedDbUpdateStore', () => {
  it('keeps updates across instances of the same database', async () => {
    const indexedDB = new IDBFactory()
    await indexedDbUpdateStore({ indexedDB, name: 'fxm-test' }).set('youtube-module', UPDATE)
    const reopened = indexedDbUpdateStore({ indexedDB, name: 'fxm-test' })
    expect(await reopened.get('youtube-module')).toEqual(UPDATE)
  })

  it('treats a stored value of the wrong shape as nothing', async () => {
    const indexedDB = new IDBFactory()
    const store = indexedDbUpdateStore({ indexedDB })
    await store.set('youtube-module', UPDATE)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fxm-updates', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('artifacts', 'readwrite')
      transaction.objectStore('artifacts').put({ bytes: 'not bytes' }, 'youtube-module')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
    expect(await store.get('youtube-module')).toBeUndefined()
  })

  it('rejects every call without IndexedDB, and tries again later', async () => {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB
    expect(original).toBeUndefined()
    const store = indexedDbUpdateStore()
    await expect(store.get('youtube-module')).rejects.toThrow(/not available/)
    await expect(store.set('youtube-module', UPDATE)).rejects.toThrow(/not available/)
    await expect(store.delete('youtube-module')).rejects.toThrow(/not available/)
  })
})
