import { isFxmError } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestGate, type RequestPriority, sleep } from './gate'

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

/** How a promise settled, without rejecting. */
function outcome<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
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
    const slow = gate.run(async (ready) => {
      await ready()
      order.push('first starts')
      await sleep(100)
      order.push('first ends')
    })
    const quick = gate.run(async (ready) => {
      await ready()
      order.push('second starts')
    })
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([slow, quick])
    expect(order).toEqual(['first starts', 'first ends', 'second starts'])
  })

  it('lets higher priorities go first, in order within a priority', async () => {
    const gate = gateWith()
    const order: string[] = []
    const call = (name: string, priority?: RequestPriority) =>
      gate.run(
        async (ready) => {
          await ready()
          order.push(name)
          await sleep(10)
        },
        priority === undefined ? {} : { priority },
      )
    const calls = [
      call('first'),
      call('bulk 1', 'bulk'),
      call('bulk 2', 'bulk'),
      call('interactive'),
      call('current track', 'current-track'),
      call('unknown', 'soon' as RequestPriority),
    ]
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all(calls)
    expect(order).toEqual(['first', 'current track', 'interactive', 'unknown', 'bulk 1', 'bulk 2'])
  })

  it('pauses between the end of one request and the start of the next', async () => {
    const gate = gateWith({ minIntervalMs: 2_000 })
    const starts: number[] = []
    const first = gate.run(request(starts, 500))
    const second = gate.run(request(starts))
    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.all([first, second])
    const [a = 0, b = 0] = starts
    expect(b - a).toBe(2_500)
  })

  it('starts at most the window maximum in any window', async () => {
    const gate = gateWith({ window: { max: 2, ms: 60_000 } })
    const starts: number[] = []
    const calls = [1, 2, 3].map(() => gate.run(request(starts)))
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.all(calls)
    const t0 = starts[0] ?? 0
    expect(starts.map((at) => at - t0)).toEqual([0, 0, 60_000])
  })

  it('fails at once when the window would make a call wait too long', async () => {
    const gate = gateWith({ window: { max: 1, ms: 60_000 }, maxWaitMs: 10_000 })
    await gate.run(request([]))
    const error = await gate.run(request([])).catch((caught: unknown) => caught)
    expect(waitOf(error)).toBe(60_000)
  })

  it('bounds the whole wait, the queue included, by maxWaitMs from the call', async () => {
    // 20 a minute, as for iTunes, and a call may wait 90 s.
    const gate = gateWith({ window: { max: 20, ms: 60_000 }, maxWaitMs: 90_000 })
    const starts: number[] = []
    const t0 = Date.now()
    const settled: number[] = []
    const calls = Array.from({ length: 65 }, () =>
      outcome(gate.run(request(starts))).finally(() => settled.push(Date.now() - t0)),
    )
    await vi.advanceTimersByTimeAsync(200_000)
    const results = await Promise.all(calls)
    // The first minute's 20 and the second minute's 20. The rest would start at 120 s, after
    // their deadline, and fail as soon as their turn shows it, without waiting for it.
    expect(results.filter((result) => 'value' in result)).toHaveLength(40)
    const failed = results.flatMap((result) => ('error' in result ? [result.error] : []))
    expect(failed).toHaveLength(25)
    expect(failed.map(waitOf).every((ms) => ms === 60_000)).toBe(true)
    expect(Math.max(...settled)).toBe(60_000)
    expect(starts.filter((at) => at - t0 === 60_000)).toHaveLength(20)
  })

  it('fails a call still queued at its deadline', async () => {
    const gate = gateWith({ maxWaitMs: 5_000 })
    const starts: number[] = []
    const slow = gate.run(request(starts, 10_000))
    const queued = outcome(gate.run(request(starts)))
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await queued
    expect('error' in result && waitOf(result.error) >= 1_000).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    await slow
    expect(starts).toHaveLength(1)
  })

  it('fails a queued call at once when it may not wait at all', async () => {
    const gate = gateWith({ maxWaitMs: 0 })
    const first = gate.run(request([], 1_000))
    const second = outcome(gate.run(request([])))
    await vi.advanceTimersByTimeAsync(0)
    const result = await second
    expect('error' in result && isFxmError(result.error, 'RateLimited')).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await first
  })

  it('takes nothing from the pacing for a task that never calls ready', async () => {
    const gate = gateWith({ window: { max: 1, ms: 60_000 }, maxWaitMs: 0 })
    expect(await gate.run(async () => 'cached')).toBe('cached')
    const starts: number[] = []
    await gate.run(request(starts))
    expect(starts).toHaveLength(1)
  })

  it('blocks calls during a back-off with block, and holds them back without', async () => {
    const gate = gateWith({ maxWaitMs: 5_000 })
    expect(gate.backOff(30_000, true)).toBe(30_000)
    const blocked = await gate.run(request([])).catch((caught: unknown) => caught)
    expect(waitOf(blocked)).toBe(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    gate.backOff(2_000, false)
    const starts: number[] = []
    const held = gate.run(request(starts))
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
    const first = gate.run(request(starts, 1_000))
    const controller = new AbortController()
    const cancelled = gate.run(request(starts), { signal: controller.signal })
    const third = gate.run(request(starts))
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
    await expect(gate.run(request([]), { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  })

  it('cancels a wait for the pacing', async () => {
    const gate = gateWith({ minIntervalMs: 5_000 })
    await gate.run(request([]))
    const controller = new AbortController()
    const waiting = gate.run(request([]), { signal: controller.signal })
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
  })
})
