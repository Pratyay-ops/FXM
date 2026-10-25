import { formatId } from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTrack } from '@fxm/player/testing'
import {
  createMemoryScrobbleStore,
  type Scrobbler,
  type ScrobbleStore,
} from '@fxm/sources/scrobble'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewPlay } from '../../db/repo'
import { announcePlayEnded, onPlays } from '../signals/play-events'
import { connectPlayRecorder } from '../signals/play-recorder'
import {
  createAppScrobbler,
  FLUSH_LOCK,
  keepSending,
  playListenerFor,
  resetScrobbling,
  scrobblePlayOf,
  targetsFor,
} from './scrobbling'
import { createScrobblingStore, hasAccounts, type ScrobblingStore } from './scrobbling-store'

const T0 = Date.UTC(2026, 9, 26, 9)
const TOKEN = '00000000-0000-4000-8000-000000000000'
const LASTFM = {
  apiKey: '0123456789abcdef0123456789abcdef',
  secret: 'fedcba9876543210fedcba9876543210',
  sessionKey: 'd580d57f32848f5dcf574d1ce18d78b2',
  userName: 'someone',
}
/** Another person's Last.fm account, on the same device and API account. */
const BOB = { ...LASTFM, sessionKey: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0', userName: 'bob' }

/** One request to a fake service. */
interface Sent {
  service: 'listenbrainz' | 'lastfm'
  /** ListenBrainz's listen type, or Last.fm's method. */
  kind: string
  body: Record<string, unknown>
}

/** Fake ListenBrainz and Last.fm. `refuse` makes ListenBrainz answer 401. */
function fakeServices() {
  const sent: Sent[] = []
  const services = {
    sent,
    refuse: false,
    fetch: (async (input, init) => {
      const url = new URL(String(input))
      if (url.host === 'api.listenbrainz.org') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        sent.push({ service: 'listenbrainz', kind: body.listen_type ?? url.pathname, body })
        if (services.refuse)
          return Response.json(
            { code: 401, error: 'Invalid authorization token.' },
            { status: 401 },
          )
        return Response.json({ status: 'ok' })
      }
      if (url.host === 'ws.audioscrobbler.com') {
        const body = Object.fromEntries(new URLSearchParams(String(init?.body)))
        sent.push({ service: 'lastfm', kind: String(body.method), body })
        return Response.json(
          body.method === 'track.scrobble'
            ? { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }
            : { nowplaying: {} },
        )
      }
      throw new TypeError(`No such host: ${url.host}`)
    }) as typeof fetch,
    kinds: (service: Sent['service']) =>
      sent.filter((request) => request.service === service).map((request) => request.kind),
  }
  return services
}

function accountsWith(connect: { listenbrainz?: boolean; lastfm?: boolean }): ScrobblingStore {
  const accounts = createScrobblingStore({ storage: () => undefined })
  if (connect.listenbrainz) {
    accounts.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
  }
  if (connect.lastfm) accounts.getState().connectLastfm(LASTFM)
  return accounts
}

const stops: (() => void)[] = []

/** Feeds `scrobbler` with the player's plays and keeps it sending, as the app does. */
function connectScrobbler(scrobbler: Scrobbler, accounts: ScrobblingStore): () => void {
  const stopPlays = onPlays(playListenerFor(scrobbler, accounts))
  const stopSending = keepSending(scrobbler, accounts)
  return () => {
    stopSending()
    stopPlays()
  }
}

function setup(
  connect: { listenbrainz?: boolean; lastfm?: boolean } = { listenbrainz: true, lastfm: true },
  store: ScrobbleStore = createMemoryScrobbleStore(),
) {
  const services = fakeServices()
  const accounts = accountsWith(connect)
  const scrobbler = createAppScrobbler({
    store,
    accounts,
    context: () => ({ fetch: services.fetch }),
  })
  stops.push(() => scrobbler.close())
  return { services, accounts, scrobbler, store }
}

/** A play of `testTrack(name)` (three minutes) that heard `playedMs`, starting at T0. */
function newPlay(name: string, playedMs = 180_000, overrides: Partial<NewPlay> = {}): NewPlay {
  return {
    track: testTrack(name),
    playedAt: T0,
    playedMs,
    completed: playedMs >= 180_000,
    skipped: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 3_600_000 })
})

afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await resetScrobbling()
})

