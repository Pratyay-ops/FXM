import { FxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { TtlCache } from './cache'
import { fakeClock } from './fixtures/testing'

describe('TtlCache', () => {
  it('keeps values for their lifetime on the injected clock', () => {
    const clock = fakeClock()
    const cache = new TtlCache({ now: clock.now })
    cache.set('a', 1, 1000)
    clock.advance(999)
    expect(cache.get('a')).toBe(1)
    clock.advance(1)
    expect(cache.get('a')).toBeUndefined()
  })

  it('stores nothing for a lifetime that is not positive', () => {
    const cache = new TtlCache()
    cache.set('a', 1, 0)
    cache.set('b', 1, Number.NaN)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
  })

  it('drops the oldest entries beyond its bound', () => {
    const cache = new TtlCache({ maxEntries: 2 })
    cache.set('a', 1, 1000)
    cache.set('b', 2, 1000)
    cache.set('a', 3, 1000)
    cache.set('c', 4, 1000)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(3)
    expect(cache.get('c')).toBe(4)
  })

  it('clears by prefix or entirely', () => {
    const cache = new TtlCache()
    cache.set('home:account', 1, 1000)
    cache.set('home:anonymous', 2, 1000)
    cache.set('track:x', 3, 1000)
    cache.clear('home:account')
    expect(cache.get('home:account')).toBeUndefined()
    expect(cache.get('home:anonymous')).toBe(2)
    cache.delete('track:x')
    expect(cache.get('track:x')).toBeUndefined()
    cache.clear()
    expect(cache.get('home:anonymous')).toBeUndefined()
  })

  it('loads once for concurrent callers and caches the result', async () => {
    const clock = fakeClock()
    const cache = new TtlCache({ now: clock.now })
    const load = vi.fn(async () => 'value')
    const results = await Promise.all([
      cache.getOrLoad('k', 1000, load),
      cache.getOrLoad('k', 1000, load),
    ])
    expect(results).toEqual(['value', 'value'])
    expect(await cache.getOrLoad('k', 1000, load)).toBe('value')
    expect(load).toHaveBeenCalledTimes(1)
    clock.advance(1000)
    await cache.getOrLoad('k', 1000, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never caches a failure', async () => {
    const cache = new TtlCache()
    const failing = vi.fn(async () => {
      throw new FxmError('Network', 'down')
    })
    await expect(cache.getOrLoad('k', 1000, failing)).rejects.toThrow('down')
    await expect(cache.getOrLoad('k', 1000, failing)).rejects.toThrow('down')
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('shares typed failures, but loads again after another caller aborted', async () => {
    const cache = new TtlCache()
    let rejectFirst: ((reason: unknown) => void) | undefined
    const first = cache.getOrLoad(
      'k',
      1000,
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFirst = reject
        }),
    )
    const second = cache.getOrLoad('k', 1000, async () => 'own load')
    rejectFirst?.(new DOMException('stop', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(await second).toBe('own load')
  })

  it('does not store a load that a clear overtook', async () => {
    const cache = new TtlCache()
    let resolve: ((value: string) => void) | undefined
    const pending = cache.getOrLoad(
      'home:account',
      1000,
      () =>
        new Promise<string>((r) => {
          resolve = r
        }),
    )
    cache.clear('home:account')
    resolve?.('personal')
    expect(await pending).toBe('personal')
    expect(cache.get('home:account')).toBeUndefined()
  })
})
