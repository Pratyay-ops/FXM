import { currentQueueItem, FXM_ERROR_CODES, FxmError, isFxmError } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError, isEngineError } from './engine'
import { classifyFailure, Player, type PlayerOptions } from './player'
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

/** Reports advancing positions every 250 ms for `durationMs`, as a playing engine does. */
async function playFor(engine: FakeEngine, fromMs: number, durationMs: number): Promise<void> {
  for (let elapsed = 250; elapsed <= durationMs; elapsed += 250) {
    await settle(250)
    engine.progress(fromMs + elapsed)
  }
}

const current = (player: Player) => currentQueueItem(player.getState().queue)?.track.title
const url = (name: string) => `https://media.test/${name}`

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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
    expect(engine.loadStarts).toEqual([0, 42_000])
    expect(player.getState()).toMatchObject({ status: 'playing', positionMs: 42_000 })
  })

  it('resumes at the original position when a retry fails before it plays', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(testTracks('a', 'b'))
    engine.progress(10_945)
    engine.startOnPlay = false
    engine.fail('network')
    await settle()
    // A real element reports the 0 it leaves before the start position applies.
    engine.progress(0)
    engine.fail('unsupported')
    await settle(1000)
    expect(resolver.requestsFor('a').map((request) => request.failure?.positionMs)).toEqual([
      undefined,
      10_945,
      10_945,
    ])
    expect(engine.loadStarts).toEqual([0, 10_945, 10_945])
    expect(player.getState().positionMs).toBe(10_945)
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
    const changes: string[] = []
    player.on('trackfailed', ({ error }) => errors.push(error))
    player.on('trackchange', ({ item, cause }) => changes.push(`${item?.track.title} ${cause}`))
    await player.setQueue(testTracks('a', 'b'))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      engine.fail('unsupported')
      await settle()
    }
    expect(failed).toEqual(['a'])
    expect(isEngineError(errors[0], 'unsupported')).toBe(true)
    expect(current(player)).toBe('b')
    expect(changes).toEqual(['a queue', 'b failed'])
    expect(resolver.requestsFor('a')).toHaveLength(4)
    expect(resolver.requestsFor('b')[0]).toMatchObject({ reason: 'play', attempt: 0 })
    expect(player.getState().status).toBe('playing')
  })

  it('counts a rejected resolution as a failed attempt', async () => {
    const { player, resolver, failed } = setup({ retryDelaysMs: [0] })
    resolver.handler = (item) => {
      if (item.track.title === 'a') throw new FxmError('Network', 'offline')
      return { stream: testStream(item.track.title) }
    }
    await player.setQueue(testTracks('a', 'b'))
    await drain()
    expect(failed).toEqual(['a'])
    const requests = resolver.requestsFor('a')
    expect(requests.map((request) => request.attempt)).toEqual([0, 1, 2, 3])
    expect(requests[1]?.failure).not.toHaveProperty('stream')
    expect(isFxmError(requests[1]?.failure?.error, 'Network')).toBe(true)
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

  it('never hands the engine a capped stream', async () => {
    const { player, engine, resolver } = setup()
    resolver.handler = (item, request) => ({
      stream: testStream(`${item.track.title}-${request.attempt}`, {
        fullLength: request.attempt === 0 ? 'capped' : 'verified',
      }),
    })
    await player.setQueue(testTracks('a'))
    await settle()
    const retry = resolver.requestsFor('a')[1]
    expect(isEngineError(retry?.failure?.error, 'unsupported')).toBe(true)
    expect(retry?.failure?.stream?.fullLength).toBe('capped')
    expect(engine.loadedUrls).toEqual([url('a-1')])
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

  it('tries a failed track again with its failure when the user presses play', async () => {
    const { player, engine, resolver } = setup({ maxRetries: 0 })
    await player.setQueue(testTracks('a'))
    engine.progress(30_000)
    engine.fail('network')
    expect(player.getState().status).toBe('error')
    await player.play()
    expect(resolver.requestsFor('a').at(-1)).toMatchObject({
      reason: 'retry',
      attempt: 1,
      failure: { positionMs: 30_000, stream: testStream('a') },
    })
    expect(engine.loadStarts.at(-1)).toBe(30_000)
    expect(player.getState()).toMatchObject({ status: 'playing', error: undefined })
  })

  it('loads the failed track again from the start when "previous" restarts it', async () => {
    const { player, engine, resolver } = setup({ maxRetries: 0 })
    await player.setQueue(testTracks('a'))
    engine.progress(30_000)
    engine.fail('network')
    expect(player.getState().status).toBe('error')
    await player.previous()
    expect(resolver.requestsFor('a').at(-1)).toMatchObject({ reason: 'retry', attempt: 1 })
    expect(engine.loadStarts.at(-1)).toBe(0)
    expect(player.getState().status).toBe('playing')
  })
})

describe('Player: failures while paused', () => {
  it('neither retries nor skips, and retries the track with its failure on play', async () => {
    const { player, engine, resolver, failed } = setup({ maxRetries: 0 })
    await player.setQueue(testTracks('a', 'b'))
    engine.progress(60_000)
    player.pause()
    engine.fail('network')
    await settle(30_000)
    expect(failed).toEqual([])
    expect(current(player)).toBe('a')
    expect(resolver.requests).toHaveLength(1)
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 60_000 })
    await player.play()
    expect(resolver.requestsFor('a').at(-1)).toMatchObject({
      reason: 'retry',
      attempt: 1,
      failure: { positionMs: 60_000 },
    })
    expect(engine.loadStarts.at(-1)).toBe(60_000)
    expect(player.getState().status).toBe('playing')
  })

  it('waits for play when the user pauses during a retry wait', async () => {
    const { player, engine, resolver } = setup({ retryDelaysMs: [1000] })
    await player.setQueue(testTracks('a'))
    engine.progress(20_000)
    engine.fail('network')
    player.pause()
    await settle(10_000)
    expect(engine.count('load')).toBe(1)
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 20_000 })
    await player.play()
    expect(resolver.log).toEqual(['a:play#0', 'a:retry#1'])
    expect(resolver.requests.at(-1)?.request.failure?.positionMs).toBe(20_000)
    expect(engine.loadStarts).toEqual([0, 20_000])
  })

  it('keeps a failure of a track that loads paused for the next play', async () => {
    const { player, engine, resolver } = setup()
    engine.startOnPlay = false
    const starting = player.setQueue(testTracks('a'))
    player.pause()
    await starting
    engine.fail('decode')
    await settle(10_000)
    expect(resolver.requests).toHaveLength(1)
    expect(player.getState()).toMatchObject({ status: 'paused', buffering: false })
    await player.play()
    expect(resolver.log).toEqual(['a:play#0', 'a:retry#1'])
  })

  it('keeps an ended queue ended when a late error arrives', async () => {
    const { player, engine } = setup()
    await player.setQueue(testTracks('a'))
    engine.end()
    engine.fail('network')
    expect(player.getState().status).toBe('ended')
  })
})

