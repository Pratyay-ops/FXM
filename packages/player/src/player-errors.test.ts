import { currentQueueItem, FxmError, isFxmError } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isEngineError } from './engine'
import { Player, type PlayerOptions } from './player'
import { FakeEngine, FakeResolver, testStream, testTracks } from './testing'

function setup(options: Partial<PlayerOptions> = {}) {
  const engine = new FakeEngine()
  const resolver = new FakeResolver()
  const player = new Player({ engine, resolver, ...options })
  const failed: string[] = []
  player.on('trackfailed', ({ item }) => failed.push(item.track.title))
  return { engine, resolver, player, failed }
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/**
 * Runs every timer until none is left: for chains of retries that end by themselves. (Fake
 * timers delay a 0 ms timer that is scheduled inside another timer by 1 ms.)
 */
async function drain(): Promise<void> {
  await vi.runAllTimersAsync()
}

const current = (player: Player) => currentQueueItem(player.getState().queue)?.track.title
const url = (name: string) => `https://media.test/${name}`
const loadStarts = (engine: FakeEngine) =>
  engine.calls.filter((call) => call.method === 'load').map((call) => call.args[1])

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Player: retries', () => {
  it('asks the resolver again after a failure and resumes where playback stopped', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(testTracks('a', 'b'))
    engine.progress(42_000)
    engine.fail('network')
    expect(player.getState()).toMatchObject({ status: 'loading', buffering: true })
    await settle()
    const retry = resolver.requestsFor('a')[1]
    expect(retry).toMatchObject({
      reason: 'retry',
      attempt: 1,
      failure: { positionMs: 42_000, stream: testStream('a') },
    })
    expect(isEngineError(retry?.failure?.error, 'network')).toBe(true)
    expect(loadStarts(engine)).toEqual([0, 42_000])
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 42_000 })
  })

  it('waits longer before each retry', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(testTracks('a', 'b'))
    engine.fail('network')
    await settle()
    expect(resolver.requestsFor('a')).toHaveLength(2)
    engine.fail('network')
    await settle(999)
    expect(resolver.requestsFor('a')).toHaveLength(2)
    await settle(1)
    expect(resolver.requestsFor('a')).toHaveLength(3)
    engine.fail('decode')
    await settle(2999)
    expect(resolver.requestsFor('a')).toHaveLength(3)
    await settle(1)
    expect(resolver.requestsFor('a').map((request) => request.attempt)).toEqual([0, 1, 2, 3])
  })

  it('skips a track after its third retry fails', async () => {
    const { player, engine, resolver, failed } = setup({ retryDelaysMs: [0] })
    const errors: unknown[] = []
    player.on('trackfailed', ({ error }) => errors.push(error))
    await player.setQueue(testTracks('a', 'b'))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      engine.fail('unsupported')
      await settle()
    }
    expect(failed).toEqual(['a'])
    expect(isEngineError(errors[0], 'unsupported')).toBe(true)
    expect(current(player)).toBe('b')
    expect(resolver.requestsFor('a')).toHaveLength(4)
    expect(resolver.requestsFor('b')[0]).toMatchObject({ reason: 'play', attempt: 0 })
    expect(player.getState().status).toBe('playing')
  })

  it('counts a rejected resolution as a failed attempt', async () => {
    const { player, resolver, failed } = setup({ retryDelaysMs: [0] })
    resolver.handler = (item) => {
      if (item.track.title === 'a') throw new FxmError('Unavailable', 'Video unavailable')
      return { stream: testStream(item.track.title) }
    }
    await player.setQueue(testTracks('a', 'b'))
    await drain()
    expect(failed).toEqual(['a'])
    const requests = resolver.requestsFor('a')
    expect(requests.map((request) => request.attempt)).toEqual([0, 1, 2, 3])
    expect(requests[1]?.failure).not.toHaveProperty('stream')
    expect(isFxmError(requests[1]?.failure?.error, 'Unavailable')).toBe(true)
    expect(current(player)).toBe('b')
  })

  it('wraps a resolver failure that is not an Error', async () => {
    const { player, resolver } = setup({ maxRetries: 0 })
    const errors: Error[] = []
    player.on('trackfailed', ({ error }) => errors.push(error))
    resolver.handler = () => Promise.reject('nope')
    await player.setQueue(testTracks('a'))
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0]?.message).toBe('nope')
  })

  it('gives a track that played for 5 s a fresh set of retries', async () => {
    const { player, engine, resolver, failed } = setup({ retryDelaysMs: [0] })
    await player.setQueue(testTracks('a', 'b'))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      engine.fail('network')
      await settle()
    }
    engine.progress(4999)
    engine.progress(5000)
    engine.fail('network')
    await settle()
    expect(failed).toEqual([])
    expect(resolver.requestsFor('a').at(-1)?.attempt).toBe(1)
  })

  it('asks for another stream when the engine cannot play the first', async () => {
    const { player, engine, resolver } = setup()
    engine.canPlayStream = (stream) => (stream.codec === 'opus' ? 'no' : 'maybe')
    resolver.handler = (item, request) => ({
      stream: testStream(`${item.track.title}-${request.attempt}`, {
        codec: request.attempt === 0 ? 'opus' : 'aac',
        container: request.attempt === 0 ? 'webm' : 'm4a',
      }),
    })
    await player.setQueue(testTracks('a'))
    await settle()
    const retry = resolver.requestsFor('a')[1]
    expect(isEngineError(retry?.failure?.error, 'unsupported')).toBe(true)
    expect(engine.loadedUrls).toEqual([url('a-1')])
    expect(player.getState()).toMatchObject({ status: 'playing', stream: { codec: 'aac' } })
  })

  it('counts an engine that throws while loading as a failure', async () => {
    const { player, engine, resolver } = setup()
    const load = engine.load.bind(engine)
    let throws = true
    engine.load = async (source, startAtMs) => {
      if (throws) {
        throws = false
        throw new Error('bridge down')
      }
      await load(source, startAtMs)
    }
    await player.setQueue(testTracks('a'))
    await settle()
    expect(resolver.requestsFor('a')[1]?.failure?.error.message).toBe('bridge down')
    expect(player.getState().status).toBe('playing')
  })

  it('retries paused when the user paused in between', async () => {
    const { player, engine } = setup({ retryDelaysMs: [1000] })
    await player.setQueue(testTracks('a'))
    engine.fail('network')
    player.pause()
    await settle(1000)
    expect(engine.count('load')).toBe(2)
    expect(engine.calls.at(-1)?.method).toBe('load')
    expect(player.getState().status).toBe('paused')
  })

  it('skips to the next track paused when the user paused during the retries', async () => {
    const { player, engine, failed } = setup({ maxRetries: 0 })
    await player.setQueue(testTracks('a', 'b'))
    player.pause()
    engine.fail('network')
    expect(failed).toEqual(['a'])
    expect(current(player)).toBe('b')
    expect(player.getState().status).toBe('paused')
  })

  it('drops a pending retry when the user skips', async () => {
    const { player, engine, resolver } = setup({ retryDelaysMs: [1000] })
    await player.setQueue(testTracks('a', 'b'))
    engine.fail('network')
    await player.next()
    await settle(5000)
    expect(resolver.requestsFor('a')).toHaveLength(1)
    expect(engine.loadedUrls).toEqual([url('a'), url('b')])
  })

  it('does not stack another attempt when play is pressed during the delay', async () => {
    const { player, engine, resolver } = setup({ retryDelaysMs: [1000] })
    await player.setQueue(testTracks('a'))
    engine.fail('network')
    await player.play()
    await settle(5000)
    expect(resolver.requestsFor('a')).toHaveLength(2)
    expect(player.getState().status).toBe('playing')
  })

  it('stops with an error when the last track keeps failing', async () => {
    const { player, engine, failed } = setup({ retryDelaysMs: [0] })
    await player.setQueue(testTracks('a'))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      engine.fail('decode')
      await settle()
    }
    expect(failed).toEqual(['a'])
    const { status, error } = player.getState()
    expect(status).toBe('error')
    expect(error?.reason).toBe('track-failed')
    expect(error?.item.track.title).toBe('a')
    expect(isEngineError(error?.error, 'decode')).toBe(true)
  })

  it('tries a failed track again when the user presses play', async () => {
    const { player, engine, resolver } = setup({ maxRetries: 0 })
    await player.setQueue(testTracks('a'))
    engine.progress(30_000)
    engine.fail('network')
    expect(player.getState().status).toBe('error')
    await player.play()
    expect(resolver.requestsFor('a').at(-1)).toMatchObject({ reason: 'play', attempt: 0 })
    expect(loadStarts(engine).at(-1)).toBe(30_000)
    expect(player.getState()).toMatchObject({ status: 'playing', error: undefined })
  })
})

