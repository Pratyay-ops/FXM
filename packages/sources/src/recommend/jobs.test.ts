import { FxmError, type ProviderContext } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sleep } from '../shared/gate'
import {
  beforeDeadline,
  deadlineOf,
  type Job,
  type JobResult,
  linkedController,
  runJobs,
  Skip,
  TIMED_OUT,
  untilAborted,
} from './jobs'
import { testContext } from './testing'

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
})

afterEach(() => {
  vi.useRealTimers()
})

/** A job of the YouTube Music radio that does `work`. */
function job(work: Job<string>['work'], skipFor?: Job<string>['skipFor']): Job<string> {
  return skipFor === undefined
    ? { source: 'ytm', part: 'radio', work }
    : { source: 'ytm', part: 'radio', work, skipFor }
}

/** A result's status and detail. */
function status(result: JobResult<string>): string {
  const { outcome } = result
  if (outcome.status === 'ok') return `ok ${result.items.join(',')}`
  if (outcome.status === 'skipped') return `skipped ${outcome.reason}`
  if (outcome.status === 'failed') return `failed ${outcome.code}`
  return `timed-out ${outcome.afterMs}`
}

describe('deadlineOf', () => {
  it('takes finite milliseconds from 0, and nothing else', () => {
    expect(deadlineOf(1_500)).toBe(1_500)
    expect(deadlineOf(-5)).toBe(0)
    expect(deadlineOf(Number.NaN)).toBeUndefined()
    expect(deadlineOf(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(deadlineOf(undefined)).toBeUndefined()
  })
})

describe('runJobs', () => {
  it('settles every job into an outcome, in the jobs’ order', async () => {
    const results = await runJobs(
      [
        job(async () => ['a', 'b']),
        job(async () => new Skip('not-configured')),
        job(async () => {
          throw new FxmError('Network', 'offline')
        }),
        job(
          async () => {
            throw new FxmError('Unsupported', 'not this seed')
          },
          () => 'unsupported-seed',
        ),
        job(async () => {
          throw 'odd'
        }),
      ],
      testContext(),
    )
    expect(results.map(status)).toEqual([
      'ok a,b',
      'skipped not-configured',
      'failed Network',
      'skipped unsupported-seed',
      'failed Unknown',
    ])
    expect(results[4]?.outcome).toMatchObject({ message: 'odd', error: 'odd' })
  })

  it('cuts off and cancels what is still running at the deadline', async () => {
    let signal: AbortSignal | undefined
    const delivered: string[] = []
    const pending = runJobs(
      [
        job(async () => ['quick']),
        job(async (ctx: ProviderContext) => {
          signal = ctx.signal
          await sleep(10_000, ctx.signal)
          return ['slow']
        }),
      ],
      testContext(),
      { deadlineMs: 1_000, onResult: (result) => delivered.push(status(result)) },
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await pending).map(status)).toEqual(['ok quick', 'timed-out 1000'])
    expect(signal?.aborted).toBe(true)
    expect(delivered).toEqual(['ok quick', 'timed-out 1000'])
    // The cancelled job's own failure, later, changes nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(delivered).toHaveLength(2)
  })

  it('rejects at once when the caller cancels, whether or not the jobs heed it', async () => {
    const controller = new AbortController()
    const pending = runJobs(
      [job(() => new Promise<string[]>(() => undefined))],
      testContext({ signal: controller.signal }),
    )
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await expect(
      runJobs([job(async () => [])], testContext({ signal: AbortSignal.abort(reason) })),
    ).rejects.toBe(reason)
  })

  it('rejects with the error of an onResult that throws, and cancels the rest', async () => {
    let signal: AbortSignal | undefined
    const bug = new Error('bug')
    const pending = runJobs(
      [
        job(async () => ['quick']),
        job(async (ctx: ProviderContext) => {
          signal = ctx.signal
          await sleep(10_000, ctx.signal)
          return ['slow']
        }),
      ],
      testContext(),
      {
        onResult: () => {
          throw bug
        },
      },
    )
    await expect(pending).rejects.toBe(bug)
    expect(signal?.aborted).toBe(true)
  })
})

describe('untilAborted', () => {
  it('settles with the promise, or rejects when the signal aborts first', async () => {
    expect(await untilAborted(Promise.resolve(1), undefined)).toBe(1)
    const controller = new AbortController()
    const pending = untilAborted(new Promise(() => undefined), controller.signal)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrowError('stop')
  })

  it('leaves no rejection unhandled when the signal had already aborted', async () => {
    const late = Promise.reject(new Error('late'))
    await expect(untilAborted(late, AbortSignal.abort(new Error('gone')))).rejects.toThrowError(
      'gone',
    )
  })
})

describe('linkedController', () => {
  it('aborts with the outer signal, and lets go of it when disposed', () => {
    const outer = new AbortController()
    const first = linkedController(outer.signal)
    first.dispose()
    const second = linkedController(outer.signal)
    outer.abort('why')
    expect(first.controller.signal.aborted).toBe(false)
    expect(second.controller.signal.reason).toBe('why')
    expect(linkedController(outer.signal).controller.signal.aborted).toBe(true)
  })
})

describe('beforeDeadline', () => {
  it('returns the result in time, or TIMED_OUT after cancelling the work', async () => {
    const quick = beforeDeadline(async () => 'done', Date.now() + 1_000, undefined)
    expect(await quick).toBe('done')
    let signal: AbortSignal | undefined
    const slow = beforeDeadline(
      async (own) => {
        signal = own
        await sleep(5_000, own)
        return 'late'
      },
      Date.now() + 1_000,
      undefined,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await slow).toBe(TIMED_OUT)
    expect(signal?.aborted).toBe(true)
  })

  it('rejects with the caller’s reason when the caller cancels', async () => {
    const controller = new AbortController()
    const pending = beforeDeadline(
      () => new Promise<string>(() => undefined),
      Date.now() + 1_000,
      controller.signal,
    )
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrowError('stop')
  })
})
