import { describe, expect, it } from 'vitest'
import { createRequestBudget } from './budget'
import { createLiteTier, type KillSwitches, type SandboxTransport } from './lite'
import { createFakeClock } from './testing/fake-clock'
import { createFakeSandbox } from './testing/fake-sandbox'

describe('createLiteTier', () => {
  it('is ready only after the self-test passed', async () => {
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox })
    expect(lite.ready).toBe(false)
    await expect(lite.check()).resolves.toBe(true)
    expect(lite.ready).toBe(true)
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

  it('remembers a failed self-test until forced', async () => {
    let pass = false
    const sandbox = createFakeSandbox({ selfTest: () => pass })
    const lite = createLiteTier({ sandbox })
    await expect(lite.check()).resolves.toBe(false)
    pass = true
    await expect(lite.check()).resolves.toBe(false)
    await expect(lite.check({ force: true })).resolves.toBe(true)
  })

  it('treats a self-test that throws as failed', async () => {
    const sandbox: SandboxTransport = {
      selfTest: async () => {
        throw new Error('sandbox broke')
      },
      innerTube: async () => Response.json({}),
    }
    const lite = createLiteTier({ sandbox })
    await expect(lite.check()).resolves.toBe(false)
    expect(lite.ready).toBe(false)
  })

  it('honours the kill switch at once, without running the self-test', async () => {
    let switches: KillSwitches = { lite: true }
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox, killSwitches: () => switches })
    await expect(lite.check()).resolves.toBe(false)
    expect(sandbox.selfTests).toBe(0)
    switches = {}
    await expect(lite.check()).resolves.toBe(true)
    switches = { lite: true }
    expect(lite.ready).toBe(false)
    switches = { lite: false }
    expect(lite.ready).toBe(true)
  })

  it('draws the self-test from the budget, and tries again later when it is used up', async () => {
    const clock = createFakeClock(0)
    const budget = createRequestBudget({
      clock,
      hourlyLimit: 31,
      reserves: { interactive: 30, prefetch: 0, bulk: 30 },
    })
    const sandbox = createFakeSandbox()
    const lite = createLiteTier({ sandbox, budget })
    await budget.acquire('current-track')
    await expect(lite.check()).resolves.toBe(false)
    expect(sandbox.selfTests).toBe(0)
    clock.advance(60 * 60_000)
    await expect(lite.check()).resolves.toBe(true)
    expect(budget.snapshot().used).toBe(1)
  })

  it('passes cancellation on', async () => {
    const sandbox: SandboxTransport = {
      selfTest: (options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal
          if (signal?.aborted) reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
      innerTube: async () => Response.json({}),
    }
    const lite = createLiteTier({ sandbox })
    const controller = new AbortController()
    const check = lite.check({ signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort(new Error('closed'))
    await expect(check).rejects.toThrow('closed')
    expect(lite.ready).toBe(false)
    const early = new AbortController()
    const earlyCheck = lite.check({ signal: early.signal })
    early.abort(new Error('closed early'))
    await expect(earlyCheck).rejects.toThrow('closed early')
    const budgeted = createLiteTier({ sandbox, budget: createRequestBudget() })
    await expect(budgeted.check({ signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow(
      'gone',
    )
  })
})