describe('Player: after a failure', () => {
  it('loads the failed track again when "previous" restarts it', async () => {
    const { player, engine, resolver } = setup({ maxRetries: 0 })
    await player.setQueue(testTracks('a'))
    engine.progress(30_000)
    engine.fail('network')
    expect(player.getState().status).toBe('error')
    await player.previous()
    expect(resolver.requestsFor('a').at(-1)).toMatchObject({ reason: 'play', attempt: 0 })
    expect(loadStarts(engine).at(-1)).toBe(0)
    expect(player.getState().status).toBe('playing')
  })
})

describe('Player: circuit breaker', () => {
  it('stops after four tracks fail in a row', async () => {
    const { player, resolver, failed } = setup({ retryDelaysMs: [0] })
    const opened = vi.fn()
    player.on('circuitopen', opened)
    resolver.handler = () => {
      throw new FxmError('Network', 'offline')
    }
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e', 'f'))
    await drain()
    expect(failed).toEqual(['a', 'b', 'c', 'd'])
    expect(opened).toHaveBeenCalledWith({ failures: 4 })
    expect(resolver.requests).toHaveLength(16)
    const { status, error } = player.getState()
    expect(status).toBe('error')
    expect(error?.reason).toBe('circuit-open')
    expect(current(player)).toBe('d')
    await settle(60_000)
    expect(resolver.requests).toHaveLength(16)
  })

  it('lets the user try again after it opens', async () => {
    const { player, resolver, failed } = setup({ retryDelaysMs: [0] })
    resolver.handler = (item) => {
      if (item.track.title !== 'e') throw new FxmError('Network', 'offline')
      return { stream: testStream('e') }
    }
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e'))
    await drain()
    expect(player.getState().status).toBe('error')
    await player.next()
    expect(current(player)).toBe('e')
    expect(player.getState()).toMatchObject({ status: 'playing', error: undefined })
    expect(failed).toEqual(['a', 'b', 'c', 'd'])
  })

  it('counts from zero again after a track plays', async () => {
    const { player, engine, resolver, failed } = setup({ retryDelaysMs: [0], maxRetries: 0 })
    resolver.handler = (item) => {
      if (item.track.title === 'd') return { stream: testStream('d') }
      throw new FxmError('Unavailable', 'gone')
    }
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'))
    await settle()
    expect(failed).toEqual(['a', 'b', 'c'])
    expect(current(player)).toBe('d')
    engine.progress(6000)
    engine.end()
    await settle()
    expect(failed).toEqual(['a', 'b', 'c', 'e', 'f', 'g', 'h'])
    expect(player.getState().error?.reason).toBe('circuit-open')
  })

  it('keeps skipping when a track ends successfully in between', async () => {
    const { player, engine, failed } = setup({ maxRetries: 0, maxConsecutiveFailures: 2 })
    await player.setQueue(testTracks('a', 'b', 'c', 'd'))
    engine.fail('network')
    expect(failed).toEqual(['a'])
    await settle()
    engine.end()
    await settle()
    engine.fail('network')
    await settle()
    expect(failed).toEqual(['a', 'c'])
    expect(current(player)).toBe('d')
    expect(player.getState().status).toBe('playing')
  })
})

