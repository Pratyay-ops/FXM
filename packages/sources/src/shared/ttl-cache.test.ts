import { describe, expect, it, vi } from 'vitest'
import { LoadCache, TtlCache } from './ttl-cache'

/** A clock the test moves. */
function clock(start = 0) {
  const time = { now: start }
  return { time, now: () => time.now }
}

describe('TtlCache', () => {
  it('keeps values for their lifetime', () => {
    const { time, now } = clock()
    const cache = new TtlCache<string>({ maxEntries: 10, now })
    cache.set('a', 'A', 100)
    time.now = 99
    expect(cache.get('a')).toBe('A')
    time.now = 100
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('drops the least recently used entry when full', () => {
    const cache = new TtlCache<number>({ maxEntries: 2 })
    cache.set('a', 1, 1000)
    cache.set('b', 2, 1000)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3, 1000)
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([1, undefined, 3])
  })

  it('removes a key set with no lifetime, and forgets on request', () => {
    const cache = new TtlCache<number>({ maxEntries: 2 })
    cache.set('a', 1, 1000)
    cache.set('a', 2, 0)
    expect(cache.get('a')).toBeUndefined()
    cache.set('b', 1, 1000)
    cache.set('c', 1, 1000)
    cache.delete('b')
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('peeks without refreshing an entry or checking its lifetime', () => {
    const { time, now } = clock()
    const cache = new TtlCache<number>({ maxEntries: 2, now })
    cache.set('a', 1, 10)
    cache.set('b', 2, 10)
    expect(cache.peek('a')).toBe(1)
    cache.set('c', 3, 10)
    expect(cache.peek('a')).toBeUndefined()
    time.now = 50
    expect(cache.peek('b')).toBe(2)
  })
})

describe('LoadCache', () => {
  it('shares one load between callers and keeps its value', async () => {
    const cache = new LoadCache<string>({ maxEntries: 10 })
    const load = vi.fn(async () => 'value')
    const [a, b] = await Promise.all([cache.get('k', 1000, load), cache.get('k', 1000, load)])
    expect([a, b]).toEqual(['value', 'value'])
    await cache.get('k', 1000, load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('loads again after the lifetime, after a failure and after delete', async () => {
    const { time, now } = clock()
    const cache = new LoadCache<number>({ maxEntries: 10, now })
    let calls = 0
    const load = async () => ++calls
    expect(await cache.get('k', 100, load)).toBe(1)
    time.now = 100
    expect(await cache.get('k', 100, load)).toBe(2)
    await expect(
      cache.get('bad', 100, async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    await expect(
      cache.get('bad', 100, () => {
        throw new Error('sync boom')
      }),
    ).rejects.toThrow('sync boom')
    expect(await cache.get('bad', 100, load)).toBe(3)
    cache.delete('k')
    expect(await cache.get('k', 100, load)).toBe(4)
    cache.clear()
    expect(await cache.get('bad', 100, load)).toBe(5)
  })

  it('lets callers still waiting start their own load when the first caller cancels', async () => {
    const cache = new LoadCache<string>({ maxEntries: 10 })
    const first = new AbortController()
    const reason = new Error('first caller left')
    const started: string[] = []
    const loadFor = (who: string, signal?: AbortSignal) => () =>
      new Promise<string>((resolve, reject) => {
        started.push(who)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        setTimeout(() => resolve(`loaded by ${who}`), 5)
      })
    const cancelled = cache.get('k', 1000, loadFor('first', first.signal), first.signal)
    const waiting = cache.get('k', 1000, loadFor('second'))
    first.abort(reason)
    await expect(cancelled).rejects.toBe(reason)
    await expect(waiting).resolves.toBe('loaded by second')
    expect(started).toEqual(['first', 'second'])
  })

  it('passes a waiting caller its own cancellation, not the load’s outcome', async () => {
    const cache = new LoadCache<string>({ maxEntries: 10 })
    const controller = new AbortController()
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 20))
    const shared = cache.get('k', 1000, () => slow)
    const impatient = cache.get('k', 1000, () => slow, controller.signal)
    const reason = new Error('gave up')
    controller.abort(reason)
    await expect(impatient).rejects.toBe(reason)
    await expect(shared).resolves.toBe('late')
    await expect(cache.get('k', 1000, async () => 'never', AbortSignal.abort(reason))).rejects.toBe(
      reason,
    )
  })
})
