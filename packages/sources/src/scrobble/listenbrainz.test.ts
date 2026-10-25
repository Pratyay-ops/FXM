import { APP_VERSION } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScrobbleError } from './errors'
import {
  type Call,
  contextFor,
  creepScrobble,
  fakeService,
  fixtures,
  hangingFetch,
  html,
  json,
  LISTENBRAINZ_TEST_TOKEN,
  T0,
} from './fixtures/testing'
import {
  isListenBrainzToken,
  LISTENBRAINZ_BATCH_SIZE,
  ListenBrainzScrobbleClient,
  listenBrainzTarget,
  listenOf,
} from './listenbrainz'
import { LISTENBRAINZ_RULES } from './rules'

const OK = { status: 'ok' }

/** A client without the pause between requests, so tests run on the real clock. */
function client(route: (call: Call) => Response | Promise<Response>) {
  const service = fakeService(route)
  const listenbrainz = new ListenBrainzScrobbleClient(LISTENBRAINZ_TEST_TOKEN, { minIntervalMs: 0 })
  return { listenbrainz, ctx: contextFor(service.fetch), calls: service.calls }
}

function bodyOf(call: Call | undefined): { listen_type: string; payload: unknown[] } {
  return JSON.parse(call?.body ?? 'null')
}

async function failure(promise: Promise<unknown>): Promise<ScrobbleError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(ScrobbleError)
  return error as ScrobbleError
}

afterEach(() => {
  vi.useRealTimers()
})

describe('isListenBrainzToken', () => {
  it('accepts visible ASCII without spaces, 8 to 128 characters', () => {
    expect(isListenBrainzToken(LISTENBRAINZ_TEST_TOKEN)).toBe(true)
    expect(isListenBrainzToken('short')).toBe(false)
    expect(isListenBrainzToken('has a space in it')).toBe(false)
    expect(isListenBrainzToken('x'.repeat(129))).toBe(false)
    expect(isListenBrainzToken(undefined)).toBe(false)
  })
})

describe('listenOf', () => {
  it('describes the listen as the JSON documentation shows', () => {
    const scrobble = creepScrobble(T0 + 999)
    scrobble.track.artists = ['Radiohead', 'Someone Else']
    scrobble.track.spotifyId = '70LcF31zb1H0PyJoS1Sx1r'
    expect(listenOf(scrobble)).toEqual({
      listened_at: Math.floor(T0 / 1000),
      track_metadata: {
        artist_name: 'Radiohead, Someone Else',
        track_name: 'Creep',
        release_name: 'Pablo Honey',
        additional_info: {
          media_player: 'FXM',
          media_player_version: APP_VERSION,
          submission_client: 'FXM',
          submission_client_version: APP_VERSION,
          duration_ms: 239_000,
          duration_played: 180,
          tracknumber: '2',
          isrc: 'GBAYE9200070',
          spotify_id: 'https://open.spotify.com/track/70LcF31zb1H0PyJoS1Sx1r',
        },
      },
    })
  })

  it('leaves out what it does not know', () => {
    const listen = listenOf({ track: { artists: ['Radiohead'], title: 'Creep' }, startedAt: T0 })
    expect(listen.track_metadata).toEqual({
      artist_name: 'Radiohead',
      track_name: 'Creep',
      additional_info: {
        media_player: 'FXM',
        media_player_version: APP_VERSION,
        submission_client: 'FXM',
        submission_client_version: APP_VERSION,
      },
    })
  })
})

