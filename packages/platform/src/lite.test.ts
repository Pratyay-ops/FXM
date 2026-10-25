import { describe, expect, it, vi } from 'vitest'
import { createRequestBudget } from './budget'
import {
  createKillSwitchStore,
  createLiteTier,
  type KillSwitches,
  LITE_DEFAULTS,
  type LiteState,
  type OnlineEvents,
  type SandboxTransport,
  type SelfTestResult,
} from './lite'
import { createFakeClock, flushPromises } from './testing/fake-clock'
import { createFakeSandbox } from './testing/fake-sandbox'

/** A sandbox whose self-test the test answers by hand. */
function manualSandbox() {
  const pending: { resolve(result: SelfTestResult): void; signal: AbortSignal | undefined }[] = []
  const sandbox: SandboxTransport = {
    selfTest: (options) =>
      new Promise<SelfTestResult>((resolve) => {
        pending.push({ resolve, signal: options?.signal })
      }),
    innerTube: async () => Response.json({}),
  }
  return { sandbox, pending }
}

/** An `online` event source the test fires. */
function onlineEvents() {
  const listeners = new Set<() => void>()
  const events: OnlineEvents = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  return {
    events,
    listeners,
    fire: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('createLiteTier', () => {
  it('is ready only after the self-test passed', async () => {
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox })
    expect(lite.ready).toBe(false)
    expect(lite.state).toBe('unchecked')
    await expect(lite.check()).resolves.toBe(true)
    expect(lite.ready).toBe(true)
    expect(lite.state).toBe('passed')
    expect(lite.sandbox).toBe(sandbox)
  })

  it('runs the self-test once, unless forced, and shares concurrent checks', async () => {
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox })
    await Promise.all([lite.check(), lite.check(), lite.check()])
    await lite.check()
    expect(sandbox.selfTests).toBe(1)
    await lite.check({ force: true })
    expect(sandbox.selfTests).toBe(2)
  })

  it('stays ready while a forced re-run is under way', async () => {
    const { sandbox, pending } = manualSandbox()
    const lite = createLiteTier({ sandbox })
    const first = lite.check()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]?.resolve('pass')
    await first
    const again = lite.check({ force: true })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(lite.state).toBe('checking')
    expect(lite.ready).toBe(true)
    await expect(lite.check()).resolves.toBe(true)
    pending[1]?.resolve('refused')
    await expect(again).resolves.toBe(false)
    expect(lite.ready).toBe(false)
  })

  it('remembers a refusal until forced', async () => {
    let result: SelfTestResult = 'refused'
    const sandbox = createFakeSandbox({ selfTest: () => result })
    const lite = createLiteTier({ sandbox })
    await expect(lite.check()).resolves.toBe(false)
    expect(lite.state).toBe('refused')
    result = 'pass'
    await expect(lite.check()).resolves.toBe(false)
    expect(sandbox.selfTests).toBe(1)
    await expect(lite.check({ force: true })).resolves.toBe(true)
  })

  it('does not remember an unreachable self-test, and tries again with a growing delay', async () => {
    const clock = createFakeClock(0)
    let result: SelfTestResult = 'unreachable'
    const sandbox = createFakeSandbox({ selfTest: () => result })
    const lite = createLiteTier({ sandbox, clock })
    await expect(lite.check()).resolves.toBe(false)
    expect(lite.state).toBe('unreachable')
    // Within the retry delay a check does not hammer the sandbox...
    await expect(lite.check()).resolves.toBe(false)
    expect(sandbox.selfTests).toBe(1)
    // ...and the tier tries again by itself: after 15 s, then 30 s.
    await clock.advanceAsync(LITE_DEFAULTS.retryMs)
    expect(sandbox.selfTests).toBe(2)
    await clock.advanceAsync(LITE_DEFAULTS.retryMs)
    expect(sandbox.selfTests).toBe(2)
    result = 'pass'
    await clock.advanceAsync(LITE_DEFAULTS.retryMs)
    expect(sandbox.selfTests).toBe(3)
    expect(lite.state).toBe('passed')
    expect(clock.pendingTimers).toBe(0)
  })

  it('stops retrying by itself after the last attempt, but a later check runs again', async () => {
    const clock = createFakeClock(0)
    const sandbox = createFakeSandbox({ selfTest: 'unreachable' })
    const lite = createLiteTier({ sandbox, clock, retries: 2, retryMs: 10, maxRetryMs: 15 })
    await lite.check()
    await clock.advanceAsync(10)
    await clock.advanceAsync(15)
    expect(sandbox.selfTests).toBe(3)
    expect(clock.pendingTimers).toBe(0)
    await clock.advanceAsync(60_000)
    expect(sandbox.selfTests).toBe(3)
    await lite.check()
    expect(sandbox.selfTests).toBe(4)
  })

  it('counts a self-test that rejects or answers nonsense as unreachable', async () => {
    const clock = createFakeClock(0)
    const answers: (() => Promise<SelfTestResult>)[] = [
      async () => {
        throw new Error('the sandbox document did not load')
      },
      async () => true as unknown as SelfTestResult,
    ]
    const sandbox: SandboxTransport = {
      selfTest: () => (answers.shift() as () => Promise<SelfTestResult>)(),
      innerTube: async () => Response.json({}),
    }
    const lite = createLiteTier({ sandbox, clock })
    await expect(lite.check()).resolves.toBe(false)
    expect(lite.state).toBe('unreachable')
    await expect(lite.check({ force: true })).resolves.toBe(false)
    expect(lite.state).toBe('unreachable')
  })

  it('stops waiting for a self-test that never answers, and aborts it', async () => {
    const clock = createFakeClock(0)
    const { sandbox, pending } = manualSandbox()
    const lite = createLiteTier({ sandbox, clock })
    const check = lite.check()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(lite.state).toBe('checking')
    await clock.advanceAsync(LITE_DEFAULTS.selfTestTimeoutMs - 1)
    expect(pending[0]?.signal?.aborted).toBe(false)
    await clock.advanceAsync(1)
    await expect(check).resolves.toBe(false)
    expect(pending[0]?.signal?.aborted).toBe(true)
    expect(lite.state).toBe('unreachable')
    // An answer that comes too late changes nothing.
    pending[0]?.resolve('pass')
    await flushPromises()
    expect(lite.ready).toBe(false)
  })

  it('tries again when the browser comes back online', async () => {
    const clock = createFakeClock(0)
    let result: SelfTestResult = 'unreachable'
    const sandbox = createFakeSandbox({ selfTest: () => result })
    const online = onlineEvents()
    const lite = createLiteTier({ sandbox, clock, onlineEvents: online.events })
    await lite.check()
    result = 'pass'
    online.fire()
    await vi.waitFor(() => expect(lite.ready).toBe(true))
    expect(sandbox.selfTests).toBe(2)
    // Once it passed, coming online again runs nothing.
    online.fire()
    await flushPromises()
    expect(sandbox.selfTests).toBe(2)
  })

  it('tells subscribers about every change of state', async () => {
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox })
    const seen: LiteState[] = []
    lite.subscribe(() => {
      throw new Error('broken listener')
    })
    const unsubscribe = lite.subscribe((state) => seen.push(state))
    await lite.check()
    await lite.check()
    unsubscribe()
    await lite.check({ force: true })
    expect(seen).toEqual(['checking', 'passed'])
  })

  it('honours the kill switch at once, without running the self-test', async () => {
    let switches: KillSwitches = { lite: true }
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox, killSwitches: () => switches })
    await expect(lite.check()).resolves.toBe(false)
    expect(lite.state).toBe('killed')
    expect(sandbox.selfTests).toBe(0)
    switches = {}
    await expect(lite.check()).resolves.toBe(true)
    switches = { lite: true }
    expect(lite.ready).toBe(false)
    expect(lite.state).toBe('killed')
    switches = { lite: false }
    expect(lite.ready).toBe(true)
  })

  it('announces kill switch changes from a source as they happen', async () => {
    const store = createKillSwitchStore()
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox, killSwitches: store })
    await lite.check()
    const seen: LiteState[] = []
    lite.subscribe((state) => seen.push(state))
    store.set({ lite: true })
    expect(lite.ready).toBe(false)
    store.set({ lite: true })
    store.set({})
    expect(seen).toEqual(['killed', 'passed'])
    lite.dispose()
    store.set({ lite: true })
    expect(seen).toHaveLength(2)
  })

  it('stops a retry that comes due while the kill switch is set', async () => {
    const clock = createFakeClock(0)
    let switches: KillSwitches = {}
    const sandbox = createFakeSandbox({ selfTest: 'unreachable' })
    const lite = createLiteTier({ sandbox, clock, killSwitches: () => switches })
    await lite.check()
    switches = { lite: true }
    await clock.advanceAsync(LITE_DEFAULTS.retryMs)
    expect(sandbox.selfTests).toBe(1)
    expect(clock.pendingTimers).toBe(0)
  })

  it('draws the self-test from the budget, and tries again once a slot frees up', async () => {
    const clock = createFakeClock(0)
    const budget = createRequestBudget({
      clock,
      hourlyLimit: 31,
      reserves: { interactive: 30, prefetch: 0, bulk: 30 },
    })
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox, budget, clock })
    await budget.acquire('current-track')
    await expect(lite.check()).resolves.toBe(false)
    expect(sandbox.selfTests).toBe(0)
    expect(lite.state).toBe('unreachable')
    await clock.advanceAsync(60 * 60_000)
    expect(lite.ready).toBe(true)
    expect(budget.snapshot().used).toBe(1)
  })

  it('stops waiting when the caller’s signal aborts, but finishes the run for the others', async () => {
    const { sandbox, pending } = manualSandbox()
    const lite = createLiteTier({ sandbox })
    const controller = new AbortController()
    const leaving = lite.check({ signal: controller.signal })
    const staying = lite.check()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    controller.abort(new Error('closed'))
    await expect(leaving).rejects.toThrow('closed')
    pending[0]?.resolve('pass')
    await expect(staying).resolves.toBe(true)
    await expect(lite.check({ signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow(
      'gone',
    )
  })

  it('ends a running self-test, its retries and its listeners when disposed', async () => {
    const clock = createFakeClock(0)
    const { sandbox, pending } = manualSandbox()
    const online = onlineEvents()
    const lite = createLiteTier({ sandbox, clock, onlineEvents: online.events })
    const seen: LiteState[] = []
    lite.subscribe((state) => seen.push(state))
    const check = lite.check()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    lite.dispose()
    lite.dispose()
    await expect(check).resolves.toBe(false)
    expect(pending[0]?.signal?.aborted).toBe(true)
    expect(online.listeners.size).toBe(0)
    expect(clock.pendingTimers).toBe(0)
    expect(seen).toEqual(['checking'])
    await expect(lite.check()).resolves.toBe(false)
    expect(lite.ready).toBe(false)
  })

  it('gives up quietly when disposed while waiting for its budget slot', async () => {
    const budget = createRequestBudget()
    let release: () => void = () => {}
    const slow = {
      ...budget,
      acquire: (_priority: string, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          release = resolve
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))
        }),
    }
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox, budget: slow as typeof budget })
    const check = lite.check()
    lite.dispose()
    await expect(check).resolves.toBe(false)
    release()
    expect(sandbox.selfTests).toBe(0)
  })
})

describe('createKillSwitchStore', () => {
  it('holds the switches and tells listeners when they change', () => {
    const store = createKillSwitchStore({ lite: true })
    const calls: KillSwitches[] = []
    store.subscribe(() => {
      throw new Error('broken listener')
    })
    const unsubscribe = store.subscribe(() => calls.push(store.get()))
    expect(store.get()).toEqual({ lite: true })
    store.set({})
    unsubscribe()
    store.set({ lite: true })
    expect(calls).toEqual([{}])
    expect(createKillSwitchStore().get()).toEqual({})
  })
})
