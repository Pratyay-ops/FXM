import { FxmError } from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrobbleError } from './errors'
import { creep, playOf, T0 } from './fixtures/testing'
import { LASTFM_RULES, LISTENBRAINZ_RULES, type ScrobbleRules } from './rules'
import { Scrobbler, type ScrobblerOptions } from './scrobbler'
import { createMemoryScrobbleStore, type ScrobbleStore } from './store'
import type { ScrobbleTarget, SubmitReport } from './target'
import type { Scrobble, ScrobbleServiceId, ScrobbleTrack } from './types'

const MINUTE = 60_000

type Submit = (batch: readonly Scrobble[]) => SubmitReport | Promise<SubmitReport>

const accept: Submit = (batch) => ({ accepted: batch.length, ignored: 0, ignoredCodes: [] })

/** A target that records what it was sent and answers with `submit`. */
function fakeTarget(
  service: ScrobbleServiceId,
  options: { rules?: ScrobbleRules; batchSize?: number } = {},
) {
  const fake = {
    paused: false,
    sent: [] as Scrobble[][],
    nowPlaying: [] as ScrobbleTrack[],
    submit: accept,
    nowPlayingResult: (): Promise<void> => Promise.resolve(),
    get target(): ScrobbleTarget {
      return {
        service,
        rules: options.rules ?? (service === 'lastfm' ? LASTFM_RULES : LISTENBRAINZ_RULES),
        batchSize: options.batchSize ?? 50,
        paused: fake.paused,
        account: `${service} account`,
        nowPlaying: async (track) => {
          fake.nowPlaying.push(track)
          return fake.nowPlayingResult()
        },
        submit: async (batch) => {
          fake.sent.push([...batch])
          return fake.submit(batch)
        },
      }
    },
    /** The titles sent, batch by batch. */
    titles(): string[][] {
      return fake.sent.map((batch) => batch.map((scrobble) => scrobble.track.title))
    },
  }
  return fake
}

function setup(options: Partial<ScrobblerOptions> = {}, batchSize = 50) {
  const lastfm = fakeTarget('lastfm', { batchSize })
  const listenbrainz = fakeTarget('listenbrainz', { batchSize })
  const store = createMemoryScrobbleStore()
  const refused: ScrobbleServiceId[] = []
  const refusedAccounts: (string | undefined)[] = []
  let online = true
  const scrobbler = new Scrobbler({
    store,
    targets: () => [listenbrainz.target, lastfm.target],
    context: () => ({ fetch: globalThis.fetch }),
    onRefused: (service, _error, target) => {
      refused.push(service)
      refusedAccounts.push(target.account)
    },
    online: () => online,
    random: () => 0,
    ...options,
  })
  return {
    scrobbler,
    store,
    lastfm,
    listenbrainz,
    refused,
    refusedAccounts,
    setOnline(value: boolean) {
      online = value
    },
  }
}

