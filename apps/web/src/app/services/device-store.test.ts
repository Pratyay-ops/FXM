import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import {
  createIndexedDbStore,
  createMemoryStore,
  DEVICE_DB_NAME,
  RUNG_HEALTH_KEY,
  rungHealthStore,
  VISITOR_DATA_KEY,
  visitorDataStore,
} from './device-store'

describe('createIndexedDbStore', () => {
  it('keeps values across stores on the same database, as across reloads', async () => {
    const factory = new IDBFactory()
    const first = createIndexedDbStore({ factory })
    await first.set('a', { rungs: ['visionos'] })
    await first.set('b', 'text')

    const second = createIndexedDbStore({ factory })

    await expect(second.get('a')).resolves.toEqual({ rungs: ['visionos'] })
    await expect(second.get('b')).resolves.toBe('text')
    await expect(second.get('c')).resolves.toBeUndefined()
  })

  it('forgets a value', async () => {
    const factory = new IDBFactory()
    const store = createIndexedDbStore({ factory })
    await store.set('a', 1)

    await store.delete('a')

    await expect(createIndexedDbStore({ factory }).get('a')).resolves.toBeUndefined()
  })

  it('names its database fxm-device, apart from the library', async () => {
    const factory = new IDBFactory()
    await createIndexedDbStore({ factory }).set('a', 1)

    const names = (await factory.databases()).map((database) => database.name)

    expect(names).toEqual([DEVICE_DB_NAME])
  })

  it('works from memory without IndexedDB', async () => {
    const store = createIndexedDbStore({ factory: undefined })

    await store.set('a', 1)

    await expect(store.get('a')).resolves.toBe(1)
  })

  it('works from memory when IndexedDB refuses to open', async () => {
    const factory = {
      open: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    } as unknown as IDBFactory
    const store = createIndexedDbStore({ factory })

    await store.set('a', 1)
    await store.delete('b')

    await expect(store.get('a')).resolves.toBe(1)
  })
})

describe('visitorDataStore', () => {
  it('loads, saves and clears the visitorData', async () => {
    const device = createMemoryStore()
    const store = visitorDataStore(device)

    await store.save('CgtGWE1fZml4dHVyZQ')
    await expect(store.load()).resolves.toBe('CgtGWE1fZml4dHVyZQ')
    expect(await device.get(VISITOR_DATA_KEY)).toBe('CgtGWE1fZml4dHVyZQ')

    await store.clear()
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('loads nothing but a string', async () => {
    const device = createMemoryStore()
    await device.set(VISITOR_DATA_KEY, { visitorData: 'x' })

    await expect(visitorDataStore(device).load()).resolves.toBeUndefined()
  })
})

describe('rungHealthStore', () => {
  it('keeps the state as it is, for the ladder to check', async () => {
    const device = createMemoryStore()
    const store = rungHealthStore(device)

    await store.save({ version: 1, scopes: {} })

    await expect(store.load()).resolves.toEqual({ version: 1, scopes: {} })
    expect(await device.get(RUNG_HEALTH_KEY)).toEqual({ version: 1, scopes: {} })
  })
})
