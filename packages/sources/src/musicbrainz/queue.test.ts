import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuePausedError, RequestQueue } from './queue'

/** A task that records when it started and resolves with `value`, after `ms` when given. */
function task<T>(starts: number[], value: T, ms = 0): () => Promise<T> {
  return () => {
    starts.push(Date.now())
    if (ms === 0) return Promise.resolve(value)
    return new Promise((resolve) => setTimeout(() => resolve(value), ms))
  }
}

/** The error a promise rejects with, caught at once so that it never goes unhandled. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('RequestQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts tasks one second apart, in the order they were queued', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    const results = Promise.all([
      queue.run(task(starts, 'a')),
      queue.run(task(starts, 'b')),
      queue.run(task(starts, 'c')),
    ])
    expect(starts).toEqual([0])
    expect(queue.waiting).toBe(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    expect(starts).toEqual([0, 1000])
    await vi.advanceTimersByTimeAsync(1000)
    expect(starts).toEqual([0, 1000, 2000])
    await expect(results).resolves.toEqual(['a', 'b', 'c'])
    expect(queue.waiting).toBe(0)
  })

  it('spaces starts, not ends, so a slow task does not delay the next one further', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    const slow = queue.run(task(starts, 'slow', 5000))
    const next = queue.run(task(starts, 'next'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(starts).toEqual([0, 1000])
    await expect(next).resolves.toBe('next')
    await vi.advanceTimersByTimeAsync(4000)
    await expect(slow).resolves.toBe('slow')
  })

  it('starts a task at once when the last one started long enough ago', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    await queue.run(task(starts, 1))
    await vi.advanceTimersByTimeAsync(2500)
    await queue.run(task(starts, 2))
    expect(starts).toEqual([0, 2500])
  })

  it('passes a failure to its caller and goes on with the next task', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    const failing = failure(
      queue.run(async () => {
        starts.push(Date.now())
        throw new Error('boom')
      }),
    )
    const thrown = failure(
      queue.run(() => {
        starts.push(Date.now())
        throw new Error('sync boom')
      }),
    )
    const next = queue.run(task(starts, 'next'))
    expect(await failing).toMatchObject({ message: 'boom' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await thrown).toMatchObject({ message: 'sync boom' })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(next).resolves.toBe('next')
    expect(starts).toEqual([0, 1000, 2000])
  })

  it('drops a waiting task whose signal aborts, without giving up its turn to nobody', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    const controller = new AbortController()
    const first = queue.run(task(starts, 'first'))
    const dropped = failure(queue.run(task(starts, 'dropped'), { signal: controller.signal }))
    const last = queue.run(task(starts, 'last'))
    controller.abort(new Error('not needed'))
    expect(await dropped).toMatchObject({ message: 'not needed' })
    expect(queue.waiting).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(Promise.all([first, last])).resolves.toEqual(['first', 'last'])
    expect(starts).toEqual([0, 1000])
  })

  it('refuses a task whose signal has already aborted, and runs nothing', async () => {
    const queue = new RequestQueue(1000)
    const run = vi.fn(async () => 'never')
    const reason = new Error('too late')
    await expect(queue.run(run, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(run).not.toHaveBeenCalled()
    expect(queue.waiting).toBe(0)
  })

  it('ignores an abort once the task has started', async () => {
    const queue = new RequestQueue(1000)
    const controller = new AbortController()
    const running = queue.run(task([], 'done', 100), { signal: controller.signal })
    controller.abort()
    await vi.advanceTimersByTimeAsync(100)
    await expect(running).resolves.toBe('done')
  })

  it('holds every waiting and later task back after a pause', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    const first = queue.run(task(starts, 1))
    const second = queue.run(task(starts, 2))
    queue.pause(5000)
    await vi.advanceTimersByTimeAsync(4999)
    expect(starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    expect(starts).toEqual([0, 5000])
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    const third = queue.run(task(starts, 3))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(third).resolves.toBe(3)
    expect(starts).toEqual([0, 5000, 6000])
  })

  it('never lets a short pause bring the next start forward', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    const first = queue.run(task(starts, 1))
    const second = queue.run(task(starts, 2))
    queue.pause(200)
    queue.pause(-5)
    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(starts).toEqual([0, 1000])
  })

  it('remembers a pause made while idle for the next task', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    queue.pause(3000)
    const later = queue.run(task(starts, 'later'))
    await vi.advanceTimersByTimeAsync(3000)
    await expect(later).resolves.toBe('later')
    expect(starts).toEqual([3000])
  })

  it('starts higher priorities first, first come first served within one, still a second apart', async () => {
    const queue = new RequestQueue(1000)
    const order: string[] = []
    const named = (name: string) => async () => {
      order.push(`${name}@${Date.now()}`)
      return name
    }
    const all = Promise.all([
      queue.run(named('bulk 1'), { priority: 'bulk' }),
      queue.run(named('bulk 2'), { priority: 'bulk' }),
      queue.run(named('bulk 3'), { priority: 'bulk' }),
      queue.run(named('interactive'), { priority: 'interactive' }),
    ])
    // The user presses play while an import waits in the queue.
    const playing = queue.run(named('current track'), { priority: 'current-track' })
    await vi.advanceTimersByTimeAsync(4000)
    await Promise.all([all, playing])
    expect(order).toEqual([
      'bulk 1@0',
      'current track@1000',
      'interactive@2000',
      'bulk 2@3000',
      'bulk 3@4000',
    ])
  })

  it('refuses a task that would wait out a pause for longer than it may, and keeps the pause', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    queue.pause(3_600_000)
    const refused = await failure(queue.run(task(starts, 'x'), { maxWaitMs: 30_000 }))
    expect(refused).toBeInstanceOf(QueuePausedError)
    expect(refused).toMatchObject({ retryAfterMs: 3_600_000 })
    const patient = queue.run(task(starts, 'patient'))
    await vi.advanceTimersByTimeAsync(3_600_000)
    await expect(patient).resolves.toBe('patient')
    expect(starts).toEqual([3_600_000])
  })

  it('rejects the waiting tasks a new pause would keep too long, and only those', async () => {
    const queue = new RequestQueue(1000)
    const starts: number[] = []
    const first = queue.run(task(starts, 'first'))
    const hurried = failure(queue.run(task(starts, 'hurried'), { maxWaitMs: 30_000 }))
    const patient = queue.run(task(starts, 'patient'), { maxWaitMs: 120_000 })
    await vi.advanceTimersByTimeAsync(500)
    queue.pause(60_000)
    expect(await hurried).toMatchObject({ name: 'QueuePausedError', retryAfterMs: 60_000 })
    expect(queue.waiting).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(Promise.all([first, patient])).resolves.toEqual(['first', 'patient'])
    expect(starts).toEqual([0, 60_500])
  })
})