describe('scrobbling the player', () => {
  it('announces each song and scrobbles it once heard, to every connected account', async () => {
    const { services, accounts, scrobbler } = setup()
    stops.push(connectScrobbler(scrobbler, accounts))
    const engine = new FakeEngine()
    const player = new Player({
      engine,
      resolver: new FakeResolver(),
      stallTimeoutMs: 0,
      preload: false,
      maxRetries: 0,
    })
    stops.push(connectPlayRecorder(player, { record: async () => {}, pageEvents: null }))
    const [a, b] = [testTrack('a'), testTrack('b')]
    const startedAt = Date.now()
    await player.setQueue([a, b])
    // Three minutes of listening, a quarter second at a time.
    for (let ms = 0; ms < 179_750; ms += 250) {
      await vi.advanceTimersByTimeAsync(250)
      engine.progress(engine.positionMs + 250)
    }
    expect(services.kinds('listenbrainz')).toEqual(['playing_now'])
    expect(services.kinds('lastfm')).toEqual(['track.updateNowPlaying'])
    engine.end()
    await vi.advanceTimersByTimeAsync(5000)
    expect(services.kinds('listenbrainz')).toEqual(['playing_now', 'single', 'playing_now'])
    expect(services.kinds('lastfm')).toEqual([
      'track.updateNowPlaying',
      'track.scrobble',
      'track.updateNowPlaying',
    ])
    const listen = services.sent.find((request) => request.kind === 'single')
    expect(listen?.body).toMatchObject({
      payload: [
        {
          listened_at: Math.floor(startedAt / 1000),
          track_metadata: { artist_name: 'a artist', track_name: 'a' },
        },
      ],
    })
    const scrobble = services.sent.find((request) => request.kind === 'track.scrobble')
    expect(scrobble?.body).toMatchObject({
      'artist[0]': 'a artist',
      'track[0]': 'a',
      'timestamp[0]': String(Math.floor(startedAt / 1000)),
      sk: LASTFM.sessionKey,
    })
    expect(JSON.stringify(scrobble?.body)).not.toContain(LASTFM.secret)
    // b is announced too, and only scrobbled once heard.
    expect(services.sent.at(-1)?.body).not.toHaveProperty('timestamp[0]')
  })

  it('scrobbles nothing for a quick skip, an imported play, or without an account', async () => {
    const connected = setup()
    stops.push(connectScrobbler(connected.scrobbler, connected.accounts))
    announcePlayEnded(newPlay('quick', 30_000))
    announcePlayEnded(newPlay('imported', 180_000, { importId: 'import-1' }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(connected.services.sent).toEqual([])

    const store = createMemoryScrobbleStore()
    const add = vi.spyOn(store, 'add')
    const none = setup({}, store)
    stops.push(connectScrobbler(none.scrobbler, none.accounts))
    announcePlayEnded(newPlay('song'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(none.services.sent).toEqual([])
    expect(add).not.toHaveBeenCalled()
  })

  it('pauses an account its service refuses, keeps its plays, and sends them once reconnected', async () => {
    const { services, accounts, scrobbler, store } = setup({ listenbrainz: true })
    stops.push(connectScrobbler(scrobbler, accounts))
    services.refuse = true
    announcePlayEnded(newPlay('one'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(accounts.getState().listenbrainz?.refusedAt).toBe(Date.now() - 5000)
    announcePlayEnded(newPlay('two', 180_000, { playedAt: T0 + 200_000 }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(services.kinds('listenbrainz')).toEqual(['single'])
    expect(await store.count('listenbrainz')).toBe(2)

    services.refuse = false
    accounts.getState().connectListenBrainz({ token: TOKEN, userName: 'someone' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(services.kinds('listenbrainz')).toEqual(['single', 'import'])
    expect(await store.count('listenbrainz')).toBe(0)
  })

  it('waits while the browser is offline, and sends once it is back online', async () => {
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    const { services, accounts, scrobbler } = setup({ lastfm: true })
    stops.push(connectScrobbler(scrobbler, accounts))
    announcePlayEnded(newPlay('offline'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(services.sent).toEqual([])
    onLine.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(services.kinds('lastfm')).toEqual(['track.scrobble'])
  })

  it('sends what an earlier session left as soon as it starts', async () => {
    const store = createMemoryScrobbleStore()
    await store.add(
      'listenbrainz',
      [{ track: { artists: ['Artist'], title: 'Left over' }, startedAt: T0 }],
      10,
      'someone',
    )
    const { services, accounts, scrobbler } = setup({ listenbrainz: true }, store)
    stops.push(connectScrobbler(scrobbler, accounts))
    await vi.advanceTimersByTimeAsync(1000)
    expect(services.kinds('listenbrainz')).toEqual(['single'])
  })

  it("never sends a play that ended during a Disconnect to the next person's account", async () => {
    const memory = createMemoryScrobbleStore()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const store: ScrobbleStore = {
      ...memory,
      add: async (service, scrobbles, max, user) => {
        if (service === 'listenbrainz') await held
        return memory.add(service, scrobbles, max, user)
      },
    }
    const { services, accounts, scrobbler } = setup({ listenbrainz: true, lastfm: true }, store)
    stops.push(connectScrobbler(scrobbler, accounts))
    announcePlayEnded(newPlay('private song'))
    await vi.advanceTimersByTimeAsync(0)
    // Its ListenBrainz listen is being written when Last.fm is disconnected...
    accounts.getState().disconnect('lastfm')
    await scrobbler.forget('lastfm')
    release()
    await vi.advanceTimersByTimeAsync(1000)
    // ...and someone else connects their own Last.fm account.
    accounts.getState().connectLastfm(BOB)
    await vi.advanceTimersByTimeAsync(5000)
    expect(services.kinds('lastfm')).toEqual([])
    expect(services.kinds('listenbrainz')).toEqual(['single'])
    expect(await store.count('lastfm')).toBe(0)
  })

  it('drops what an earlier account left in a queue rather than send it to the next', async () => {
    const store = createMemoryScrobbleStore()
    const leftover = { track: { artists: ['Artist'], title: 'Private' }, startedAt: T0 }
    await store.add('lastfm', [leftover], 10, LASTFM.userName)
    const { services, accounts, scrobbler } = setup({}, store)
    accounts.getState().connectLastfm(BOB)
    stops.push(connectScrobbler(scrobbler, accounts))
    await vi.advanceTimersByTimeAsync(1000)
    expect(services.sent).toEqual([])
    expect(await store.count('lastfm')).toBe(0)
    expect(scrobbler.status('lastfm').dropped).toBe(1)
  })

  it('empties the queue of a service without an account, at start and as its account goes', async () => {
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    const store = createMemoryScrobbleStore()
    const leftover = { track: { artists: ['Artist'], title: 'Left over' }, startedAt: T0 }
    await store.add('lastfm', [leftover], 10, LASTFM.userName)
    const { accounts, scrobbler } = setup({ listenbrainz: true }, store)
    stops.push(connectScrobbler(scrobbler, accounts))
    await vi.advanceTimersByTimeAsync(0)
    expect(await store.count('lastfm')).toBe(0)
    // A listen queued here just before another tab disconnects ListenBrainz.
    announcePlayEnded(newPlay('song'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await store.count('listenbrainz')).toBe(1)
    accounts.getState().disconnect('listenbrainz')
    await vi.advanceTimersByTimeAsync(0)
    expect(await store.count('listenbrainz')).toBe(0)
    onLine.mockRestore()
  })

  it('still sends a play the device cannot save, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const memory = createMemoryScrobbleStore()
    const store: ScrobbleStore = {
      ...memory,
      add: async () => {
        throw new Error('The quota has been exceeded.')
      },
    }
    const { services, accounts, scrobbler } = setup({ listenbrainz: true }, store)
    stops.push(connectScrobbler(scrobbler, accounts))
    announcePlayEnded(newPlay('song'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(services.kinds('listenbrainz')).toEqual(['single'])
    expect(scrobbler.status('listenbrainz')).toMatchObject({
      sent: 1,
      unsaved: 0,
      storageError: 'The quota has been exceeded.',
    })
    expect(error).not.toHaveBeenCalled()
  })

  it('takes turns with other tabs through a Web Lock', async () => {
    const request = vi.fn((_name: string, task: () => Promise<unknown>) => task())
    Object.defineProperty(window.navigator, 'locks', { value: { request }, configurable: true })
    try {
      const { accounts, scrobbler } = setup({ listenbrainz: true })
      stops.push(connectScrobbler(scrobbler, accounts))
      announcePlayEnded(newPlay('song'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(request).toHaveBeenCalledWith(FLUSH_LOCK, expect.any(Function))
    } finally {
      Reflect.deleteProperty(window.navigator, 'locks')
    }
  })
})

describe('targetsFor', () => {
  it('has one target per connected account, paused while refused', () => {
    expect(targetsFor({})).toEqual([])
    const targets = targetsFor({
      listenbrainz: { token: TOKEN, userName: 'a', refusedAt: 1 },
      lastfm: LASTFM,
    })
    expect(
      targets.map((target) => [target.service, target.paused, target.account, target.user]),
    ).toEqual([
      ['listenbrainz', true, TOKEN, 'a'],
      ['lastfm', false, LASTFM.sessionKey, LASTFM.userName],
    ])
    expect(hasAccounts({})).toBe(false)
    expect(hasAccounts({ lastfm: LASTFM })).toBe(true)
  })
})

describe('scrobblePlayOf', () => {
  it('turns a recorded play into what the scrobbler takes', () => {
    const context = { type: 'radio', id: formatId('ytm', 'track', 'a'), title: 'Radio' }
    const play = newPlay('a', 100_000, { durationMs: 200_000, context })
    expect(scrobblePlayOf(play)).toEqual({
      track: play.track,
      at: T0,
      playedMs: 100_000,
      durationMs: 200_000,
      context,
    })
    const { playedAt: _start, ...withoutStart } = newPlay('a')
    expect(scrobblePlayOf(withoutStart, 42).at).toBe(42)
  })
})