describe('ListenBrainzScrobbleClient.validateToken', () => {
  it('asks with the token in the Authorization header, never in the URL', async () => {
    const { listenbrainz, ctx, calls } = client(() => json(fixtures.listenbrainzValidateValid))
    expect(await listenbrainz.validateToken(ctx)).toEqual({
      valid: true,
      userName: 'fxm-test-user',
    })
    const call = calls[0]
    expect(call?.method).toBe('GET')
    expect(call?.url.href).toBe('https://api.listenbrainz.org/1/validate-token')
    expect(call?.headers.get('authorization')).toBe(`Token ${LISTENBRAINZ_TEST_TOKEN}`)
    expect(call?.headers.has('user-agent')).toBe(false)
    expect(call?.init?.credentials).toBe('omit')
  })

  it('says when ListenBrainz does not know the token (recorded answer)', async () => {
    const { listenbrainz, ctx } = client(() => json(fixtures.listenbrainzValidateInvalid))
    expect(await listenbrainz.validateToken(ctx)).toEqual({ valid: false })
    const refused = client(() => json(fixtures.listenbrainzInvalidToken, { status: 401 }))
    expect(await refused.listenbrainz.validateToken(refused.ctx)).toEqual({ valid: false })
  })

  it('fails on answers it cannot read and on errors', async () => {
    const odd = client(() => json({ valid: true }))
    expect(await failure(odd.listenbrainz.validateToken(odd.ctx))).toMatchObject({ code: 'Parse' })
    const noToken = client(() => json(fixtures.listenbrainzValidateNoToken, { status: 400 }))
    expect(await failure(noToken.listenbrainz.validateToken(noToken.ctx))).toMatchObject({
      failure: 'rejected',
      serviceCode: 400,
    })
  })
})

describe('ListenBrainzScrobbleClient.submit', () => {
  it('submits one listen as single and more as an import, as JSON', async () => {
    const { listenbrainz, ctx, calls } = client(() => json(OK))
    const first = creepScrobble()
    const second = creepScrobble(T0 + 240_000)
    expect(await listenbrainz.submit([first], ctx)).toEqual({
      accepted: 1,
      ignored: 0,
      ignoredCodes: [],
    })
    await listenbrainz.submit([first, second], ctx)
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ['POST', '/1/submit-listens'],
      ['POST', '/1/submit-listens'],
    ])
    expect(calls[0]?.headers.get('content-type')).toBe('application/json')
    expect(calls[0]?.headers.get('authorization')).toBe(`Token ${LISTENBRAINZ_TEST_TOKEN}`)
    expect(bodyOf(calls[0])).toEqual({ listen_type: 'single', payload: [listenOf(first)] })
    expect(bodyOf(calls[1])).toEqual({
      listen_type: 'import',
      payload: [listenOf(first), listenOf(second)],
    })
    for (const call of calls) expect(call.url.href).not.toContain(LISTENBRAINZ_TEST_TOKEN)
  })

  it('sends playing-now listens without a start', async () => {
    const { listenbrainz, ctx, calls } = client(() => json(OK))
    await listenbrainz.playingNow(creepScrobble().track, ctx)
    const body = bodyOf(calls[0])
    expect(body.listen_type).toBe('playing_now')
    expect(body.payload).toHaveLength(1)
    expect(body.payload[0]).not.toHaveProperty('listened_at')
    expect(body.payload[0]).toMatchObject({ track_metadata: { track_name: 'Creep' } })
  })

  it('sends nothing for no listens and refuses more than a batch', async () => {
    const { listenbrainz, ctx, calls } = client(() => json(OK))
    await listenbrainz.submit([], ctx)
    const many = Array.from({ length: LISTENBRAINZ_BATCH_SIZE + 1 }, () => creepScrobble())
    await expect(listenbrainz.submit(many, ctx)).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(0)
  })

  it('sorts failures by what the queue should do', async () => {
    const cases: [Response, object][] = [
      [
        json(fixtures.listenbrainzInvalidToken, { status: 401 }),
        { failure: 'refused', code: 'AuthRequired' },
      ],
      [
        json({ code: 400, error: 'Invalid JSON document submitted.' }, { status: 400 }),
        { failure: 'rejected' },
      ],
      [new Response('', { status: 413 }), { failure: 'rejected', serviceCode: 413 }],
      [html(503), { failure: 'temporary', serviceCode: 503 }],
      [html(403), { failure: 'temporary', serviceCode: 403 }],
      [new Response('', { status: 404 }), { failure: 'temporary', serviceCode: 404 }],
    ]
    for (const [response, expected] of cases) {
      const { listenbrainz, ctx } = client(() => response)
      expect(await failure(listenbrainz.submit([creepScrobble()], ctx))).toMatchObject({
        service: 'listenbrainz',
        ...expected,
      })
    }
  })

  it('takes a network failure or a timeout as temporary', async () => {
    const down = client(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(await failure(down.listenbrainz.submit([creepScrobble()], down.ctx))).toMatchObject({
      failure: 'temporary',
      code: 'Network',
      message: 'ListenBrainz could not be reached',
    })
    const slow = new ListenBrainzScrobbleClient(LISTENBRAINZ_TEST_TOKEN, {
      minIntervalMs: 0,
      timeoutMs: 50,
    })
    expect(await failure(slow.submit([creepScrobble()], contextFor(hangingFetch)))).toMatchObject({
      message: 'ListenBrainz did not answer within 50 ms',
    })
  })
})

