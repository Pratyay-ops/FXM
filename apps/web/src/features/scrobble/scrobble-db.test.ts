import type { Scrobble } from '@fxm/sources/scrobble'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDexieScrobbleStore,
  openScrobbleDatabase,
  type ScrobbleDatabase,
} from './scrobble-db'

const T0 = Date.UTC(2026, 9, 26, 9)

function scrobble(n: number): Scrobble {
  return { track: { artists: ['Artist'], title: `Song ${n}` }, startedAt: T0 + n * 240_000 }
}

let opened: ScrobbleDatabase[] = []

function testStore() {
  const db = openScrobbleDatabase(`fxm-scrobble-test-${opened.length}-${Math.random()}`)
  opened.push(db)
  return createDexieScrobbleStore(db)
}

afterEach(async () => {
  await Promise.all(opened.map((db) => db.delete()))
  opened = []
})

describe('the IndexedDB scrobble store', () => {
  it('keeps one queue per service, first in, first out', async () => {
    const store = testStore()
    await store.add('lastfm', [scrobble(1), scrobble(2), scrobble(3)], 100)
    await store.add('listenbrainz', [scrobble(4)], 100)
    const front = await store.peek('lastfm', 2)
    expect(front.map((entry) => entry.scrobble)).toEqual([scrobble(1), scrobble(2)])
    expect(await store.count('lastfm')).toBe(3)
    expect(await store.count('listenbrainz')).toBe(1)
    await store.remove(front.map((entry) => entry.id))
    expect((await store.peek('lastfm', 10)).map((entry) => entry.scrobble)).toEqual([scrobble(3)])
    expect(await store.peek('lastfm', 0)).toEqual([])
  })

  it('drops the oldest entries of a queue beyond the limit, in the same transaction', async () => {
    const store = testStore()
    await store.add('lastfm', [scrobble(1), scrobble(2)], 3)
    await store.add('listenbrainz', [scrobble(9)], 3)
    expect(await store.add('lastfm', [scrobble(3), scrobble(4)], 3)).toBe(1)
    const kept = await store.peek('lastfm', 10)
    expect(kept.map((entry) => entry.scrobble)).toEqual([scrobble(2), scrobble(3), scrobble(4)])
    expect(await store.count('listenbrainz')).toBe(1)
  })

  it("empties one service's queue only", async () => {
    const store = testStore()
    await store.add('lastfm', [scrobble(1)], 10)
    await store.add('listenbrainz', [scrobble(2)], 10)
    await store.clear('lastfm')
    expect(await store.count('lastfm')).toBe(0)
    expect(await store.count('listenbrainz')).toBe(1)
  })

  it('shares one queue between stores on the same database, like tabs do', async () => {
    const name = `fxm-scrobble-shared-${Math.random()}`
    const first = openScrobbleDatabase(name)
    const second = openScrobbleDatabase(name)
    opened.push(first, second)
    const tab1 = createDexieScrobbleStore(first)
    const tab2 = createDexieScrobbleStore(second)
    await tab1.add('lastfm', [scrobble(1)], 10)
    await tab2.add('lastfm', [scrobble(2)], 10)
    const entries = await tab2.peek('lastfm', 10)
    expect(entries.map((entry) => entry.scrobble)).toEqual([scrobble(1), scrobble(2)])
    await tab1.remove([entries[0]?.id ?? -1])
    expect(await tab2.count('lastfm')).toBe(1)
  })
})
