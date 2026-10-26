import { describe, expect, it } from 'vitest'
import { isPluginError } from './errors'
import { exclusiveSandbox, isolatedSandboxes, type PluginEvaluator } from './sandboxes'

/** A stand-in evaluator that only records whether it was disposed. */
function fakeEvaluator(name: string) {
  const evaluator: PluginEvaluator & { name: string; disposed: boolean } = {
    name,
    disposed: false,
    evaluate: async () => name,
    dispose() {
      evaluator.disposed = true
    },
  }
  return evaluator
}

function factory() {
  const created: ReturnType<typeof fakeEvaluator>[] = []
  return {
    created,
    create: (label = 'doc') => {
      const evaluator = fakeEvaluator(`${label}-${created.length + 1}`)
      created.push(evaluator)
      return evaluator
    },
  }
}

describe('isolated sandboxes', () => {
  it('give each plugin a document of its own, created on first use and shared by its calls', async () => {
    const { created, create } = factory()
    const sandboxes = isolatedSandboxes(create)
    const a1 = await sandboxes.acquire('a')
    const a2 = await sandboxes.acquire('a')
    const b = await sandboxes.acquire('b')
    expect(a1.evaluator).toBe(a2.evaluator)
    expect(b.evaluator).not.toBe(a1.evaluator)
    expect(created.map((evaluator) => evaluator.name)).toEqual(['a-1', 'b-2'])
    a1.release()
    a1.release()
    a2.release()
    b.release()
    expect(created.some((evaluator) => evaluator.disposed)).toBe(false)
  })

  it('stop a document at once when idle, else when its last call ends; the next call gets a new one', async () => {
    const { created, create } = factory()
    const sandboxes = isolatedSandboxes(create)
    const lease = await sandboxes.acquire('a')
    sandboxes.stop('a')
    expect(created[0]?.disposed).toBe(false)
    const next = await sandboxes.acquire('a')
    expect(next.evaluator).not.toBe(lease.evaluator)
    lease.release()
    expect(created[0]?.disposed).toBe(true)
    next.release()
    sandboxes.stop('a')
    expect(created[1]?.disposed).toBe(true)
    sandboxes.stop('unknown')
  })

  it('stop everything when disposed, and lend nothing after', async () => {
    const { created, create } = factory()
    const sandboxes = isolatedSandboxes(create)
    const busy = await sandboxes.acquire('a')
    await sandboxes.acquire('b')
    sandboxes.stop('a')
    sandboxes.dispose()
    expect(created.every((evaluator) => evaluator.disposed)).toBe(true)
    busy.release()
    const error = await sandboxes.acquire('c').catch((caught: unknown) => caught)
    expect(isPluginError(error, 'disabled')).toBe(true)
    const controller = new AbortController()
    controller.abort(new Error('no'))
    await expect(
      isolatedSandboxes(create).acquire('d', { signal: controller.signal }),
    ).rejects.toThrow('no')
  })
})

describe('an exclusive sandbox', () => {
  it('runs one plugin at a time, with a fresh document for each switch', async () => {
    const { created, create } = factory()
    const sandbox = exclusiveSandbox(() => create())
    const a1 = await sandbox.acquire('a')
    const a2 = await sandbox.acquire('a')
    expect(a2.evaluator).toBe(a1.evaluator)
    let bLease: Awaited<ReturnType<typeof sandbox.acquire>> | undefined
    const b = sandbox.acquire('b').then((lease) => {
      bLease = lease
      return lease
    })
    // A call of `a` that arrives while `b` waits queues behind it.
    let a3Granted = false
    const a3 = sandbox.acquire('a').then((lease) => {
      a3Granted = true
      return lease
    })
    await Promise.resolve()
    expect(bLease).toBeUndefined()
    a1.release()
    await Promise.resolve()
    expect(bLease).toBeUndefined()
    a2.release()
    const bGot = await b
    expect(created[0]?.disposed).toBe(true)
    expect(bGot.evaluator).toBe(created[1])
    expect(a3Granted).toBe(false)
    bGot.release()
    const a3Got = await a3
    expect(created[1]?.disposed).toBe(true)
    expect(a3Got.evaluator).toBe(created[2])
    a3Got.release()
    expect(created[2]?.disposed).toBe(false)
  })

  it('lets waiters for the same plugin share the next document', async () => {
    const { created, create } = factory()
    const sandbox = exclusiveSandbox(() => create())
    const a = await sandbox.acquire('a')
    const b1 = sandbox.acquire('b')
    const b2 = sandbox.acquire('b')
    a.release()
    const [first, second] = await Promise.all([b1, b2])
    expect(first.evaluator).toBe(second.evaluator)
    expect(created).toHaveLength(2)
  })

  it('stops the running plugin’s document when asked, at once or after its calls', async () => {
    const { created, create } = factory()
    const sandbox = exclusiveSandbox(() => create())
    const lease = await sandbox.acquire('a')
    sandbox.stop('b')
    sandbox.stop('a')
    expect(created[0]?.disposed).toBe(false)
    // While it stops, a new call of the same plugin waits for a new document.
    const next = sandbox.acquire('a')
    lease.release()
    expect(created[0]?.disposed).toBe(true)
    const nextLease = await next
    expect(nextLease.evaluator).toBe(created[1])
    nextLease.release()
    sandbox.stop('a')
    expect(created[1]?.disposed).toBe(true)
  })

  it('lets a waiting caller cancel, and rejects waiters when disposed', async () => {
    const { created, create } = factory()
    const sandbox = exclusiveSandbox(() => create())
    await sandbox.acquire('a')
    const controller = new AbortController()
    const reason = new Error('never mind')
    const cancelled = sandbox.acquire('b', { signal: controller.signal })
    controller.abort(reason)
    await expect(cancelled).rejects.toBe(reason)
    const waiting = sandbox.acquire('c')
    sandbox.dispose()
    expect(isPluginError(await waiting.catch((error: unknown) => error), 'disabled')).toBe(true)
    expect(created[0]?.disposed).toBe(true)
    expect(isPluginError(await sandbox.acquire('a').catch((e: unknown) => e), 'disabled')).toBe(
      true,
    )
    await expect(sandbox.acquire('a', { signal: controller.signal })).rejects.toBe(reason)
  })
})
