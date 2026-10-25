import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTracks } from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadSavedPlayback,
  MAX_SAVED_ITEMS,
  PLAYBACK_STORAGE_KEY,
  persistPlayback,
  QUEUE_STORAGE_KEY,
  queueToSave,
  restoredPosition,
} from './queue-storage'

/**
 * An in-memory Web Storage that counts writes per key. With a `quota`, it refuses values longer
 * than that, as a full localStorage does.
 */
function memoryStorage(entries: Record<string, string> = {}, quota = Number.POSITIVE_INFINITY) {
  const data = new Map(Object.entries(entries))
  const writes = new Map<string, number>()
  const storage: Storage = {
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
      if (value.length > quota) throw new DOMException('The quota has been exceeded.')
      writes.set(key, (writes.get(key) ?? 0) + 1)
      data.set(key, value)
    },
  }
  return { storage, writes, read: (key: string) => JSON.parse(data.get(key) ?? 'null') }
}

function setup(quota?: number) {
  const memory = memoryStorage({}, quota)
  const engine = new FakeEngine()
  const player = new Player({ engine, resolver: new FakeResolver(), stallTimeoutMs: 0 })
  const stop = persistPlayback(player, () => memory.storage, {
    queueDelayMs: 500,
    positionIntervalMs: 5000,
  })
  return { ...memory, engine, player, stop }
}

describe('saving the queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the queue once, shortly after a burst of changes', async () => {
    const { player, read, writes, stop } = setup()
    await player.setQueue(testTracks('a', 'b', 'c'), { autoplay: false })
    player.move(1, 2)
    player.setRepeat('all')
    expect(read(QUEUE_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(500)

    expect(writes.get(QUEUE_STORAGE_KEY)).toBe(1)
    const saved = read(QUEUE_STORAGE_KEY)
    expect(saved.items.map((item: { track: { title: string } }) => item.track.title)).toEqual([
      'a',
      'c',
      'b',
    ])
    expect(saved.repeat).toBe('all')
    stop()
  })

  it('writes the position on pauses and seeks, and only every few seconds while playing', async () => {
    const { engine, player, read, writes, stop } = setup()
    await player.setQueue(testTracks('a'))
    const before = writes.get(PLAYBACK_STORAGE_KEY) ?? 0
    for (let ms = 1000; ms <= 4000; ms += 1000) engine.progress(ms)
    expect(writes.get(PLAYBACK_STORAGE_KEY)).toBe(before)

    vi.advanceTimersByTime(5000)
    engine.progress(5000)
    expect(read(PLAYBACK_STORAGE_KEY)).toMatchObject({ positionMs: 5000 })

    player.seek(90_000)
    expect(read(PLAYBACK_STORAGE_KEY)).toMatchObject({ positionMs: 90_000 })

    engine.progress(91_000)
    player.pause()
    expect(read(PLAYBACK_STORAGE_KEY)).toEqual({
      positionMs: 91_000,
      uid: player.getState().queue.items[0]?.uid,
      volume: 1,
      muted: false,
    })
    stop()
  })

  it('removes the saved queue when storage is too full for the new one', async () => {
    // One item fits; eight don't.
    const { player, read, stop } = setup(600)
    await player.setQueue(testTracks('a'), { autoplay: false })
    vi.advanceTimersByTime(500)
    expect(read(QUEUE_STORAGE_KEY)?.items).toHaveLength(1)

    // Too long for the quota: the old queue must not come back after a reload.
    player.addToQueue(testTracks('b', 'c', 'd', 'e', 'f', 'g', 'h'))
    vi.advanceTimersByTime(500)

    expect(read(QUEUE_STORAGE_KEY)).toBeNull()
    expect(read(PLAYBACK_STORAGE_KEY)).toMatchObject({ uid: 0 })
    stop()
  })

  it('saves a long queue as a window around the current item', async () => {
    const { player, read, stop } = setup()
    const names = Array.from({ length: MAX_SAVED_ITEMS + 500 }, (_, index) => `t${index}`)
    await player.setQueue(testTracks(...names), { startIndex: 300, autoplay: false })
    vi.advanceTimersByTime(500)

    const saved = read(QUEUE_STORAGE_KEY)
    expect(saved.items).toHaveLength(MAX_SAVED_ITEMS)
    expect(saved.items[0].track.title).toBe('t200')
    expect(saved.items[saved.index].track.title).toBe('t300')
    stop()
  })

  it('saves the volume and mute as they change', () => {
    const { player, read, stop } = setup()
    player.setVolume(0.4)
    player.setMuted(true)
    expect(read(PLAYBACK_STORAGE_KEY)).toMatchObject({ volume: 0.4, muted: true })
    stop()
  })

  it('removes the saved queue when the queue empties', async () => {
    const { player, read, stop } = setup()
    await player.setQueue(testTracks('a'), { autoplay: false })
    vi.advanceTimersByTime(500)
    expect(read(QUEUE_STORAGE_KEY)).not.toBeNull()

    player.remove(0)
    vi.advanceTimersByTime(500)

    expect(read(QUEUE_STORAGE_KEY)).toBeNull()
    stop()
  })

  it('writes what is pending when the page is hidden', async () => {
    const { player, read, stop } = setup()
    await player.setQueue(testTracks('a', 'b'), { autoplay: false })

    window.dispatchEvent(new Event('pagehide'))

    expect(read(QUEUE_STORAGE_KEY)?.items).toHaveLength(2)
    stop()
  })

  it('stops writing once stopped, dropping a pending write', async () => {
    const { player, read, stop } = setup()
    await player.setQueue(testTracks('a'), { autoplay: false })
    stop()
    vi.advanceTimersByTime(1000)
    player.setVolume(0.2)
    expect(read(QUEUE_STORAGE_KEY)).toBeNull()
    expect(read(PLAYBACK_STORAGE_KEY)?.volume).not.toBe(0.2)
  })

  it('saves the start of the track once the queue has ended', async () => {
    const { engine, player, read, stop } = setup()
    await player.setQueue(testTracks('a'))
    engine.progress(170_000)
    engine.end()
    expect(player.getState().status).toBe('ended')
    expect(read(PLAYBACK_STORAGE_KEY)).toMatchObject({ positionMs: 0 })
    stop()
  })
})