/** A song of `n` minutes called "Song n", heard to the end, starting `n` hours after T0. */
function play(n: number, overrides: { playedMs?: number; durationMs?: number } = {}) {
  const durationMs = overrides.durationMs ?? 3 * MINUTE
  const track = creep({ title: `Song ${n}`, durationMs })
  return playOf(track, overrides.playedMs ?? durationMs, { at: T0 + n * 60 * MINUTE })
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 24 * 60 * MINUTE })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Scrobbler.playEnded', () => {
  it('queues a scrobble for every service whose rules the play meets, then sends it', async () => {
    const { scrobbler, lastfm, listenbrainz, store } = setup()
    await scrobbler.playEnded(play(1))
    expect(lastfm.titles()).toEqual([['Song 1']])
    expect(listenbrainz.titles()).toEqual([['Song 1']])
    expect(lastfm.sent[0]?.[0]).toMatchObject({ startedAt: T0 + 60 * MINUTE, playedMs: 3 * MINUTE })
    expect(await store.count('lastfm')).toBe(0)
    expect(scrobbler.status('lastfm')).toMatchObject({
      sent: 1,
      dropped: 0,
      lastSentAt: Date.now(),
    })
  })

  it('follows each service: a 20-second track counts on ListenBrainz only', async () => {
    const { scrobbler, lastfm, listenbrainz } = setup()
    await scrobbler.playEnded(play(1, { durationMs: 20_000, playedMs: 10_000 }))
    expect(listenbrainz.titles()).toEqual([['Song 1']])
    expect(lastfm.sent).toEqual([])
  })

  it('queues nothing for a play heard too briefly, or a track it does not scrobble', async () => {
    const { scrobbler, lastfm, listenbrainz, store } = setup()
    await scrobbler.playEnded(play(1, { playedMs: 89_999 }))
    await scrobbler.playEnded({ ...play(2), track: creep({ kind: 'video' }) })
    expect([...lastfm.sent, ...listenbrainz.sent]).toEqual([])
    expect(await store.count('listenbrainz')).toBe(0)
  })

  it('sends queues oldest first, in batches', async () => {
    const { scrobbler, lastfm, setOnline } = setup({}, 2)
    setOnline(false)
    for (const n of [1, 2, 3, 4, 5]) await scrobbler.playEnded(play(n))
    expect(lastfm.sent).toEqual([])
    setOnline(true)
    await scrobbler.retryNow()
    expect(lastfm.titles()).toEqual([['Song 1', 'Song 2'], ['Song 3', 'Song 4'], ['Song 5']])
  })

  it('keeps at most maxQueued per service, dropping the oldest', async () => {
    const { scrobbler, lastfm, setOnline } = setup({ maxQueued: 2 })
    setOnline(false)
    for (const n of [1, 2, 3]) await scrobbler.playEnded(play(n))
    setOnline(true)
    await scrobbler.retryNow()
    expect(lastfm.titles()).toEqual([['Song 2', 'Song 3']])
    expect(scrobbler.status('lastfm').dropped).toBe(1)
  })

  it('counts what a service ignored', async () => {
    const { scrobbler, lastfm } = setup()
    lastfm.submit = (batch) => ({ accepted: 0, ignored: batch.length, ignoredCodes: [3] })
    await scrobbler.playEnded(play(1))
    expect(scrobbler.status('lastfm')).toMatchObject({ sent: 0, ignored: 1 })
  })
})