describe('ListenBrainz rate limits', () => {
  it('sends at most one request a second', async () => {
    vi.useFakeTimers({ now: T0 })
    const service = fakeService(() => json(OK))
    const listenbrainz = new ListenBrainzScrobbleClient(LISTENBRAINZ_TEST_TOKEN)
    const ctx = contextFor(service.fetch)
    const all = Promise.all([1, 2, 3].map(() => listenbrainz.submit([creepScrobble()], ctx)))
    await vi.runAllTimersAsync()
    await all
    expect(service.calls.map((call) => call.at - T0)).toEqual([0, 1000, 2000])
  })

  it('waits for the window to reset when the headers say it is used up', async () => {
    vi.useFakeTimers({ now: T0 })
    const service = fakeService(() =>
      json(OK, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-in': '7' } }),
    )
    const listenbrainz = new ListenBrainzScrobbleClient(LISTENBRAINZ_TEST_TOKEN)
    const ctx = contextFor(service.fetch)
    const both = Promise.all([
      listenbrainz.submit([creepScrobble()], ctx),
      listenbrainz.submit([creepScrobble()], ctx),
    ])
    await vi.runAllTimersAsync()
    await both
    expect(service.calls.map((call) => call.at - T0)).toEqual([0, 7000])
  })

  it('takes a 429 with its wait, from Retry-After or X-RateLimit-Reset-In', async () => {
    vi.useFakeTimers({ now: T0 })
    const { listenbrainz, ctx, calls } = client(() =>
      json(
        { code: 429, error: 'Too many requests' },
        { status: 429, headers: { 'x-ratelimit-reset-in': '30' } },
      ),
    )
    const error = await failure(listenbrainz.submit([creepScrobble()], ctx))
    expect(error).toMatchObject({ failure: 'rate-limited', retryAfterMs: 30_000, serviceCode: 429 })
    // Held: the next request fails at once.
    expect(await failure(listenbrainz.playingNow(creepScrobble().track, ctx))).toMatchObject({
      failure: 'rate-limited',
    })
    expect(calls).toHaveLength(1)
  })
})

describe('listenBrainzTarget', () => {
  it('submits under ListenBrainz rules and batch size', async () => {
    const { listenbrainz, ctx, calls } = client(() => json(OK))
    const target = listenBrainzTarget(listenbrainz)
    expect(target).toMatchObject({
      service: 'listenbrainz',
      rules: LISTENBRAINZ_RULES,
      batchSize: 100,
      paused: false,
    })
    await target.submit([creepScrobble()], ctx)
    await target.nowPlaying(creepScrobble().track, ctx)
    expect(calls.map((call) => bodyOf(call).listen_type)).toEqual(['single', 'playing_now'])
    expect(listenBrainzTarget(listenbrainz, { paused: true }).paused).toBe(true)
    expect(target).not.toHaveProperty('account')
    expect(listenBrainzTarget(listenbrainz, { account: 'token' }).account).toBe('token')
  })
})
