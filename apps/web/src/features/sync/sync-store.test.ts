import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { SyncReport } from './engine'
import {
  createSyncStore,
  isConnected,
  needsUser,
  SYNC_STORAGE_KEY,
  sanitizeSyncConfig,
  syncConfigAcrossTabs,
} from './sync-store'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'
const NEW_TOKEN = 'github_pat_22ABCDEFG0123456789_zyxwvutsrqponmlkjihgfedcba'
const GIST = 'aa5a315d61ae9438b18d0123456789ab'
const connection = {
  token: TOKEN,
  login: 'octo',
  gistId: GIST,
  gistUrl: `https://gist.github.com/octo/${GIST}`,
}

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    gistId: GIST,
    gistUrl: connection.gistUrl,
    created: false,
    pulled: 0,
    pushed: false,
    copies: [],
    notices: [],
    skipped: 0,
    bytes: 0,
    deferred: false,
    ...overrides,
  }
}

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

describe('sanitizeSyncConfig', () => {
  it('keeps a whole, valid connection', () => {
    const config = sanitizeSyncConfig({ ...connection, auto: false, lastSyncAt: 5 })
    expect(config).toMatchObject({ ...connection, auto: false, lastSyncAt: 5 })
    expect(isConnected(config)).toBe(true)
  })

  it('stays off without a whole, valid connection', () => {
    for (const broken of [
      { ...connection, token: 'not a token' },
      { ...connection, gistId: '../evil' },
      { ...connection, login: 'bad login!' },
      { token: TOKEN },
    ]) {
      const config = sanitizeSyncConfig(broken)
      expect(isConnected(config)).toBe(false)
      expect(config.token).toBeUndefined()
    }
    expect(sanitizeSyncConfig(null)).toEqual({ auto: true, notices: [] })
  })

  it('drops a gist link that isn’t a gist’s page, invalid notices and unknown problems', () => {
    const config = sanitizeSyncConfig({
      ...connection,
      gistUrl: 'https://evil.example/x',
      notices: [
        {
          id: '1',
          kind: 'kept-here',
          playlistId: formatId('local', 'playlist', 'p'),
          name: 'Mix',
          at: 1,
        },
        { id: '2', kind: 'odd', playlistId: 'x', name: 'Bad', at: 1 },
      ],
      problem: { code: 'nonsense', at: 1 },
    })
    expect(config.gistUrl).toBeUndefined()
    expect(config.notices.map((notice) => notice.id)).toEqual(['1'])
    expect(config.problem).toBeUndefined()
  })
})

describe('the sync store', () => {
  it('remembers the connection in localStorage, and forgets it when sync is turned off', () => {
    const storage = memoryStorage()
    const store = createSyncStore({ storage: () => storage })
    store.getState().connect(connection)
    expect(JSON.parse(storage.getItem(SYNC_STORAGE_KEY) ?? '{}').state).toMatchObject(connection)

    store.getState().disconnect()
    const stored = JSON.parse(storage.getItem(SYNC_STORAGE_KEY) ?? '{}').state
    expect(stored).not.toHaveProperty('token')
    expect(stored).not.toHaveProperty('gistId')
    expect(isConnected(store.getState())).toBe(false)
  })

  it('records a sync: the time, the notices, newest first, and no problem', () => {
    const store = createSyncStore({ storage: () => memoryStorage() })
    store.getState().connect(connection)
    store.getState().failed({ code: 'network', at: 1 })
    const playlistId = formatId('local', 'playlist', 'p')
    store
      .getState()
      .succeeded(report({ notices: [{ kind: 'kept-here', playlistId, name: 'A' }] }), 10)
    store
      .getState()
      .succeeded(report({ notices: [{ kind: 'restored', playlistId, name: 'B' }] }), 20)
    const state = store.getState()
    expect(state.problem).toBeUndefined()
    expect(state.lastSyncAt).toBe(20)
    expect(state.notices.map((notice) => notice.name)).toEqual(['B', 'A'])
    state.dismissNotice(state.notices[0]?.id ?? '')
    expect(store.getState().notices.map((notice) => notice.name)).toEqual(['A'])
  })

  it('follows another tab’s change', async () => {
    const store = createSyncStore()
    const stop = syncConfigAcrossTabs(store)
    localStorage.setItem(
      SYNC_STORAGE_KEY,
      JSON.stringify({ state: { ...connection, auto: true, notices: [] }, version: 1 }),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: SYNC_STORAGE_KEY }))
    await Promise.resolve()
    expect(store.getState().login).toBe('octo')
    stop()
  })

  /** Two tabs of the app on one localStorage. */
  async function twoTabs() {
    const storage = memoryStorage()
    const a = createSyncStore({ storage: () => storage })
    const b = createSyncStore({ storage: () => storage })
    a.getState().connect(connection)
    await b.persist.rehydrate()
    return { storage, a, b }
  }

  it('follows another tab turning sync off, and never brings the token back', async () => {
    const { storage, a, b } = await twoTabs()
    expect(b.getState().token).toBe(TOKEN)
    a.getState().disconnect()
    await b.persist.rehydrate()
    expect(b.getState()).toMatchObject({ token: undefined, login: undefined, gistId: undefined })
    expect(isConnected(b.getState())).toBe(false)
    // The other tab's next write keeps it off.
    b.getState().started()
    expect(storage.getItem(SYNC_STORAGE_KEY) ?? '').not.toContain(TOKEN)
  })

  it('follows another tab clearing a problem', async () => {
    const { a, b } = await twoTabs()
    a.getState().failed({ code: 'unauthorized', at: 1 })
    await b.persist.rehydrate()
    expect(b.getState().problem?.code).toBe('unauthorized')
    a.getState().replaceToken(NEW_TOKEN)
    await b.persist.rehydrate()
    expect(b.getState().problem).toBeUndefined()
    expect(b.getState().token).toBe(NEW_TOKEN)
    b.getState().idle()
    expect(a.getState().problem).toBeUndefined()
  })

  it('keeps what a sync would remove with its problem', () => {
    const store = createSyncStore({ storage: () => memoryStorage() })
    const removed = { playlists: 3, likes: 0, follows: 0, plays: 0 }
    store.getState().failed({ code: 'removals', at: 1, removed })
    expect(sanitizeSyncConfig(JSON.parse(JSON.stringify(store.getState()))).problem).toEqual({
      code: 'removals',
      at: 1,
      removed,
    })
    expect(
      sanitizeSyncConfig({ problem: { code: 'removals', at: 1, removed: { playlists: -1 } } })
        .problem,
    ).toEqual({ code: 'removals', at: 1 })
  })
})

describe('needsUser', () => {
  it('stops automatic sync only for what the user must fix', () => {
    expect(needsUser('unauthorized')).toBe(true)
    expect(needsUser('gone')).toBe(true)
    expect(needsUser('public')).toBe(true)
    expect(needsUser('removals')).toBe(true)
    expect(needsUser('network')).toBe(false)
    expect(needsUser('rate-limited')).toBe(false)
  })
})
