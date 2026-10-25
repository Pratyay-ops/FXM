import { describe, expect, it } from 'vitest'
import { creepScrobble, T0 } from './fixtures/testing'
import { createMemoryScrobbleStore } from './store'

describe('createMemoryScrobbleStore', () => {
  const scrobbles = [0, 1, 2, 3].map((n) => creepScrobble(T0 + n * 240_000))

  it('keeps one queue per service, first in, first out', async () => {
    const store = createMemoryScrobbleStore()
    expect(await store.add('lastfm', scrobbles.slice(0, 3), 10)).toBe(0)
    await store.add('listenbrainz', scrobbles.slice(3), 10)
    const front = await store.peek('lastfm', 2)
    expect(front.map((entry) => entry.scrobble)).toEqual(scrobbles.slice(0, 2))
    expect(front[0]?.id).toBeLessThan(front[1]?.id ?? 0)
    expect(await store.count('lastfm')).toBe(3)
    expect(await store.count('listenbrainz')).toBe(1)
    await store.remove(front.map((entry) => entry.id))
    expect((await store.peek('lastfm', 10)).map((entry) => entry.scrobble)).toEqual([scrobbles[2]])
  })

  it('drops the oldest entries beyond the limit and says how many', async () => {
    const store = createMemoryScrobbleStore()
    await store.add('lastfm', scrobbles.slice(0, 2), 3)
    expect(await store.add('lastfm', scrobbles.slice(2), 3)).toBe(1)
    const kept = await store.peek('lastfm', 10)
    expect(kept.map((entry) => entry.scrobble)).toEqual(scrobbles.slice(1))
  })

  it('stores copies, so later changes to a scrobble never reach the queue', async () => {
    const store = createMemoryScrobbleStore()
    const scrobble = creepScrobble()
    await store.add('lastfm', [scrobble], 10)
    scrobble.track.title = 'Changed'
    const [entry] = await store.peek('lastfm', 1)
    expect(entry?.scrobble).toEqual(creepScrobble())
  })

  it('empties one queue and skips IDs that are gone', async () => {
    const store = createMemoryScrobbleStore()
    await store.add('lastfm', scrobbles, 10)
    await store.add('listenbrainz', scrobbles, 10)
    await store.clear('lastfm')
    await store.remove([999])
    expect(await store.count('lastfm')).toBe(0)
    expect(await store.count('listenbrainz')).toBe(4)
    expect(await store.peek('lastfm', 0)).toEqual([])
  })
})
