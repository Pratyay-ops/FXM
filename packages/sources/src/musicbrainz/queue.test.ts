import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestQueue } from './queue'

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
    const dropped = failure(queue.run(task(starts, 'dropped'), controller.signal))
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
    await expect(queue.run(run, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(run).not.toHaveBeenCalled()
    expect(queue.waiting).toBe(0)
  })

  it('ignores an abort once the task has started', async () => {
    const queue = new RequestQueue(1000)
    const controller = new AbortController()
    const running = queue.run(task([], 'done', 100), controller.signal)
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
})
