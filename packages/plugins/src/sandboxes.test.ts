import type { EvaluatorKind } from '@fxm/platform'
import { describe, expect, it } from 'vitest'
import { isPluginError } from './errors'
import { IN_PROCESS_FOR_TESTS, isolatedSandboxes, type PluginEvaluator } from './sandboxes'

/** A stand-in evaluator that only records whether it was disposed. */
function fakeEvaluator(name: string, kind: EvaluatorKind = 'web') {
  const evaluator: PluginEvaluator & { name: string; disposed: boolean } = {
    name,
    kind,
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

  it('refuse an in-process evaluator, which would run plugins in the page, except in tests', async () => {
    const inProcess = fakeEvaluator('page', 'in-process')
    const error = await isolatedSandboxes(() => inProcess)
      .acquire('a')
      .catch((caught: unknown) => caught)
    expect(isPluginError(error, 'unavailable')).toBe(true)
    expect(error).toMatchObject({ code: 'Unsupported' })
    expect(inProcess.disposed).toBe(true)
    const forTests = isolatedSandboxes(() => fakeEvaluator('test', 'in-process'), {
      [IN_PROCESS_FOR_TESTS]: true,
    })
    expect((await forTests.acquire('a')).evaluator.kind).toBe('in-process')
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
