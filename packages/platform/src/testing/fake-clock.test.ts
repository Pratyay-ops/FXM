import { describe, expect, it, vi } from 'vitest'
import { createFakeClock, flushPromises } from './fake-clock'

describe('createFakeClock', () => {
  it('runs timers in order as time moves, and never on its own', () => {
    const clock = createFakeClock(100)
    const runs: string[] = []
    clock.setTimeout(() => runs.push('b'), 20)
    clock.setTimeout(() => runs.push('a'), 10)
    const cancelled = clock.setTimeout(() => runs.push('never'), 15)
    clock.setTimeout(() => runs.push('a2'), 10)
    clock.clearTimeout(cancelled)
    clock.clearTimeout('not a handle')
    expect(clock.pendingTimers).toBe(3)
    clock.advance(10)
    expect(runs).toEqual(['a', 'a2'])
    expect(clock.now()).toBe(110)
    clock.advance(100)
    expect(runs).toEqual(['a', 'a2', 'b'])
    expect(clock.now()).toBe(210)
  })

  it('runs timers that timers set, letting promises settle in between', async () => {
    const clock = createFakeClock(0)
    const seen: number[] = []
    const tick = async () => {
      await Promise.resolve()
      seen.push(clock.now())
      if (seen.length < 3) clock.setTimeout(() => void tick(), 5)
    }
    clock.setTimeout(() => void tick(), 5)
    await clock.advanceAsync(100)
    expect(seen).toEqual([5, 10, 15])
    clock.setTimeout(() => seen.push(-1), -5)
    clock.advance(0)
    expect(seen.at(-1)).toBe(-1)
  })

  it('flushes promises without setImmediate too', async () => {
    const original = (globalThis as { setImmediate?: unknown }).setImmediate
    vi.stubGlobal('setImmediate', undefined)
    try {
      let done = false
      void Promise.resolve().then(() => {
        done = true
      })
      await flushPromises()
      expect(done).toBe(true)
    } finally {
      vi.stubGlobal('setImmediate', original)
    }
  })
})