describe('Player: tracks that keep failing', () => {
  it('stops instead of retrying the only track of a repeating queue again', async () => {
    for (const repeat of ['all', 'one'] as const) {
      const { player, resolver, failed } = setup({ queue: { repeat }, retryDelaysMs: [0] })
      resolver.handler = () => {
        throw new FxmError('Network', 'offline')
      }
      await player.setQueue(testTracks('a'))
      await drain()
      expect(resolver.requests).toHaveLength(4)
      expect(failed).toEqual(['a'])
      expect(player.getState().error?.reason).toBe('track-failed')
    }
  })

  it('stops when a repeating queue comes round to a track that already failed', async () => {
    const { player, resolver, failed } = setup({ queue: { repeat: 'all' }, maxRetries: 0 })
    resolver.handler = () => {
      throw new FxmError('Network', 'offline')
    }
    await player.setQueue(testTracks('a', 'b', 'c'))
    await drain()
    expect(failed).toEqual(['a', 'b', 'c'])
    expect(resolver.requests).toHaveLength(3)
    expect(player.getState()).toMatchObject({ status: 'error', error: { reason: 'track-failed' } })
    expect(current(player)).toBe('c')
  })
})

describe('Player: what a failure leads to', () => {
  it.each(['NotFound', 'Unavailable', 'GeoBlocked'] as const)(
    'skips a track the resolver reports as %s at once, without the circuit breaker',
    async (code) => {
      const { player, resolver, failed } = setup()
      resolver.handler = (item) => {
        if (item.track.title === 'f') return { stream: testStream('f') }
        throw new FxmError(code, 'cannot play')
      }
      await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e', 'f'))
      await settle()
      expect(failed).toEqual(['a', 'b', 'c', 'd', 'e'])
      expect(resolver.log).toEqual([
        'a:play#0',
        'b:play#0',
        'c:play#0',
        'd:play#0',
        'e:play#0',
        'f:play#0',
      ])
      expect(player.getState()).toMatchObject({ status: 'playing', error: undefined })
    },
  )

  it.each(['Unsupported', 'AuthRequired', 'BotCheck'] as const)(
    'stops and asks the user to act when the resolver reports %s',
    async (code) => {
      const { player, resolver, failed } = setup()
      resolver.handler = () => {
        throw new FxmError(code, 'needs the user')
      }
      await player.setQueue(testTracks('a', 'b'))
      await drain()
      expect(resolver.requests).toHaveLength(1)
      expect(failed).toEqual(['a'])
      const { status, error } = player.getState()
      expect(status).toBe('error')
      expect(error?.reason).toBe('action-required')
      expect(isFxmError(error?.error, code)).toBe(true)
      expect(current(player)).toBe('a')
      resolver.handler = (item) => ({ stream: testStream(item.track.title) })
      await player.play()
      expect(resolver.log.at(-1)).toBe('a:retry#1')
      expect(player.getState()).toMatchObject({ status: 'playing', error: undefined })
    },
  )

  it('waits as long as a rate-limited source asks before retrying', async () => {
    const { player, resolver } = setup()
    resolver.handler = (item, request) => {
      if (request.attempt === 0) {
        throw new FxmError('RateLimited', 'slow down', { retryAfterMs: 60_000 })
      }
      return { stream: testStream(item.track.title) }
    }
    await player.setQueue(testTracks('a'))
    await settle(59_999)
    expect(resolver.requests).toHaveLength(1)
    await settle(1)
    expect(resolver.log).toEqual(['a:play#0', 'a:retry#1'])
    expect(player.getState().status).toBe('playing')
  })

  it('keeps its own delay when a rate-limited source asks for less or says nothing', async () => {
    const { player, resolver } = setup({ retryDelaysMs: [2000] })
    resolver.handler = (item, request) => {
      if (request.attempt === 0) throw new FxmError('RateLimited', 'slow', { retryAfterMs: 10 })
      if (request.attempt === 1) throw new FxmError('RateLimited', 'slow')
      return { stream: testStream(item.track.title) }
    }
    await player.setQueue(testTracks('a'))
    await settle(1999)
    expect(resolver.requests).toHaveLength(1)
    await settle(1)
    expect(resolver.requests).toHaveLength(2)
    await settle(2000)
    expect(resolver.requests).toHaveLength(3)
  })

  it('stops a queue in which nothing plays before resolving all of it', async () => {
    const { player, resolver, failed } = setup({ maxConsecutiveSkips: 3 })
    const opened = vi.fn()
    player.on('circuitopen', opened)
    resolver.handler = () => {
      throw new FxmError('NotFound', 'no match')
    }
    await player.setQueue(testTracks('a', 'b', 'c', 'd', 'e'))
    await drain()
    expect(failed).toEqual(['a', 'b', 'c'])
    expect(resolver.requests).toHaveLength(3)
    expect(opened).toHaveBeenCalledWith({ failures: 3 })
    expect(player.getState().error?.reason).toBe('circuit-open')
  })

  it('stops at the end of a queue whose last track cannot play', async () => {
    const { player, resolver } = setup()
    resolver.handler = () => {
      throw new FxmError('Unavailable', 'removed')
    }
    await player.setQueue(testTracks('a'))
    await drain()
    expect(player.getState().error?.reason).toBe('track-failed')
  })

  it('lets the app decide what a failure leads to', async () => {
    const classify = vi.fn((error: Error) =>
      isEngineError(error, 'decode') ? ('skip' as const) : classifyFailure(error),
    )
    const { player, engine, resolver, failed } = setup({ classifyFailure: classify })
    await player.setQueue(testTracks('a', 'b'))
    engine.fail('decode')
    await settle()
    expect(failed).toEqual(['a'])
    expect(current(player)).toBe('b')
    expect(classify).toHaveBeenCalledWith(expect.any(EngineError), expect.objectContaining({}))
    expect(resolver.log).toEqual(['a:play#0', 'b:play#0'])
  })

  it('retries when the classifier throws or answers nonsense', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const answers: unknown[] = [
      () => {
        throw new Error('classifier bug')
      },
      () => 'later',
    ]
    for (const answer of answers) {
      const { player, engine, resolver } = setup({
        classifyFailure: answer as NonNullable<PlayerOptions['classifyFailure']>,
      })
      await player.setQueue(testTracks('a'))
      engine.fail('network')
      await settle()
      expect(resolver.log).toEqual(['a:play#0', 'a:retry#1'])
    }
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('classifyFailure', () => {
  it('maps every FxmError code', () => {
    const classes = Object.fromEntries(
      FXM_ERROR_CODES.map((code) => [code, classifyFailure(new FxmError(code, code))]),
    )
    expect(classes).toEqual({
      NotFound: 'skip',
      RateLimited: 'retry',
      AuthRequired: 'stop',
      Unavailable: 'skip',
      GeoBlocked: 'skip',
      Expired: 'retry',
      BotCheck: 'stop',
      Unsupported: 'stop',
      Network: 'retry',
      Parse: 'retry',
    })
  })

  it('retries engine errors and errors of unknown origin', () => {
    expect(classifyFailure(new EngineError('unsupported', 'format'))).toBe('retry')
    expect(classifyFailure(new Error('?'))).toBe('retry')
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
      throw new FxmError('Network', 'offline')
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

  it('does not count a stall while the position keeps moving', async () => {
    for (const event of ['stalled', 'waiting'] as const) {
      const { player, engine, resolver } = setup()
      await player.setQueue(testTracks('a'))
      engine.progress(10_000)
      engine.emit(event, undefined)
      expect(player.getState().buffering).toBe(true)
      await playFor(engine, 10_000, 20_000)
      expect(resolver.requests).toHaveLength(1)
      expect(engine.count('load')).toBe(1)
      expect(player.getState()).toMatchObject({ buffering: false, status: 'playing' })
    }
  })

  it('takes neither a stray update nor a seek for progress', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(testTracks('a'))
    engine.progress(10_000)
    engine.emit('waiting', undefined)
    engine.progress(10_015)
    player.seek(60_000)
    engine.progress(60_000)
    expect(player.getState().buffering).toBe(true)
    await settle(14_999)
    expect(resolver.requests).toHaveLength(1)
    await settle(2)
    expect(resolver.log).toEqual(['a:play#0', 'a:retry#1'])
    expect(resolver.requests.at(-1)?.request.failure?.positionMs).toBe(60_000)
  })

  it('measures progress from where playback last started waiting', async () => {
    const { player, engine, resolver } = setup()
    await player.setQueue(testTracks('a'))
    player.pause()
    engine.startOnPlay = false
    await player.play()
    engine.progress(900)
    engine.emit('waiting', undefined)
    engine.progress(1000)
    expect(player.getState().buffering).toBe(true)
    await settle(15_001)
    expect(resolver.log).toEqual(['a:play#0', 'a:retry#1'])
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
    expect(engine.loadStarts).toEqual([0, 30_000])
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

  it('refreshes an expiring stream before a repeat or a restart replays it', async () => {
    let now = 1_000_000
    const { player, engine, resolver } = setup({ now: () => now, queue: { repeat: 'one' } })
    resolver.handler = (item, request) => ({
      stream: testStream(`${item.track.title}-${request.reason}`, {
        expiresAt: now + 15 * 60_000,
      }),
    })
    await player.setQueue(testTracks('a'))
    engine.progress(170_000)
    now += 10 * 60_000
    engine.end()
    await settle()
    expect(resolver.log).toEqual(['a:play#0', 'a:refresh#0'])
    expect(resolver.requests.at(-1)?.request.failure).toMatchObject({
      positionMs: 0,
      stream: { url: url('a-play') },
    })
    expect(engine.loadStarts).toEqual([0, 0])
    now += 10 * 60_000
    engine.progress(5000)
    await player.previous()
    expect(resolver.log).toEqual(['a:play#0', 'a:refresh#0', 'a:refresh#0'])
    expect(player.getState().status).toBe('playing')
  })
})