describe('Player: autoplay policy', () => {
  it('pauses and announces a blocked start without retrying', async () => {
    const { player, engine, resolver } = setup()
    const blocked = vi.fn()
    player.on('autoplayblocked', blocked)
    engine.playError = 'autoplay-blocked'
    await player.setQueue(testTracks('a'))
    expect(blocked).toHaveBeenCalledOnce()
    expect(player.getState()).toMatchObject({ status: 'paused', buffering: false })
    await settle(20_000)
    expect(resolver.requests).toHaveLength(1)
    engine.playError = undefined
    await player.play()
    expect(engine.count('load')).toBe(1)
    expect(player.getState().status).toBe('playing')
  })
})

describe('Player: stalls', () => {
  it('shows buffering while the engine waits for data', async () => {
    const { player, engine } = setup()
    await player.setQueue(testTracks('a'))
    engine.emit('waiting', undefined)
    expect(player.getState().buffering).toBe(true)
    engine.emit('play', undefined)
    expect(player.getState()).toMatchObject({ buffering: false, status: 'playing' })
  })

  it('retries when playback waits too long for data', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(testTracks('a'))
    engine.progress(20_000)
    engine.emit('stalled', undefined)
    await settle(14_999)
    expect(resolver.requests).toHaveLength(1)
    await settle(2)
    const retry = resolver.requestsFor('a')[1]
    expect(retry).toMatchObject({ reason: 'retry', failure: { positionMs: 20_000 } })
    expect(isEngineError(retry?.failure?.error, 'network')).toBe(true)
  })

  it('retries when a track never starts', async () => {
    const { player, engine, resolver } = setup({ stallTimeoutMs: 5000 })
    engine.startOnPlay = false
    await player.setQueue(testTracks('a'))
    await settle(4999)
    expect(resolver.requests).toHaveLength(1)
    await settle(2)
    expect(resolver.requests).toHaveLength(2)
  })

  it('does not time out once data arrives, while paused, or when turned off', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(testTracks('a'))
    engine.emit('waiting', undefined)
    engine.emit('waiting', undefined)
    engine.emit('play', undefined)
    await settle(20_000)
    engine.emit('waiting', undefined)
    player.pause()
    engine.emit('waiting', undefined)
    await settle(20_000)
    expect(resolver.requests).toHaveLength(1)
    const off = setup({ stallTimeoutMs: 0 })
    off.engine.startOnPlay = false
    await off.player.setQueue(testTracks('a'))
    await settle(60_000)
    expect(off.resolver.requests).toHaveLength(1)
  })

  it('follows a pause that comes from the system', async () => {
    const { player, engine } = setup()
    await player.setQueue(testTracks('a'))
    engine.paused = false
    engine.pause()
    expect(player.getState().status).toBe('paused')
    engine.emit('pause', undefined)
    expect(player.getState().status).toBe('paused')
  })
})

