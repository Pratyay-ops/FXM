import type { EvaluatorKind } from '@fxm/platform'
import { describe, expect, it } from 'vitest'
import { isPluginError } from './errors'
import {
  IN_PROCESS_FOR_TESTS,
  isolatedSandboxes,
  type PluginEvaluator,
  probePluginWorkers,
  WORKER_PROBE_SOURCE,
} from './sandboxes'

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

describe('the worker probe', () => {
  /** An evaluator that answers the probe with `answer` and records what it was asked. */
  function probing(answer: () => Promise<unknown>, kind: EvaluatorKind = 'web') {
    const asked: { source: string; timeoutMs?: number }[] = []
    let disposed = 0
    const evaluator: PluginEvaluator = {
      kind,
      evaluate: async (source, _args, options) => {
        asked.push({
          source,
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
        return (await answer()) as never
      },
      dispose: () => {
        disposed += 1
      },
    }
    return { evaluator, asked, disposed: () => disposed }
  }

  it('says yes when the evaluator document starts a worker, asking it once', async () => {
    const yes = probing(async () => true)
    expect(await probePluginWorkers(() => yes.evaluator)).toBe(true)
    expect(yes.asked).toEqual([{ source: WORKER_PROBE_SOURCE, timeoutMs: 8_000 }])
    expect(yes.disposed()).toBe(1)
  })

  it('says no, and never rejects, wherever the worker or the document fails', async () => {
    for (const answer of [
      async () => false,
      async () => 'true',
      async () => {
        throw new Error('the document never answered')
      },
    ]) {
      const no = probing(answer)
      expect(await probePluginWorkers(() => no.evaluator)).toBe(false)
      expect(no.disposed()).toBe(1)
    }
    expect(
      await probePluginWorkers(() => {
        throw new Error('no evaluator here')
      }),
    ).toBe(false)
    // An in-process evaluator would run plugins in the page: not asked at all.
    const inProcess = probing(async () => true, 'in-process')
    expect(await probePluginWorkers(() => inProcess.evaluator)).toBe(false)
    expect(inProcess.asked).toEqual([])
  })

  it('starts a worker from a blob: URL in its document, and answers once it hears from it', async () => {
    // Run as a document would, with a stand-in Worker: it answers, or fails to start.
    const run = async (FakeWorker: unknown) => {
      const body = new Function('Worker', 'URL', 'Blob', WORKER_PROBE_SOURCE)
      const url = { createObjectURL: () => 'blob:null/1', revokeObjectURL: () => undefined }
      return body(FakeWorker, url, Blob) as Promise<unknown>
    }
    class Answers {
      onmessage: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor() {
        setTimeout(() => this.onmessage?.(), 0)
      }
      terminate() {}
    }
    class Refused {
      constructor() {
        throw new DOMException('blocked', 'SecurityError')
      }
    }
    expect(await run(Answers)).toBe(true)
    expect(await run(Refused)).toBe(false)
  })
})