describe('reading the saved queue', () => {
  it('returns the queue as stored, for the player to check', () => {
    const queue = { items: [], index: -1 }
    const { storage } = memoryStorage({
      [QUEUE_STORAGE_KEY]: JSON.stringify(queue),
      [PLAYBACK_STORAGE_KEY]: JSON.stringify({
        positionMs: 1234,
        uid: 2,
        volume: 0.5,
        muted: true,
      }),
    })
    expect(loadSavedPlayback(() => storage)).toEqual({
      queue,
      positionMs: 1234,
      uid: 2,
      volume: 0.5,
      muted: true,
    })
  })

  it('drops numbers that are out of range or of the wrong type', () => {
    const { storage } = memoryStorage({
      [PLAYBACK_STORAGE_KEY]: JSON.stringify({ positionMs: -3, uid: 1.5, volume: 2, muted: 'no' }),
    })
    expect(loadSavedPlayback(() => storage)).toEqual({ positionMs: 0 })
  })

  it('puts the position back only on its own item, inside the item', () => {
    const [track] = testTracks('a')
    if (track === undefined) throw new Error('no track')
    const item = { uid: 3, track }
    expect(restoredPosition({ positionMs: 42_000, uid: 3 }, item)).toBe(42_000)
    // Saved for another item (the queue was saved before the track changed), or for none.
    expect(restoredPosition({ positionMs: 42_000, uid: 4 }, item)).toBe(0)
    expect(restoredPosition({ positionMs: 42_000 }, item)).toBe(0)
    expect(restoredPosition({ positionMs: 42_000, uid: 3 }, undefined)).toBe(0)
    // Past the end of the track: its end.
    expect(restoredPosition({ positionMs: 10_000_000, uid: 3 }, item)).toBe(180_000)
  })
})

describe('the part of the queue that is saved', () => {
  it('is all of it while it is short', async () => {
    const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    await player.setQueue(testTracks('a', 'b'), { autoplay: false })
    const { queue } = player.getState()
    expect(queueToSave(queue)).toBe(queue)
  })

  it('is a window that keeps the current item, the shuffle order and the history', async () => {
    const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    const names = Array.from({ length: MAX_SAVED_ITEMS * 2 }, (_, index) => `t${index}`)
    await player.setQueue(testTracks(...names), { shuffle: true, autoplay: false })
    for (let skip = 0; skip < 150; skip++) await player.next()
    const { queue } = player.getState()

    const saved = queueToSave(queue)

    expect(saved.items).toHaveLength(MAX_SAVED_ITEMS)
    expect(saved.items[saved.index]).toBe(queue.items[queue.index])
    expect(saved.index).toBe(100)
    const uids = new Set(saved.items.map((item) => item.uid))
    expect(saved.playedUids.every((uid) => uids.has(uid))).toBe(true)
    expect(saved.playedUids).toHaveLength(100)
    expect(saved.unshuffled).toHaveLength(MAX_SAVED_ITEMS)
    expect(saved.unshuffled?.every((uid) => uids.has(uid))).toBe(true)
  })

  it('reads nothing from broken JSON, or from storage that throws', () => {
    const { storage } = memoryStorage({
      [QUEUE_STORAGE_KEY]: '{not json',
      [PLAYBACK_STORAGE_KEY]: '[1, 2]',
    })
    expect(loadSavedPlayback(() => storage)).toEqual({ positionMs: 0 })
    expect(
      loadSavedPlayback(() => {
        throw new Error('blocked')
      }),
    ).toEqual({ positionMs: 0 })
  })
})
