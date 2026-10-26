import { describe, expect, it } from 'vitest'
import { SerialLane } from './lane'

/** A promise to wait on, and the function that settles it. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

describe('SerialLane', () => {
  it('runs tasks one at a time, first queued first', async () => {
    const lane = new SerialLane()
    const log: string[] = []
    const first = gate()
    const one = lane.run(async () => {
      log.push('one starts')
      await first.opened
      log.push('one ends')
      return 1
    })
    const two = lane.run(async () => {
      log.push('two')
      return 2
    })
    await Promise.resolve()
    expect(lane.busy).toBe(true)
    expect(log).toEqual(['one starts'])
    first.open()
    expect(await Promise.all([one, two])).toEqual([1, 2])
    expect(log).toEqual(['one starts', 'one ends', 'two'])
    expect(lane.busy).toBe(false)
  })

  it('never runs a task stopped while it waits', async () => {
    const lane = new SerialLane()
    const first = gate()
    const running = lane.run(() => first.opened)
    const controller = new AbortController()
    let ran = false
    const waiting = lane.run(async () => {
      ran = true
    }, controller.signal)
    controller.abort()
    expect(await waiting).toBeUndefined()
    first.open()
    await running
    expect(ran).toBe(false)
    expect(lane.busy).toBe(false)
  })

  it('goes on after a task fails', async () => {
    const lane = new SerialLane()
    const failed = lane.run(() => Promise.reject(new Error('broken')))
    const next = lane.run(async () => 'next')
    await expect(failed).rejects.toThrow('broken')
    expect(await next).toBe('next')
  })

  it('calls onIdle when the last task is over, and waits for what it queues', async () => {
    const lane = new SerialLane()
    const log: string[] = []
    let idle = 0
    lane.onIdle = () => {
      idle++
      if (idle === 1) void lane.run(async () => void log.push('clean up'))
    }
    void lane.run(async () => void log.push('scan'))
    await lane.whenIdle()
    expect(log).toEqual(['scan', 'clean up'])
    expect(idle).toBe(2)
    await expect(lane.whenIdle()).resolves.toBeUndefined()
  })
})
