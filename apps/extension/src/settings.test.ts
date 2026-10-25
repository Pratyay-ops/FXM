import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, indexedDbSettings, SETTINGS_DATABASE } from './settings.ts'

/** Stores raw values in the settings database, as a buggy or older writer might. */
async function storeRaw(factory: IDBFactory, values: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SETTINGS_DATABASE.name, SETTINGS_DATABASE.version)
    request.onupgradeneeded = () => request.result.createObjectStore(SETTINGS_DATABASE.store)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = db.transaction(SETTINGS_DATABASE.store, 'readwrite')
  for (const [key, value] of Object.entries(values)) {
    transaction.objectStore(SETTINGS_DATABASE.store).put(value, key)
  }
  await new Promise((resolve) => {
    transaction.oncomplete = resolve
  })
  db.close()
}

describe('settings in IndexedDB', () => {
  it('are off by default', async () => {
    expect(await indexedDbSettings(new IDBFactory()).read()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toEqual({ spotifyLogin: false })
  })

  it('round-trip and survive a restarted background', async () => {
    const factory = new IDBFactory()
    await indexedDbSettings(factory).write({ spotifyLogin: true })
    // A new store on the same database, as after the service worker restarts.
    const restarted = indexedDbSettings(factory)
    expect(await restarted.read()).toEqual({ spotifyLogin: true })
    await restarted.write({})
    expect(await restarted.read()).toEqual({ spotifyLogin: true })
    await restarted.write({ spotifyLogin: false })
    expect(await restarted.read()).toEqual({ spotifyLogin: false })
  })

  it('read anything but true as off', async () => {
    for (const value of ['true', 1, {}, null]) {
      const factory = new IDBFactory()
      await storeRaw(factory, { spotifyLogin: value })
      expect(await indexedDbSettings(factory).read()).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('ignore keys it does not know', async () => {
    const factory = new IDBFactory()
    await indexedDbSettings(factory).write({ spotifyLogin: true, other: true } as never)
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = factory.open(SETTINGS_DATABASE.name)
      request.onsuccess = () => {
        const all = request.result
          .transaction(SETTINGS_DATABASE.store)
          .objectStore(SETTINGS_DATABASE.store)
          .getAllKeys()
        all.onsuccess = () => {
          request.result.close()
          resolve(all.result)
        }
      }
      request.onerror = () => reject(request.error)
    })
    expect(keys).toEqual(['spotifyLogin'])
  })

  it('reject when the database cannot be opened', async () => {
    const factory = new IDBFactory()
    // A newer version on disk (say, after a downgrade) makes open() fail with VersionError.
    await new Promise<void>((resolve) => {
      const request = factory.open(SETTINGS_DATABASE.name, SETTINGS_DATABASE.version + 1)
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
    })
    await expect(indexedDbSettings(factory).read()).rejects.toThrow()
  })
})