describe('Player: expiring streams', () => {
  it('resolves a fresh stream before resuming one that expires soon', async () => {
    let now = 1_000_000
    const { player, engine, resolver } = setup({ now: () => now })
    resolver.handler = (item, request) => ({
      stream: testStream(`${item.track.title}-${request.reason}`, { expiresAt: now + 60 * 60_000 }),
    })
    await player.setQueue(testTracks('a'))
    engine.progress(30_000)
    player.pause()
    now += 55 * 60_000
    await player.play()
    const refresh = resolver.requests.at(-1)?.request
    expect(refresh).toMatchObject({ reason: 'refresh', failure: { positionMs: 30_000 } })
    expect(isEngineError(refresh?.failure?.error, 'expired')).toBe(true)
    expect(engine.loadedUrls).toEqual([url('a-play'), url('a-refresh')])
    expect(loadStarts(engine)).toEqual([0, 30_000])
  })

  it('resumes a stream that is still fresh', async () => {
    let now = 1_000_000
    const { player, engine, resolver } = setup({ now: () => now })
    resolver.handler = () => ({ stream: testStream('a', { expiresAt: now + 6 * 60 * 60_000 }) })
    await player.setQueue(testTracks('a'))
    player.pause()
    now += 60 * 60_000
    await player.play()
    expect(engine.count('load')).toBe(1)
    expect(player.getState().status).toBe('playing')
  })
})
