import { describe, expect, it } from 'vitest'
import { RateLimiter } from './rate-limit.ts'

describe('RateLimiter', () => {
  it('allows max acquisitions per window, then frees slots as they age out', () => {
    const limiter = new RateLimiter(3, 1000)
    expect([0, 100, 200].map((t) => limiter.tryAcquire(t))).toEqual([true, true, true])
    expect(limiter.tryAcquire(300)).toBe(false)
    expect(limiter.retryAfter(300)).toBe(700)
    expect(limiter.tryAcquire(999)).toBe(false)
    expect(limiter.tryAcquire(1000)).toBe(true) // the request at 0 left the window
    expect(limiter.tryAcquire(1001)).toBe(false)
    expect(limiter.retryAfter(1001)).toBe(99)
  })

  it('does not count refused attempts', () => {
    const limiter = new RateLimiter(1, 1000)
    expect(limiter.tryAcquire(0)).toBe(true)
    for (let t = 1; t < 1000; t += 100) expect(limiter.tryAcquire(t)).toBe(false)
    expect(limiter.tryAcquire(1000)).toBe(true)
  })

  it('round-trips its state, ignoring invalid and future timestamps', () => {
    const first = new RateLimiter(2, 1000)
    first.tryAcquire(10)
    first.tryAcquire(20)
    const restored = new RateLimiter(2, 1000)
    restored.restore(first.snapshot())
    expect(restored.tryAcquire(30)).toBe(false)
    expect(restored.retryAfter(30)).toBe(980)

    const messy = new RateLimiter(2, 1000)
    messy.restore(['x', null, Number.NaN, 5_000_000])
    expect(messy.tryAcquire(100)).toBe(true) // the future timestamp is dropped
    expect(messy.snapshot()).toEqual([100])
  })

  it('validates its configuration', () => {
    expect(() => new RateLimiter(0, 1000)).toThrow()
    expect(() => new RateLimiter(1.5, 1000)).toThrow()
    expect(() => new RateLimiter(1, 0)).toThrow()
  })
})
