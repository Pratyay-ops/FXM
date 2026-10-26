import { describe, expect, it } from 'vitest'
import { backoffMs, createSyncScheduler, type RunResult, type SyncTrigger } from './scheduler'

/** A clock and timers that move only when the test says so. */
function fakeTime() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number)
    },
    /** Moves time forward, firing due timers in order and letting runs settle. */
    async advance(ms: number) {
      const end = now + ms
      const settle = async () => {
        for (let index = 0; index < 5; index++) await Promise.resolve()
      }
      await settle()
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = due[1].at
        due[1].callback()
        // Let the run's promise settle.
        await settle()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

function setup(results: RunResult[] = []) {
  const time = fakeTime()
  const runs: { trigger: SyncTrigger; at: number }[] = []
  const scheduler = createSyncScheduler({
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    run: async (trigger) => {
      runs.push({ trigger, at: time.now() })
      return results.shift() ?? { ok: true }
    },
  })
  return { time, runs, scheduler }
}

describe('createSyncScheduler', () => {
  it('syncs at start, and at most once a minute when the user comes back', async () => {
    const { time, runs, scheduler } = setup()
    scheduler.trigger('start')
    await time.advance(0)
    scheduler.trigger('focus')
    await time.advance(30_000)
    scheduler.trigger('focus')
    await time.advance(0)
    expect(runs.map((run) => run.trigger)).toEqual(['start'])
    await time.advance(31_000)
    scheduler.trigger('focus')
    scheduler.trigger('interval')
    await time.advance(0)
    expect(runs.map((run) => run.trigger)).toEqual(['start', 'focus'])
  })

  it('syncs edits a few seconds after the last one, at most half a minute after the first', async () => {
    const { time, runs, scheduler } = setup()
    scheduler.changed('edit')
    await time.advance(4000)
    scheduler.changed('edit')
    await time.advance(4000)
    expect(runs).toEqual([])
    await time.advance(1000)
    expect(runs).toEqual([{ trigger: 'change', at: 9000 }])

    // A stream of edits still syncs within 30 s.
    for (let index = 0; index < 12; index++) {
      scheduler.changed('edit')
      await time.advance(3000)
    }
    expect(runs.map((run) => run.at)).toEqual([9000, 39_000])
  })

  it('lets background changes wait longer, and an edit hurries them', async () => {
    const { time, runs, scheduler } = setup()
    scheduler.changed('background')
    await time.advance(9 * 60_000)
    expect(runs).toEqual([])
    await time.advance(60_000)
    expect(runs).toHaveLength(1)

    scheduler.changed('background')
    await time.advance(1000)
    scheduler.changed('edit')
    await time.advance(5000)
    expect(runs).toHaveLength(2)
  })

  it('syncs plays coming every few minutes within the hour', async () => {
    const { time, runs, scheduler } = setup()
    for (let index = 0; index < 20; index++) {
      scheduler.changed('background')
      await time.advance(4 * 60_000)
    }
    expect(runs.map((run) => run.at)).toEqual([3_600_000])
  })

  it('retries after failures by itself, backing off, as long as GitHub asks when it does', async () => {
    const { time, runs, scheduler } = setup([
      { ok: false, fatal: false },
      { ok: false, fatal: false },
      { ok: false, fatal: false, retryAfterMs: 10 * 60_000 },
    ])
    scheduler.trigger('start')
    await time.advance(60 * 60_000)
    // 30 s, then 60 s, then the 10 minutes GitHub asked for; then it worked, and stops.
    expect(runs).toEqual([
      { trigger: 'start', at: 0 },
      { trigger: 'start', at: 30_000 },
      { trigger: 'start', at: 90_000 },
      { trigger: 'start', at: 690_000 },
    ])
  })

  it('lets changes during a backoff wait for it', async () => {
    const { time, runs, scheduler } = setup([{ ok: false, fatal: false }])
    scheduler.trigger('start')
    await time.advance(0)
    scheduler.changed('edit')
    await time.advance(29_000)
    expect(runs).toHaveLength(1)
    await time.advance(1000)
    expect(runs.map((run) => run.at)).toEqual([0, 30_000])
    await time.advance(60 * 60_000)
    expect(runs).toHaveLength(2)
  })

  it('forgets the backoff when the device is back online', async () => {
    const { time, runs, scheduler } = setup([{ ok: false, fatal: false }])
    scheduler.trigger('start')
    await time.advance(0)
    scheduler.online()
    await time.advance(0)
    expect(runs.map((run) => run.trigger)).toEqual(['start', 'online'])
  })

  it('stops after a failure only the user can fix', async () => {
    const { time, runs, scheduler } = setup([{ ok: false, fatal: true }])
    scheduler.trigger('start')
    await time.advance(0)
    scheduler.changed('edit')
    scheduler.trigger('manual')
    await time.advance(60 * 60_000)
    expect(runs).toHaveLength(1)
    expect(time.pending()).toBe(0)
  })

  it('never runs twice at once, and runs again after a trigger during a run', async () => {
    const time = fakeTime()
    const runs: SyncTrigger[] = []
    let finish: (() => void) | undefined
    const scheduler = createSyncScheduler({
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
      run: (trigger) => {
        runs.push(trigger)
        return new Promise<RunResult>((resolve) => {
          finish = () => resolve({ ok: true })
        })
      },
    })
    scheduler.trigger('start')
    await time.advance(0)
    scheduler.changed('edit')
    await time.advance(10_000)
    expect(runs).toEqual(['start'])
    finish?.()
    await time.advance(0)
    expect(runs).toEqual(['start', 'change'])
  })

  it('cancels what is planned when stopped', async () => {
    const { time, runs, scheduler } = setup()
    scheduler.changed('edit')
    scheduler.stop()
    scheduler.trigger('start')
    await time.advance(60_000)
    expect(runs).toEqual([])
  })
})

describe('backoffMs', () => {
  it('doubles from 30 seconds up to 30 minutes', () => {
    expect([1, 2, 3, 7, 20].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 1_800_000, 1_800_000])
  })
})
