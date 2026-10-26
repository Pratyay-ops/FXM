import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTracks } from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepAwakeWhilePlaying, type LockManagerLike, PLAYBACK_LOCK, pageLocks } from './keep-awake'

/** A Web Locks API that grants every shared request at once and tracks what is held. */
function fakeLocks() {
  const held = new Set<number>()
  const requests: { name: string; mode: string }[] = []
  let next = 0
  const locks: LockManagerLike = {
    request: vi.fn(async (name, options, callback) => {
      requests.push({ name, mode: options.mode })
      const id = next++
      held.add(id)
      try {
        await callback()
      } finally {
        held.delete(id)
      }
    }),
  }
  return { locks, requests, held }
}

function setup() {
  const engine = new FakeEngine()
  const player = new Player({ engine, resolver: new FakeResolver() })
  return { engine, player, ...fakeLocks() }
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('keepAwakeWhilePlaying', () => {
  it('holds one shared lock while music plays and releases it on pause', async () => {
    const { player, locks, requests, held } = setup()
    keepAwakeWhilePlaying(player, { locks })
    expect(held.size).toBe(0)
    await player.setQueue(testTracks('a', 'b'))
    await settle()
    expect(requests).toEqual([{ name: PLAYBACK_LOCK, mode: 'shared' }])
    expect(held.size).toBe(1)
    player.pause()
    await settle()
    expect(held.size).toBe(0)
    await player.play()
    await settle()
    expect(held.size).toBe(1)
    expect(requests).toHaveLength(2)
  })

  it('keeps the lock from one track to the next', async () => {
    const { player, engine, locks, requests, held } = setup()
    keepAwakeWhilePlaying(player, { locks })
    await player.setQueue(testTracks('a', 'b'))
    engine.end()
    await settle()
    expect(player.getState().status).toBe('playing')
    expect(requests).toHaveLength(1)
    expect(held.size).toBe(1)
  })

  it('releases the lock when the queue ends and when disconnected', async () => {
    const { player, engine, locks, held } = setup()
    const disconnect = keepAwakeWhilePlaying(player, { locks })
    await player.setQueue(testTracks('a'))
    engine.end()
    await settle()
    expect(player.getState().status).toBe('ended')
    expect(held.size).toBe(0)
    await player.play()
    await settle()
    expect(held.size).toBe(1)
    disconnect()
    await settle()
    expect(held.size).toBe(0)
  })

  it('holds nothing where the page has no Web Locks API', async () => {
    const { player } = setup()
    const disconnect = keepAwakeWhilePlaying(player, { locks: undefined })
    await player.setQueue(testTracks('a'))
    disconnect()
  })

  it('reports a refused lock and carries on', async () => {
    const { player } = setup()
    const onError = vi.fn()
    const locks: LockManagerLike = {
      request: () => Promise.reject(new DOMException('denied', 'SecurityError')),
    }
    keepAwakeWhilePlaying(player, { locks, onError })
    await player.setQueue(testTracks('a'))
    await settle()
    expect(onError).toHaveBeenCalledOnce()
    expect(player.getState().status).toBe('playing')
  })
})

describe('pageLocks', () => {
  it('finds navigator.locks where the page has it', () => {
    const { locks } = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    expect(pageLocks()).toBe(locks)
    vi.stubGlobal('navigator', {})
    expect(pageLocks()).toBeUndefined()
  })
})
