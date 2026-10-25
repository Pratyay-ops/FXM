import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTracks } from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadSavedPlayback,
  PLAYBACK_STORAGE_KEY,
  persistPlayback,
  QUEUE_STORAGE_KEY,
} from './queue-storage'

/** An in-memory Web Storage that counts writes per key. */
function memoryStorage(entries: Record<string, string> = {}) {
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
      writes.set(key, (writes.get(key) ?? 0) + 1)
      data.set(key, value)
    },
  }
  return { storage, writes, read: (key: string) => JSON.parse(data.get(key) ?? 'null') }
}

function setup() {
  const memory = memoryStorage()
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
    expect(read(PLAYBACK_STORAGE_KEY)).toEqual({ positionMs: 91_000, volume: 1, muted: false })
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
      [PLAYBACK_STORAGE_KEY]: JSON.stringify({ positionMs: 1234, volume: 0.5, muted: true }),
    })
    expect(loadSavedPlayback(() => storage)).toEqual({
      queue,
      positionMs: 1234,
      volume: 0.5,
      muted: true,
    })
  })

  it('drops numbers that are out of range or of the wrong type', () => {
    const { storage } = memoryStorage({
      [PLAYBACK_STORAGE_KEY]: JSON.stringify({ positionMs: -3, volume: 2, muted: 'no' }),
    })
    expect(loadSavedPlayback(() => storage)).toEqual({ positionMs: 0 })
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
