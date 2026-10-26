import { Dexie } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { BASE_VERSION, createIndexedDbBaseStore, readBase, type SyncBase } from './base-store'
import { snapshotFingerprint } from './snapshot'
import { like, playlist, snap } from './testing/snapshots'

function base(overrides: Partial<SyncBase> = {}): SyncBase {
  const snapshot = snap({ likes: [like(1)], playlists: [playlist('Mix', [1, 2])] })
  return {
    version: BASE_VERSION,
    gistId: 'aa5a315d61ae9438b18d0123456789ab',
    revision: '0011223344556677',
    ancestors: ['8899aabbccddeeff'],
    snapshot,
    fingerprint: snapshotFingerprint(snapshot),
    parts: [
      {
        file: 'fxm-likes-0of1-0123456789abcd.json',
        table: 'likes',
        rows: 1,
        bytes: 100,
        hash: '0123456789abcd',
      },
    ],
    previous: [],
    files: ['fxm-library-sync.json', 'fxm-likes-0of1-0123456789abcd.json'],
    strays: { 'fxm-likes-0of1-ffffffffffffff.json': 5 },
    etag: 'W/"abc"',
    savedAt: 1000,
    ...overrides,
  }
}

const names: string[] = []
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name)
})

function store() {
  const name = `fxm-sync-test-${Math.random()}`
  names.push(name)
  return createIndexedDbBaseStore(name)
}

describe('createIndexedDbBaseStore', () => {
  it('keeps a base per gist, and forgets one or all of them', async () => {
    const bases = store()
    const one = base()
    const two = base({ gistId: 'bb5a315d61ae9438b18d0123456789ab' })
    await bases.put(one)
    await bases.put(two)
    expect(await bases.get(one.gistId)).toEqual(one)
    await bases.delete(one.gistId)
    expect(await bases.get(one.gistId)).toBeUndefined()
    expect(await bases.get(two.gistId)).toEqual(two)
    await bases.clear()
    expect(await bases.get(two.gistId)).toBeUndefined()
    bases.close()
  })

  it('drops a base it can’t read, so the next sync is a first sync', async () => {
    const bases = store()
    const damaged = { ...base(), snapshot: { ...base().snapshot, history: {} } }
    await bases.put(damaged as unknown as SyncBase)
    expect(await bases.get(damaged.gistId)).toBeUndefined()
    // It is gone, not read again and again.
    const raw = new Dexie(names[0] ?? '')
    raw.version(1).stores({ bases: 'gistId' })
    expect(await raw.table('bases').count()).toBe(0)
    raw.close()
    bases.close()
  })
})

describe('readBase', () => {
  it('reads a base back as it was saved', () => {
    expect(readBase(structuredClone(base()))).toEqual(base())
  })

  it('refuses a base of another version, or without the shape of one', () => {
    expect(readBase(undefined)).toBeUndefined()
    expect(readBase({ ...base(), version: BASE_VERSION + 1 })).toBeUndefined()
    const { version: _version, ...unversioned } = base()
    expect(readBase(unversioned)).toBeUndefined()
    expect(readBase({ ...base(), ancestors: 'x' })).toBeUndefined()
    expect(readBase({ ...base(), parts: [{ file: '../x' }] })).toBeUndefined()
    expect(readBase({ ...base(), strays: { 'notes.md': 1 } })).toBeUndefined()
    expect(readBase({ ...base(), snapshot: { ...base().snapshot, likes: null } })).toBeUndefined()
  })

  it('cleans the snapshot with the library’s guards, as a gist’s', () => {
    const stored = base()
    const read = readBase({
      ...stored,
      snapshot: { ...stored.snapshot, likes: [...stored.snapshot.likes, { key: 'bad' }] },
    })
    expect(read?.snapshot).toEqual(stored.snapshot)
    expect(read?.fingerprint).toBe(stored.fingerprint)
  })
})