describe('Scrobbler retries', () => {
  it('keeps the scrobbles after a temporary failure and tries again with backoff', async () => {
    const { scrobbler, lastfm, store } = setup()
    lastfm.submit = () => {
      throw new ScrobbleError('lastfm', 'temporary', 'Last.fm answered HTTP 502')
    }
    await scrobbler.playEnded(play(1))
    const start = Date.now()
    expect(scrobbler.status('lastfm')).toMatchObject({
      retryAt: start + 30_000,
      lastError: 'Last.fm answered HTTP 502',
    })
    expect(await store.count('lastfm')).toBe(1)

    // Each failure in a row doubles the wait.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(lastfm.sent).toHaveLength(2)
    expect(scrobbler.status('lastfm').retryAt).toBe(start + 30_000 + 60_000)

    lastfm.submit = accept
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastfm.sent).toHaveLength(3)
    expect(scrobbler.status('lastfm')).toMatchObject({ sent: 1 })
    expect(scrobbler.status('lastfm')).not.toHaveProperty('retryAt')
    expect(scrobbler.status('lastfm')).not.toHaveProperty('lastError')
    expect(await store.count('lastfm')).toBe(0)
  })

  it('caps the backoff and adds up to 30 % jitter', async () => {
    const { scrobbler, lastfm } = setup({ random: () => 0.5, retryBaseMs: 1000, retryMaxMs: 4000 })
    lastfm.submit = () => {
      throw new FxmError('Network', 'down')
    }
    await scrobbler.playEnded(play(1))
    const waits: number[] = []
    for (let attempt = 0; attempt < 4; attempt++) {
      const retryAt = scrobbler.status('lastfm').retryAt ?? 0
      waits.push(retryAt - Date.now())
      await vi.advanceTimersByTimeAsync(retryAt - Date.now())
    }
    expect(waits).toEqual([1150, 2300, 4600, 4600])
  })

  it('waits exactly as long as a rate limit asks, which retryNow does not cut short', async () => {
    const { scrobbler, listenbrainz } = setup()
    listenbrainz.submit = () => {
      throw new ScrobbleError('listenbrainz', 'rate-limited', 'ListenBrainz answered HTTP 429', {
        retryAfterMs: 10_000,
      })
    }
    await scrobbler.playEnded(play(1))
    expect(scrobbler.status('listenbrainz').retryAt).toBe(Date.now() + 10_000)
    listenbrainz.submit = accept
    await scrobbler.retryNow()
    expect(listenbrainz.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(listenbrainz.sent).toHaveLength(2)
  })

  it('ends the wait after a temporary failure when retried now', async () => {
    const { scrobbler, lastfm } = setup()
    lastfm.submit = () => {
      throw new ScrobbleError('lastfm', 'temporary', 'Last.fm could not be reached')
    }
    await scrobbler.playEnded(play(1))
    lastfm.submit = accept
    await scrobbler.retryNow()
    expect(lastfm.sent).toHaveLength(2)
    expect(scrobbler.status('lastfm').sent).toBe(1)
  })

  it('pauses on refused credentials, keeps queueing, and sends once the user is back', async () => {
    const { scrobbler, lastfm, listenbrainz, refused, refusedAccounts, store } = setup()
    lastfm.submit = () => {
      throw new ScrobbleError(
        'lastfm',
        'refused',
        'Last.fm answered with error 9 (invalid session key)',
      )
    }
    await scrobbler.playEnded(play(1))
    expect(refused).toEqual(['lastfm'])
    // With the target that sent, so the app can tell whose credentials were refused.
    expect(refusedAccounts).toEqual(['lastfm account'])
    // The app pauses it; plays keep joining the queue meanwhile.
    lastfm.paused = true
    await scrobbler.playEnded(play(2))
    expect(lastfm.sent).toHaveLength(1)
    expect(listenbrainz.titles()).toEqual([['Song 1'], ['Song 2']])
    expect(await store.count('lastfm')).toBe(2)
    // Connected again.
    lastfm.paused = false
    lastfm.submit = accept
    await scrobbler.flush()
    expect(lastfm.titles().at(-1)).toEqual(['Song 1', 'Song 2'])
  })

  it('finds the scrobble a service rejects by sending one at a time, and drops only it', async () => {
    const { scrobbler, lastfm, setOnline } = setup()
    lastfm.submit = (batch) => {
      if (batch.some((scrobble) => scrobble.track.title === 'Song 2')) {
        throw new ScrobbleError('lastfm', 'rejected', 'error 6')
      }
      return accept(batch)
    }
    setOnline(false)
    for (const n of [1, 2, 3, 4]) await scrobbler.playEnded(play(n))
    setOnline(true)
    await scrobbler.retryNow()
    expect(lastfm.titles()).toEqual([
      ['Song 1', 'Song 2', 'Song 3', 'Song 4'],
      ['Song 1'],
      ['Song 2'],
      ['Song 3'],
      ['Song 4'],
    ])
    expect(scrobbler.status('lastfm')).toMatchObject({ sent: 3, dropped: 1 })
  })

  it('drops unreadable entries from the store and sends the rest', async () => {
    const { scrobbler, lastfm, store } = setup()
    await store.add('lastfm', [{ nonsense: true } as unknown as Scrobble], 10)
    await scrobbler.playEnded(play(1))
    expect(lastfm.titles()).toEqual([['Song 1']])
    expect(scrobbler.status('lastfm').dropped).toBe(1)
  })

  it('backs off when the store fails, without losing the scrobble', async () => {
    const { scrobbler, lastfm, listenbrainz, store } = setup()
    const peek = store.peek.bind(store)
    let failing = true
    vi.spyOn(store, 'peek').mockImplementation((service, limit) =>
      failing && service === 'lastfm'
        ? Promise.reject(new Error('QuotaExceededError'))
        : peek(service, limit),
    )
    await scrobbler.playEnded(play(1))
    expect(scrobbler.status('lastfm')).toMatchObject({ lastError: 'QuotaExceededError' })
    expect(listenbrainz.titles()).toEqual([['Song 1']])
    failing = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(lastfm.titles()).toEqual([['Song 1']])
  })

  it('sends nothing while offline, and everything once back online', async () => {
    const { scrobbler, lastfm, listenbrainz, setOnline } = setup()
    setOnline(false)
    await scrobbler.playEnded(play(1))
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect([...lastfm.sent, ...listenbrainz.sent]).toEqual([])
    setOnline(true)
    await scrobbler.retryNow()
    expect(lastfm.titles()).toEqual([['Song 1']])
    expect(listenbrainz.titles()).toEqual([['Song 1']])
  })
})

