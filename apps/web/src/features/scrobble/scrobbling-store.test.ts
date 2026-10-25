import { isLastfmKey, isListenBrainzToken } from '@fxm/sources/scrobble'
import { describe, expect, it } from 'vitest'
import {
  createScrobblingStore,
  credentialOf,
  SCROBBLING_STORAGE_KEY,
  sanitizeScrobblingAccounts,
  syncScrobblingAcrossTabs,
} from './scrobbling-store'

const TOKEN = '00000000-0000-4000-8000-000000000000'
const LASTFM = {
  apiKey: '0123456789abcdef0123456789abcdef',
  secret: 'fedcba9876543210fedcba9876543210',
  sessionKey: 'd580d57f32848f5dcf574d1ce18d78b2',
  userName: 'someone',
}

/** A store on a Web Storage of its own. */
function testStore(storage: Storage = memoryStorage()) {
  return { store: createScrobblingStore({ storage: () => storage }), storage }
}

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key)
    },
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}

function stored(storage: Storage): unknown {
  return JSON.parse(storage.getItem(SCROBBLING_STORAGE_KEY) ?? 'null')
}

describe('the scrobbling store', () => {
  it('connects nothing until the user does', () => {
    const { store } = testStore()
    expect(store.getState().listenbrainz).toBeUndefined()
    expect(store.getState().lastfm).toBeUndefined()
  })

  it('keeps the accounts on this device, and forgets one on disconnect', () => {
    const { store, storage } = testStore()
    store.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    store.getState().connectLastfm(LASTFM)
    expect(stored(storage)).toMatchObject({
      state: { listenbrainz: { token: TOKEN, userName: 'someone' }, lastfm: LASTFM },
    })
    store.getState().disconnect('listenbrainz')
    expect(store.getState()).not.toHaveProperty('listenbrainz')
    expect(stored(storage)).toEqual({ state: { lastfm: LASTFM }, version: 1 })
    // The actions survive disconnecting.
    store.getState().disconnect('lastfm')
    expect(typeof store.getState().connectLastfm).toBe('function')
  })

  it('marks a refusal only while the refused credential is still the connected one', () => {
    const { store } = testStore()
    store.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    store.getState().markRefused('listenbrainz', 'an-older-token', 1000)
    expect(store.getState().listenbrainz?.refusedAt).toBeUndefined()
    store.getState().markRefused('listenbrainz', TOKEN, 1000)
    expect(store.getState().listenbrainz?.refusedAt).toBe(1000)
    store.getState().markRefused('lastfm', LASTFM.sessionKey, 2000)
    expect(store.getState().lastfm).toBeUndefined()
    // Connecting again clears it.
    store.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    expect(store.getState().listenbrainz).not.toHaveProperty('refusedAt')
  })

  it('reads back what it stored, and only what is valid', () => {
    const storage = memoryStorage()
    storage.setItem(
      SCROBBLING_STORAGE_KEY,
      JSON.stringify({
        state: {
          listenbrainz: { token: 'has spaces in it', userName: 'x' },
          lastfm: { ...LASTFM, refusedAt: 5 },
        },
        version: 1,
      }),
    )
    const { store } = testStore(storage)
    expect(store.getState().listenbrainz).toBeUndefined()
    expect(store.getState().lastfm).toEqual({ ...LASTFM, refusedAt: 5 })
  })

  it('follows other tabs', async () => {
    const storage = memoryStorage()
    const { store } = testStore(storage)
    const stop = syncScrobblingAcrossTabs(store)
    const other = testStore(storage).store
    other.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    window.dispatchEvent(new StorageEvent('storage', { key: SCROBBLING_STORAGE_KEY }))
    await Promise.resolve()
    expect(store.getState().listenbrainz?.userName).toBe('someone')
    stop()
  })
})

describe('sanitizeScrobblingAccounts', () => {
  it('drops accounts with credentials that are not valid', () => {
    expect(sanitizeScrobblingAccounts(null)).toEqual({})
    expect(
      sanitizeScrobblingAccounts({
        listenbrainz: { token: TOKEN, userName: '  ' },
        lastfm: { ...LASTFM, apiKey: 'short' },
      }),
    ).toEqual({})
    expect(
      sanitizeScrobblingAccounts({ lastfm: { ...LASTFM, sessionKey: 'has space', refusedAt: -1 } }),
    ).toEqual({})
    expect(
      sanitizeScrobblingAccounts({ listenbrainz: { token: TOKEN, userName: 'a', refusedAt: 'x' } }),
    ).toEqual({ listenbrainz: { token: TOKEN, userName: 'a' } })
  })
})

describe('the credential checks', () => {
  it('accept what the scrobble clients accept, and refuse what they refuse', () => {
    const samples = [TOKEN, LASTFM.apiKey, LASTFM.apiKey.toUpperCase(), 'short', 'has space', '']
    for (const sample of [...samples, 'x'.repeat(128), 'x'.repeat(129)]) {
      const listenbrainz = sanitizeScrobblingAccounts({
        listenbrainz: { token: sample, userName: 'a' },
      }).listenbrainz
      expect(listenbrainz !== undefined, sample).toBe(isListenBrainzToken(sample))
      const lastfm = sanitizeScrobblingAccounts({
        lastfm: { ...LASTFM, apiKey: sample, secret: sample },
      }).lastfm
      expect(lastfm !== undefined, sample).toBe(isLastfmKey(sample))
    }
  })
})

describe('credentialOf', () => {
  it('is the ListenBrainz token or the Last.fm session key', () => {
    const accounts = { listenbrainz: { token: TOKEN, userName: 'a' }, lastfm: LASTFM }
    expect(credentialOf(accounts, 'listenbrainz')).toBe(TOKEN)
    expect(credentialOf(accounts, 'lastfm')).toBe(LASTFM.sessionKey)
    expect(credentialOf({}, 'lastfm')).toBeUndefined()
  })
})
