import { isFxmError } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestGate, sleep } from './gate'

/** A gate with test defaults. */
function gateWith(options: Partial<ConstructorParameters<typeof RequestGate>[0]> = {}) {
  return new RequestGate({
    service: 'Test',
    minIntervalMs: 0,
    maxWaitMs: 60_000,
    random: () => 0,
    ...options,
  })
}

/** A request that records when it starts and finishes after `ms`. */
function request(log: number[], ms = 0) {
  return async (ready: () => Promise<void>) => {
    await ready()
    log.push(Date.now())
    if (ms > 0) await sleep(ms)
    return log.length
  }
}

/** The `retryAfterMs` of a RateLimited error, or a failed test. */
function waitOf(error: unknown): number {
  if (!isFxmError(error, 'RateLimited') || error.retryAfterMs === undefined) {
    throw new Error(`expected a RateLimited error, got ${String(error)}`)
  }
  return error.retryAfterMs
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RequestGate', () => {
  it('runs requests one at a time, in the order they came', async () => {
    const gate = gateWith()
    const order: string[] = []
    const slow = gate.run(undefined, async (ready) => {
      await ready()
      order.push('first starts')
      await sleep(100)
      order.push('first ends')
    })
    const quick = gate.run(undefined, async (ready) => {
      await ready()
      order.push('second starts')
    })
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([slow, quick])
    expect(order).toEqual(['first starts', 'first ends', 'second starts'])
  })

  it('pauses between the end of one request and the start of the next', async () => {
    const gate = gateWith({ minIntervalMs: 2_000 })
    const starts: number[] = []
    const first = gate.run(undefined, request(starts, 500))
    const second = gate.run(undefined, request(starts))
    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.all([first, second])
    const [a = 0, b = 0] = starts
    expect(b - a).toBe(2_500)
  })

  it('starts at most the window maximum in any window', async () => {
    const gate = gateWith({ window: { max: 2, ms: 60_000 } })
    const starts: number[] = []
    const calls = [1, 2, 3].map(() => gate.run(undefined, request(starts)))
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.all(calls)
    const t0 = starts[0] ?? 0
    expect(starts.map((at) => at - t0)).toEqual([0, 0, 60_000])
  })

  it('fails at once when the window would make a call wait too long', async () => {
    const gate = gateWith({ window: { max: 1, ms: 60_000 }, maxWaitMs: 10_000 })
    await gate.run(undefined, request([]))
    const error = await gate.run(undefined, request([])).catch((caught: unknown) => caught)
    expect(waitOf(error)).toBe(60_000)
  })

  it('takes nothing from the pacing for a task that never calls ready', async () => {
    const gate = gateWith({ window: { max: 1, ms: 60_000 }, maxWaitMs: 0 })
    expect(await gate.run(undefined, async () => 'cached')).toBe('cached')
    const starts: number[] = []
    await gate.run(undefined, request(starts))
    expect(starts).toHaveLength(1)
  })

  it('blocks calls during a back-off with block, and holds them back without', async () => {
    const gate = gateWith({ maxWaitMs: 5_000 })
    expect(gate.backOff(30_000, true)).toBe(30_000)
    const blocked = await gate.run(undefined, request([])).catch((caught: unknown) => caught)
    expect(waitOf(blocked)).toBe(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    gate.backOff(2_000, false)
    const starts: number[] = []
    const held = gate.run(undefined, request(starts))
    await vi.advanceTimersByTimeAsync(2_000)
    await held
    expect(starts).toHaveLength(1)
  })

  it('adds up to 30 % jitter to a back-off', () => {
    const gate = gateWith({ random: () => 1 })
    expect(gate.backOff(10_000, false)).toBe(13_000)
  })

  it('lets a cancelled call leave the queue', async () => {
    const gate = gateWith()
    const starts: number[] = []
    const first = gate.run(undefined, request(starts, 1_000))
    const controller = new AbortController()
    const cancelled = gate.run(controller.signal, request(starts))
    const third = gate.run(undefined, request(starts))
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(cancelled).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all([first, third])
    expect(starts).toHaveLength(2)
  })

  it('rejects at once for a signal that has already aborted', async () => {
    const gate = gateWith()
    const reason = new Error('gone')
    await expect(gate.run(AbortSignal.abort(reason), request([]))).rejects.toBe(reason)
  })

  it('cancels a wait for the pacing', async () => {
    const gate = gateWith({ minIntervalMs: 5_000 })
    await gate.run(undefined, request([]))
    const controller = new AbortController()
    const waiting = gate.run(controller.signal, request([]))
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
  })
})