describe('Scrobbler.flush', () => {
  it('runs one flush at a time, and once more for calls during it', async () => {
    const { scrobbler, lastfm, store } = setup()
    let release = () => {}
    lastfm.submit = (batch) =>
      new Promise((resolve) => {
        release = () => resolve(accept(batch))
      })
    await store.add(
      'lastfm',
      [play(1)].map(() => ({ track: { artists: ['A'], title: 'One' }, startedAt: T0 })),
      10,
    )
    const first = scrobbler.flush()
    await vi.advanceTimersByTimeAsync(0)
    await store.add(
      'lastfm',
      [{ track: { artists: ['A'], title: 'Two' }, startedAt: T0 + 1000 }],
      10,
    )
    const second = scrobbler.flush()
    expect(second).toBe(first)
    release()
    await vi.advanceTimersByTimeAsync(0)
    release()
    await first
    expect(lastfm.titles()).toEqual([['One'], ['Two']])
  })

  it('runs every flush through `exclusive`', async () => {
    let runs = 0
    const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
      runs++
      return run()
    }
    const { scrobbler } = setup({ exclusive })
    await scrobbler.playEnded(play(1))
    expect(runs).toBe(1)
  })

  it('skips paused services and services still waiting', async () => {
    const { scrobbler, lastfm, listenbrainz, store } = setup()
    listenbrainz.paused = true
    await store.add(
      'listenbrainz',
      [{ track: { artists: ['A'], title: 'One' }, startedAt: T0 }],
      10,
    )
    await scrobbler.flush()
    expect(listenbrainz.sent).toEqual([])
    expect(lastfm.sent).toEqual([])
  })
})

