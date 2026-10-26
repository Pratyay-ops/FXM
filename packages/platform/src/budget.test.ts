import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import {
  BUDGET_DEFAULTS,
  BudgetError,
  type BudgetSnapshot,
  createRequestBudget,
  isBudgetError,
  type RequestBudgetOptions,
  type RequestPriority,
} from './budget'
import { type KeyValueStorage, memoryStorage } from './storage'
import { createFakeClock, type FakeClock, flushPromises } from './testing/fake-clock'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const START = Date.UTC(2026, 9, 25, 12)

function setup(options: RequestBudgetOptions = {}) {
  const clock = createFakeClock(START)
  const storage = memoryStorage()
  const budget = createRequestBudget({ clock, storage, ...options })
  return { clock, storage, budget }
}

/** Takes `count` slots at a priority that never waits, one per millisecond. */
async function spend(
  budget: ReturnType<typeof createRequestBudget>,
  clock: FakeClock,
  count: number,
  priority: Exclude<RequestPriority, 'bulk'> = 'current-track',
) {
  for (let index = 0; index < count; index += 1) {
    await budget.acquire(priority)
    clock.advance(1)
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

/** Starts a bulk acquire and reports whether it resolved, without awaiting it. */
function track(promise: Promise<void>) {
  const state = { done: false, error: undefined as unknown }
  promise.then(
    () => {
      state.done = true
    },
    (error: unknown) => {
      state.error = error
    },
  )
  return state
}

describe('the hourly cap and the reserves', () => {
  it('uses the defaults the architecture gives', () => {
    expect(BUDGET_DEFAULTS.hourlyLimit).toBe(600)
    expect(BUDGET_DEFAULTS.bulkSpacingMs).toBe(5 * SECOND)
    expect(BUDGET_DEFAULTS.reserves.bulk).toBe(100)
    expect(BUDGET_DEFAULTS.pauseMs).toBe(30 * MINUTE)
    expect(BUDGET_DEFAULTS.maxPauseMs).toBe(4 * HOUR)
  })

  it('lets each priority use the hour only down to its reserve', async () => {
    const { budget, clock } = setup()
    await spend(budget, clock, 570, 'interactive')
    const refused = await rejection(budget.acquire('interactive'))
    expect(isFxmError(refused, 'RateLimited')).toBe(true)
    expect(refused).toBeInstanceOf(BudgetError)
    expect(isBudgetError(refused, 'reserve')).toBe(true)
    await spend(budget, clock, 20, 'prefetch')
    expect(isFxmError(await rejection(budget.acquire('prefetch')), 'RateLimited')).toBe(true)
    await spend(budget, clock, 10, 'current-track')
    expect(budget.snapshot()).toMatchObject({ used: 600, remaining: 0 })
    expect(isFxmError(await rejection(budget.acquire('current-track')), 'RateLimited')).toBe(true)
  })

  it('says when a refused call may retry: when enough calls leave the rolling hour', async () => {
    const { budget, clock } = setup()
    await spend(budget, clock, 570, 'interactive')
    clock.advance(10 * MINUTE)
    const error = (await rejection(budget.acquire('interactive'))) as FxmError
    // The first call was taken at START and leaves the hour at START + 1 h.
    expect(error.retryAfterMs).toBe(START + HOUR - clock.now())
    clock.advance(error.retryAfterMs as number)
    await expect(budget.acquire('interactive')).resolves.toBeUndefined()
  })

  it('forgets calls an hour after they were made', async () => {
    const { budget, clock } = setup()
    await spend(budget, clock, 600)
    expect(budget.snapshot().remaining).toBe(0)
    clock.advance(HOUR)
    expect(budget.snapshot()).toMatchObject({ used: 0, remaining: 600 })
  })

  it('keeps 100 calls of the hour from bulk work, which waits until calls expire', async () => {
    const { budget, clock } = setup({ bulkSpacingMs: 0 })
    await spend(budget, clock, 499, 'interactive')
    await budget.acquire('bulk')
    const waiting = track(budget.acquire('bulk'))
    await flushPromises()
    expect(waiting.done).toBe(false)
    expect(budget.snapshot()).toMatchObject({ remaining: 100, waitingBulk: 1 })
    // Playback still gets its calls while bulk work waits.
    await expect(budget.acquire('current-track')).resolves.toBeUndefined()
    await clock.advanceAsync(HOUR)
    expect(waiting.done).toBe(true)
  })
})

describe('bulk work', () => {
  it('starts bulk calls at least 5 seconds apart, in order', async () => {
    const { budget, clock } = setup()
    const granted: number[] = []
    const order: number[] = []
    const all = [0, 1, 2, 3].map((index) =>
      budget.acquire('bulk').then(() => {
        granted.push(clock.now())
        order.push(index)
      }),
    )
    await clock.advanceAsync(20 * SECOND)
    await Promise.all(all)
    expect(order).toEqual([0, 1, 2, 3])
    expect(granted).toEqual([START, START + 5 * SECOND, START + 10 * SECOND, START + 15 * SECOND])
  })

  it('stops waiting when its signal aborts, and the queue moves on', async () => {
    const { budget, clock } = setup()
    await budget.acquire('bulk')
    const controller = new AbortController()
    const aborted = track(budget.acquire('bulk', { signal: controller.signal }))
    const next = track(budget.acquire('bulk'))
    await flushPromises()
    expect(budget.snapshot().waitingBulk).toBe(2)
    controller.abort(new Error('import cancelled'))
    await flushPromises()
    expect((aborted.error as Error).message).toBe('import cancelled')
    await clock.advanceAsync(5 * SECOND)
    expect(next.done).toBe(true)
    expect(budget.snapshot()).toMatchObject({ used: 2, waitingBulk: 0 })
  })

  it('rejects at once when the signal is already aborted', async () => {
    const { budget } = setup()
    const signal = AbortSignal.abort(new Error('gone'))
    expect(((await rejection(budget.acquire('bulk', { signal }))) as Error).message).toBe('gone')
    expect(((await rejection(budget.acquire('prefetch', { signal }))) as Error).message).toBe(
      'gone',
    )
    expect(budget.snapshot().used).toBe(0)
  })

  it('clears its timer once the last waiter gives up', async () => {
    const { budget, clock } = setup()
    await budget.acquire('bulk')
    const controller = new AbortController()
    const waiting = track(budget.acquire('bulk', { signal: controller.signal }))
    await flushPromises()
    expect(clock.pendingTimers).toBe(1)
    controller.abort()
    await flushPromises()
    expect(waiting.error).toBeDefined()
    expect(clock.pendingTimers).toBe(0)
  })
})

describe('bulk calls with a wait limit, as the transports make them', () => {
  it('get their slot when their turn comes within the limit', async () => {
    const { budget, clock } = setup()
    await budget.acquire('bulk', { maxWaitMs: 6 * SECOND })
    const next = track(budget.acquire('bulk', { maxWaitMs: 6 * SECOND }))
    await clock.advanceAsync(5 * SECOND)
    expect(next.done).toBe(true)
  })

  it('are turned away at once during a bot-check pause, taking no slot', async () => {
    const { budget, clock } = setup()
    budget.reportBotCheck('login-required')
    clock.advance(10 * MINUTE)
    const error = await rejection(budget.acquire('bulk', { maxWaitMs: 6 * SECOND }))
    expect(isBudgetError(error, 'paused')).toBe(true)
    expect((error as FxmError).retryAfterMs).toBe(20 * MINUTE)
    expect((error as Error).message).toContain(new Date(START + 30 * MINUTE).toISOString())
    expect(budget.snapshot()).toMatchObject({ used: 0, waitingBulk: 0 })
    expect(clock.pendingTimers).toBe(0)
  })

  it('are turned away when other bulk calls go first', async () => {
    const { budget } = setup()
    await budget.acquire('bulk')
    const queued = track(budget.acquire('bulk', { maxWaitMs: 6 * SECOND }))
    const error = await rejection(budget.acquire('bulk', { maxWaitMs: 6 * SECOND }))
    expect(isBudgetError(error, 'spacing')).toBe(true)
    expect((error as FxmError).retryAfterMs).toBe(10 * SECOND)
    expect(queued.error).toBeUndefined()
  })

  it('are turned away when the hour’s bulk budget is used up', async () => {
    const { budget, clock } = setup({ bulkSpacingMs: 0 })
    await spend(budget, clock, 500, 'interactive')
    const error = await rejection(budget.acquire('bulk', { maxWaitMs: 6 * SECOND }))
    expect(isBudgetError(error, 'reserve')).toBe(true)
    expect((error as FxmError).retryAfterMs).toBe(START + HOUR - clock.now())
  })

  it('stop waiting the moment a pause puts their turn out of reach', async () => {
    const { budget, clock } = setup()
    await budget.acquire('bulk')
    const bounded = track(budget.acquire('bulk', { maxWaitMs: 6 * SECOND }))
    const unbounded = track(budget.acquire('bulk'))
    await flushPromises()
    clock.advance(SECOND)
    budget.reportBotCheck('rate-limited')
    await flushPromises()
    expect(isBudgetError(bounded.error, 'paused')).toBe(true)
    expect(unbounded.error).toBeUndefined()
    expect(budget.snapshot().waitingBulk).toBe(1)
    await clock.advanceAsync(30 * MINUTE)
    expect(unbounded.done).toBe(true)
  })

  it('give up when another budget on the storage pauses bulk work', async () => {
    const { budget, clock, storage } = setup()
    const other = createRequestBudget({ clock, storage })
    await budget.acquire('bulk')
    const waiting = track(budget.acquire('bulk', { maxWaitMs: 6 * SECOND }))
    clock.advance(4 * SECOND)
    // Another tab sees a bot check just before this call's turn; this budget learns of it then.
    other.reportBotCheck('rate-limited')
    await clock.advanceAsync(SECOND)
    expect(isBudgetError(waiting.error, 'paused')).toBe(true)
  })
})

describe('job runners', () => {
  it('wait for a free bulk slot without taking it', async () => {
    const { budget, clock } = setup()
    await budget.whenAvailable('bulk')
    await budget.acquire('bulk')
    expect(budget.nextSlotAt('bulk')).toBe(START + 5 * SECOND)
    const ready = track(budget.whenAvailable('bulk'))
    await clock.advanceAsync(5 * SECOND - 1)
    expect(ready.done).toBe(false)
    await clock.advanceAsync(1)
    expect(ready.done).toBe(true)
    expect(budget.snapshot().used).toBe(1)
  })

  it('wait through a pause that starts while they wait, and behind queued calls', async () => {
    const { budget, clock } = setup()
    await budget.acquire('bulk')
    const queued = track(budget.acquire('bulk'))
    expect(budget.nextSlotAt('bulk')).toBe(START + 10 * SECOND)
    const ready = track(budget.whenAvailable('bulk'))
    await clock.advanceAsync(5 * SECOND)
    expect(queued.done).toBe(true)
    budget.reportBotCheck('login-required')
    await clock.advanceAsync(30 * MINUTE - 1)
    expect(ready.done).toBe(false)
    await clock.advanceAsync(1)
    expect(ready.done).toBe(true)
  })

  it('know when the other priorities get their next slot', async () => {
    const { budget, clock } = setup()
    expect(budget.nextSlotAt('interactive')).toBe(START)
    await spend(budget, clock, 570, 'interactive')
    expect(budget.nextSlotAt('interactive')).toBe(START + HOUR)
    expect(budget.nextSlotAt('current-track')).toBe(clock.now())
    const ready = track(budget.whenAvailable('interactive'))
    await clock.advanceAsync(START + HOUR - clock.now())
    expect(ready.done).toBe(true)
  })

  it('stop waiting when their signal aborts', async () => {
    const { budget, clock } = setup()
    budget.reportBotCheck('login-required')
    const controller = new AbortController()
    const waiting = track(budget.whenAvailable('bulk', { signal: controller.signal }))
    await flushPromises()
    controller.abort(new Error('import cancelled'))
    await flushPromises()
    expect((waiting.error as Error).message).toBe('import cancelled')
    expect(clock.pendingTimers).toBe(0)
    const signal = AbortSignal.abort(new Error('already'))
    expect(((await rejection(budget.whenAvailable('bulk', { signal }))) as Error).message).toBe(
      'already',
    )
  })
})

describe('BudgetError', () => {
  it('is a RateLimited FxmError that names its limit', () => {
    const error = new BudgetError('spacing', 'wait', 5_000)
    expect(error).toBeInstanceOf(FxmError)
    expect(error).toMatchObject({ code: 'RateLimited', reason: 'spacing', retryAfterMs: 5_000 })
    expect(isBudgetError(error)).toBe(true)
    expect(isBudgetError(error, 'paused')).toBe(false)
    expect(isBudgetError(new FxmError('RateLimited', 'Spotify said slow down'))).toBe(false)
    expect(isBudgetError(new Error('x'))).toBe(false)
    const copy = Object.assign(new Error('from another bundle'), {
      name: 'FxmError',
      code: 'RateLimited',
      reason: 'paused',
    })
    expect(isBudgetError(copy, 'paused')).toBe(true)
  })
})

describe('bot checks', () => {
  it('pause bulk work for 30 minutes while playback goes on', async () => {
    const { budget, clock } = setup()
    budget.reportBotCheck('login-required')
    expect(budget.snapshot()).toMatchObject({
      bulkPausedUntil: START + 30 * MINUTE,
      pauseLevel: 1,
      lastBotCheck: { at: START, cause: 'login-required' },
    })
    const bulk = track(budget.acquire('bulk'))
    await expect(budget.acquire('current-track')).resolves.toBeUndefined()
    await expect(budget.acquire('interactive')).resolves.toBeUndefined()
    await clock.advanceAsync(30 * MINUTE - 1)
    expect(bulk.done).toBe(false)
    await clock.advanceAsync(1)
    expect(bulk.done).toBe(true)
    expect(budget.snapshot().bulkPausedUntil).toBeUndefined()
  })

  it('double the pause for each bot check soon after the last pause, up to 4 hours', async () => {
    const { budget, clock } = setup()
    const pauses: number[] = []
    for (let round = 0; round < 6; round += 1) {
      budget.reportBotCheck('rate-limited')
      const until = budget.snapshot().bulkPausedUntil as number
      pauses.push((until - clock.now()) / MINUTE)
      clock.advance(until - clock.now() + MINUTE)
    }
    expect(pauses).toEqual([30, 60, 120, 240, 240, 240])
  })

  it('start again at 30 minutes once bulk work ran as long as the last pause', async () => {
    const { budget, clock } = setup()
    budget.reportBotCheck('login-required')
    clock.advance(30 * MINUTE + 29 * MINUTE)
    budget.reportBotCheck('login-required')
    expect(budget.snapshot().pauseLevel).toBe(2)
    clock.advance(60 * MINUTE + 60 * MINUTE)
    expect(budget.snapshot().pauseLevel).toBe(0)
    budget.reportBotCheck('login-required')
    expect(budget.snapshot()).toMatchObject({
      pauseLevel: 1,
      bulkPausedUntil: clock.now() + 30 * MINUTE,
    })
  })

  it('extend a running pause instead of doubling it', () => {
    const { budget, clock } = setup()
    budget.reportBotCheck('login-required')
    clock.advance(20 * MINUTE)
    budget.reportBotCheck('login-required')
    expect(budget.snapshot()).toMatchObject({
      pauseLevel: 1,
      bulkPausedUntil: clock.now() + 30 * MINUTE,
    })
    clock.advance(1 * MINUTE)
    budget.reportBotCheck('rate-limited')
    expect(budget.snapshot().bulkPausedUntil).toBe(clock.now() + 30 * MINUTE)
  })

  it('ignore unknown causes', () => {
    const { budget } = setup()
    budget.reportBotCheck('captcha' as never)
    expect(budget.snapshot().bulkPausedUntil).toBeUndefined()
  })
})

describe('persistence', () => {
  it('shares the hour and the pause with every budget on the same storage', async () => {
    const { budget, clock, storage } = setup()
    await spend(budget, clock, 3)
    budget.reportBotCheck('login-required')
    const reloaded = createRequestBudget({ clock, storage })
    expect(reloaded.snapshot()).toMatchObject({
      used: 3,
      bulkPausedUntil: START + 3 + 30 * MINUTE,
      pauseLevel: 1,
    })
    await reloaded.acquire('interactive')
    expect(budget.snapshot().used).toBe(4)
  })

  it('starts afresh from malformed stored state', () => {
    for (const stored of [
      'not json',
      '{"v":2}',
      '{"v":1,"calls":"x"}',
      '{"v":1,"calls":[-1],"lastBulkAt":0,"pausedUntil":0,"pauseLevel":0,"lastBotCheckAt":0}',
      '{"v":1,"calls":[],"lastBulkAt":0,"pausedUntil":0,"pauseLevel":99,"lastBotCheckAt":0}',
      '{"v":1,"calls":[],"lastBulkAt":0,"pausedUntil":0,"pauseLevel":0,"lastBotCheckAt":0,"lastBotCheckCause":"x"}',
      'null',
    ]) {
      const clock = createFakeClock(START)
      const storage = memoryStorage({ [BUDGET_DEFAULTS.storageKey]: stored })
      expect(createRequestBudget({ clock, storage }).snapshot()).toMatchObject({
        used: 0,
        pauseLevel: 0,
      })
    }
  })

  it('keeps counting in memory when the storage refuses writes', async () => {
    const clock = createFakeClock(START)
    const broken: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }
    const budget = createRequestBudget({
      clock,
      storage: broken,
      hourlyLimit: 2,
      reserves: { prefetch: 0, interactive: 0, bulk: 1 },
    })
    await budget.acquire('current-track')
    await budget.acquire('current-track')
    expect(isFxmError(await rejection(budget.acquire('current-track')), 'RateLimited')).toBe(true)
  })

  it('does not let a clock set back keep calls or pauses alive for longer', async () => {
    const clock = createFakeClock(START)
    const storage = memoryStorage({
      [BUDGET_DEFAULTS.storageKey]: JSON.stringify({
        v: 1,
        calls: [START + 5 * HOUR],
        lastBulkAt: START + 5 * HOUR,
        pausedUntil: START + 50 * HOUR,
        pauseLevel: 4,
        lastBotCheckAt: START + 5 * HOUR,
        lastBotCheckCause: 'login-required',
      }),
    })
    const budget = createRequestBudget({ clock, storage })
    expect(budget.snapshot()).toMatchObject({ used: 1, bulkPausedUntil: START + 4 * HOUR })
    clock.advance(HOUR)
    expect(budget.snapshot().used).toBe(0)
  })
})

describe('options and listeners', () => {
  it('reports the limits it was created with', () => {
    const { budget } = setup({ hourlyLimit: 300, reserves: { bulk: 50 }, bulkSpacingMs: 2_000 })
    expect(budget.settings).toEqual({
      hourlyLimit: 300,
      reserves: { 'current-track': 0, prefetch: 10, interactive: 30, bulk: 50 },
      bulkSpacingMs: 2_000,
      pauseMs: 30 * MINUTE,
      maxPauseMs: 4 * HOUR,
    })
    expect(Object.isFrozen(budget.settings)).toBe(true)
  })

  it('refuses settings that make no sense', () => {
    expect(() => createRequestBudget({ hourlyLimit: 0 })).toThrow(RangeError)
    expect(() => createRequestBudget({ reserves: { bulk: 600 } })).toThrow(RangeError)
    expect(() => createRequestBudget({ reserves: { prefetch: -1 } })).toThrow(RangeError)
    expect(() => createRequestBudget({ pauseMs: 0 })).toThrow(RangeError)
    expect(() => createRequestBudget({ pauseMs: HOUR, maxPauseMs: MINUTE })).toThrow(RangeError)
    expect(() => createRequestBudget({ bulkSpacingMs: Number.NaN })).toThrow(RangeError)
    expect(() => createRequestBudget({ hourlyLimit: 600.5 })).toThrow(/whole number/)
    expect(() => createRequestBudget({ reserves: { interactive: 2.5 } })).toThrow(RangeError)
  })

  it('refuses unknown priorities and wait limits with a RangeError', async () => {
    const { budget } = setup()
    expect(await rejection(budget.acquire('urgent' as never))).toBeInstanceOf(RangeError)
    expect(await rejection(budget.whenAvailable('urgent' as never))).toBeInstanceOf(RangeError)
    expect(() => budget.nextSlotAt('urgent' as never)).toThrow(RangeError)
    for (const maxWaitMs of [-1, Number.NaN, '5' as never]) {
      expect(await rejection(budget.acquire('bulk', { maxWaitMs }))).toBeInstanceOf(RangeError)
    }
  })

  it('tells listeners about every change, and survives a failing one', async () => {
    const { budget } = setup()
    const seen: BudgetSnapshot[] = []
    budget.subscribe(() => {
      throw new Error('broken listener')
    })
    const unsubscribe = budget.subscribe((snapshot) => seen.push(snapshot))
    await budget.acquire('interactive')
    budget.reportBotCheck('rate-limited')
    unsubscribe()
    await budget.acquire('interactive')
    expect(seen.map((snapshot) => snapshot.used)).toEqual([1, 1])
    expect(seen[1]?.lastBotCheck?.cause).toBe('rate-limited')
  })

  it('works on the system clock by default', async () => {
    vi.useFakeTimers({ now: START })
    try {
      const budget = createRequestBudget()
      await budget.acquire('bulk')
      const next = track(budget.acquire('bulk'))
      await vi.advanceTimersByTimeAsync(5 * SECOND)
      expect(next.done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a 1,000-track import', () => {
  /** Calls in the hour that ends at `time`. */
  function inHour(times: readonly number[], time: number) {
    return times.filter((t) => t > time - HOUR && t <= time).length
  }

  it('stays under the cap, gives way to playback, pauses on LOGIN_REQUIRED and resumes', async () => {
    const { budget, clock } = setup()
    const bulkTimes: number[] = []
    const playbackTimes: number[] = []
    const playbackFailures: unknown[] = []

    // The import: one InnerTube search per track, as bulk work.
    const importer = (async () => {
      for (let track = 0; track < 1000; track += 1) {
        await budget.acquire('bulk')
        bulkTimes.push(clock.now())
      }
    })()

    // Meanwhile the user listens: a track every 3 minutes, each resolved with 3 calls (one for
    // the current track, two to prefetch the next ones), which must never wait.
    const listen = () => {
      for (const priority of ['current-track', 'prefetch', 'prefetch'] as const) {
        budget.acquire(priority).then(
          () => playbackTimes.push(clock.now()),
          (error: unknown) => playbackFailures.push(error),
        )
      }
      clock.setTimeout(listen, 3 * MINUTE)
    }
    listen()

    // Two hours in, YouTube asks for a sign-in on a playback call.
    const botCheckAt = START + 2 * HOUR
    clock.setTimeout(() => budget.reportBotCheck('login-required'), 2 * HOUR)

    for (let hour = 0; hour < 6 && bulkTimes.length < 1000; hour += 1) {
      await clock.advanceAsync(HOUR)
    }
    await importer

    expect(bulkTimes).toHaveLength(1000)
    expect(playbackFailures).toEqual([])
    const all = [...bulkTimes, ...playbackTimes].sort((a, b) => a - b)
    for (const time of all) expect(inHour(all, time)).toBeLessThanOrEqual(600)
    for (const time of bulkTimes) expect(inHour(bulkTimes, time)).toBeLessThanOrEqual(500)
    for (let index = 1; index < bulkTimes.length; index += 1) {
      expect(bulkTimes[index] as number).toBeGreaterThanOrEqual(
        (bulkTimes[index - 1] as number) + 5 * SECOND,
      )
    }
    // Playback calls went through at once, also during the pause.
    expect(playbackTimes.some((t) => t > botCheckAt && t < botCheckAt + 30 * MINUTE)).toBe(true)
    // No bulk call during the 30-minute pause, and bulk work resumed right after it.
    expect(bulkTimes.some((t) => t >= botCheckAt && t < botCheckAt + 30 * MINUTE)).toBe(false)
    expect(bulkTimes.some((t) => t >= botCheckAt + 30 * MINUTE)).toBe(true)
    // At most 500 bulk calls an hour, so 1,000 take more than two hours plus the pause.
    expect((bulkTimes.at(-1) as number) - START).toBeGreaterThan(2 * HOUR + 30 * MINUTE)
  })
})
