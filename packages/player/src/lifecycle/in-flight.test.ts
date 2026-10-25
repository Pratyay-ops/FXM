import { describe, expect, it } from 'vitest'
import { InFlight } from './in-flight'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('InFlight', () => {
  it('shares one piece of work between callers of the same key', async () => {
    const flights = new InFlight<string>()
    const work = deferred<string>()
    let started = 0
    const start = () => {
      started += 1
      return work.promise
    }
    const first = flights.run('k', new AbortController().signal, start)
    const second = flights.run('k', new AbortController().signal, start)
    expect(flights.size).toBe(1)
    work.resolve('done')
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done'])
    expect(started).toBe(1)
    expect(flights.size).toBe(0)
  })

  it('shares a failure too, then starts afresh', async () => {
    const flights = new InFlight<string>()
    const signal = new AbortController().signal
    const failing = flights.run('k', signal, async () => {
      throw new Error('nope')
    })
    await expect(failing).rejects.toThrow('nope')
    await expect(flights.run('k', signal, async () => 'again')).resolves.toBe('again')
  })

  it('reports a work function that throws at once as a rejection', async () => {
    const flights = new InFlight<string>()
    const run = flights.run('k', new AbortController().signal, () => {
      throw new Error('sync')
    })
    await expect(run).rejects.toThrow('sync')
  })

  it('lets one caller give up while another still waits', async () => {
    const flights = new InFlight<string>()
    const work = deferred<string>()
    let signalSeen: AbortSignal | undefined
    const start = (signal: AbortSignal) => {
      signalSeen = signal
      return work.promise
    }
    const leaving = new AbortController()
    const first = flights.run('k', leaving.signal, start)
    const second = flights.run('k', new AbortController().signal, start)
    leaving.abort(new Error('skipped'))
    await expect(first).rejects.toThrow('skipped')
    expect(signalSeen?.aborted).toBe(false)
    work.resolve('done')
    await expect(second).resolves.toBe('done')
  })

  it('aborts the work when every caller gave up, so the next caller starts afresh', async () => {
    const flights = new InFlight<string>()
    let signalSeen: AbortSignal | undefined
    const caller = new AbortController()
    const first = flights.run('k', caller.signal, (signal) => {
      signalSeen = signal
      return new Promise<string>(() => {})
    })
    caller.abort(new Error('gone'))
    await expect(first).rejects.toThrow('gone')
    expect(signalSeen?.aborted).toBe(true)
    expect(flights.size).toBe(0)
    await expect(flights.run('k', new AbortController().signal, async () => 'new')).resolves.toBe(
      'new',
    )
  })

  it('rejects at once for a caller that already gave up', async () => {
    const flights = new InFlight<string>()
    const caller = new AbortController()
    caller.abort(new Error('early'))
    let started = false
    await expect(
      flights.run('k', caller.signal, async () => {
        started = true
        return 'x'
      }),
    ).rejects.toThrow('early')
    expect(started).toBe(false)
  })

  it('forgets the work in flight on clear, while its callers still get the result', async () => {
    const flights = new InFlight<string>()
    const work = deferred<string>()
    const signal = new AbortController().signal
    const first = flights.run('k', signal, () => work.promise)
    flights.clear()
    const second = flights.run('k', signal, async () => 'fresh')
    work.resolve('old')
    await expect(first).resolves.toBe('old')
    await expect(second).resolves.toBe('fresh')
  })
})