describe('Scrobbler.playStarted', () => {
  it('announces the track to every service after the delay', async () => {
    const { scrobbler, lastfm, listenbrainz } = setup()
    scrobbler.playStarted({ track: creep() })
    await vi.advanceTimersByTimeAsync(2999)
    expect(lastfm.nowPlaying).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(lastfm.nowPlaying.map((track) => track.title)).toEqual(['Creep'])
    expect(listenbrainz.nowPlaying.map((track) => track.title)).toEqual(['Creep'])
  })

  it('announces only the last of quick skips, and nothing for a play that ended', async () => {
    const { scrobbler, lastfm } = setup()
    scrobbler.playStarted({ track: creep({ title: 'One' }) })
    await vi.advanceTimersByTimeAsync(1000)
    scrobbler.playStarted({ track: creep({ title: 'Two' }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(lastfm.nowPlaying.map((track) => track.title)).toEqual(['Two'])
    const three = creep({ id: 'ytm:track:three' as never, title: 'Three' })
    scrobbler.playStarted({ track: three })
    await scrobbler.playEnded(playOf(three, 1000))
    await vi.advanceTimersByTimeAsync(3000)
    expect(lastfm.nowPlaying.map((track) => track.title)).toEqual(['Two'])
  })

  it('stays quiet for tracks it does not scrobble, and per service rules and state', async () => {
    const { scrobbler, lastfm, listenbrainz } = setup()
    scrobbler.playStarted({ track: creep({ kind: 'video' }) })
    await vi.advanceTimersByTimeAsync(3000)
    scrobbler.playStarted({ track: creep({ durationMs: 25_000 }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(lastfm.nowPlaying).toEqual([])
    expect(listenbrainz.nowPlaying).toHaveLength(1)
    listenbrainz.paused = true
    scrobbler.playStarted({ track: creep() })
    await vi.advanceTimersByTimeAsync(3000)
    expect(listenbrainz.nowPlaying).toHaveLength(1)
    expect(lastfm.nowPlaying).toHaveLength(1)
  })

  it('never retries now playing, but reports a refusal and honours a rate limit', async () => {
    const { scrobbler, lastfm, listenbrainz, refused } = setup()
    lastfm.nowPlayingResult = () =>
      Promise.reject(new ScrobbleError('lastfm', 'refused', 'error 9'))
    listenbrainz.nowPlayingResult = () =>
      Promise.reject(
        new ScrobbleError('listenbrainz', 'rate-limited', '429', { retryAfterMs: 60_000 }),
      )
    scrobbler.playStarted({ track: creep() })
    await vi.advanceTimersByTimeAsync(3000)
    expect(refused).toEqual(['lastfm'])
    expect(scrobbler.status('listenbrainz').retryAt).toBe(Date.now() + 60_000)
    // A temporary failure is simply dropped.
    lastfm.nowPlayingResult = () => Promise.reject(new ScrobbleError('lastfm', 'temporary', 'down'))
    scrobbler.playStarted({ track: creep({ title: 'Again' }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(scrobbler.status('lastfm')).not.toHaveProperty('retryAt')
    expect(lastfm.nowPlaying).toHaveLength(2)
    // ListenBrainz is still waiting out its rate limit.
    expect(listenbrainz.nowPlaying).toHaveLength(1)
  })
})

describe('Scrobbler bookkeeping', () => {
  it('forgets a service: its queue and its status', async () => {
    const { scrobbler, lastfm, store, setOnline } = setup()
    setOnline(false)
    await scrobbler.playEnded(play(1))
    lastfm.submit = accept
    expect(await scrobbler.pending('lastfm')).toBe(1)
    await scrobbler.forget('lastfm')
    expect(await store.count('lastfm')).toBe(0)
    expect(await store.count('listenbrainz')).toBe(1)
    expect(scrobbler.status('lastfm')).toEqual({
      service: 'lastfm',
      sent: 0,
      ignored: 0,
      dropped: 0,
    })
  })

  it('tells subscribers about changes until they unsubscribe', async () => {
    const { scrobbler } = setup()
    const listener = vi.fn()
    const unsubscribe = scrobbler.subscribe(listener)
    await scrobbler.playEnded(play(1))
    expect(listener).toHaveBeenCalled()
    listener.mockClear()
    unsubscribe()
    await scrobbler.playEnded(play(2))
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops sending and clears its timers when closed', async () => {
    const { scrobbler, lastfm } = setup()
    lastfm.submit = () => {
      throw new ScrobbleError('lastfm', 'temporary', 'down')
    }
    await scrobbler.playEnded(play(1))
    scrobbler.playStarted({ track: creep() })
    scrobbler.close()
    lastfm.submit = accept
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(lastfm.sent).toHaveLength(1)
    expect(lastfm.nowPlaying).toEqual([])
    await scrobbler.playEnded(play(2))
    expect(lastfm.sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('works with any store, e.g. one that persists', async () => {
    const memory = createMemoryScrobbleStore()
    const store: ScrobbleStore = { ...memory, add: vi.fn(memory.add) }
    const { scrobbler, lastfm } = setup({ store })
    await scrobbler.playEnded(play(1))
    expect(store.add).toHaveBeenCalledTimes(2)
    expect(lastfm.titles()).toEqual([['Song 1']])
  })
})
