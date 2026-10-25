import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScrobbleError } from './errors'
import {
  type Call,
  contextFor,
  creepScrobble,
  fakeService,
  fixtures,
  formOf,
  hangingFetch,
  html,
  json,
  LASTFM_TEST_CREDENTIALS,
  LASTFM_TEST_SESSION_KEY,
  T0,
} from './fixtures/testing'
import {
  isLastfmKey,
  LASTFM_API_URL,
  LASTFM_BATCH_SIZE,
  LastfmScrobbleClient,
  lastfmFailureOf,
  lastfmSignature,
  lastfmTarget,
  scrobbleReport,
} from './lastfm'
import { LASTFM_RULES } from './rules'

const { secret } = LASTFM_TEST_CREDENTIALS

/** A client without the pause between requests, so tests run on the real clock. */
function client(route: (call: Call) => Response | Promise<Response>) {
  const service = fakeService(route)
  const lastfm = new LastfmScrobbleClient(LASTFM_TEST_CREDENTIALS, { minIntervalMs: 0 })
  return { lastfm, ctx: contextFor(service.fetch), calls: service.calls }
}

/** Expects `call` to be a signed POST to the API root with nothing in its URL. */
function expectSignedPost(call: Call | undefined): Record<string, string> {
  expect(call?.method).toBe('POST')
  expect(call?.url.href).toBe(LASTFM_API_URL)
  expect(call?.init?.credentials).toBe('omit')
  const form = call ? formOf(call) : {}
  const { api_sig, format, ...signed } = form
  expect(format).toBe('json')
  expect(api_sig).toBe(lastfmSignature(signed, secret))
  expect(call?.body).not.toContain(secret)
  return form
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

describe('lastfmSignature', () => {
  it("matches the example in Last.fm's authentication spec", () => {
    const params = { method: 'auth.getSession', api_key: 'xxxxxxxxxx', token: 'yyyyyy' }
    expect(lastfmSignature(params, 'ilovecher')).toBe('b87d61da3cda91a8b6746c4aef55d6f8')
  })

  it('leaves out format and callback, and sorts names by code unit', () => {
    const base = { method: 'auth.getSession', api_key: 'xxxxxxxxxx', token: 'yyyyyy' }
    const withFormat = { ...base, format: 'json', callback: 'cb' }
    expect(lastfmSignature(withFormat, 'ilovecher')).toBe(lastfmSignature(base, 'ilovecher'))
    // ASCII order puts artist[10] before artist[1] ('0' < ']'), as Last.fm's docs say:
    // md5('artist[10]aartist[1]bs'), whichever order the parameters come in.
    const params = { 'artist[1]': 'b', 'artist[10]': 'a' }
    expect(lastfmSignature(params, 's')).toBe('f79e82c227b084c076310b68c3628bf6')
  })
})

describe('isLastfmKey', () => {
  it('accepts 32 hexadecimal digits in either case', () => {
    expect(isLastfmKey(LASTFM_TEST_CREDENTIALS.apiKey)).toBe(true)
    expect(isLastfmKey(LASTFM_TEST_CREDENTIALS.apiKey.toUpperCase())).toBe(true)
    expect(isLastfmKey(`${LASTFM_TEST_CREDENTIALS.apiKey} `)).toBe(false)
    expect(isLastfmKey('xyz')).toBe(false)
    expect(isLastfmKey(42)).toBe(false)
  })
})

describe('LastfmScrobbleClient authentication', () => {
  it('gets a request token with a signed POST and builds the page to allow it', async () => {
    const { lastfm, ctx, calls } = client(() => json(fixtures.lastfmToken))
    const token = await lastfm.getToken(ctx)
    expect(token).toBe('cf45fe5a3e3cebe168480a086d7fe481')
    expect(expectSignedPost(calls[0])).toMatchObject({
      method: 'auth.getToken',
      api_key: LASTFM_TEST_CREDENTIALS.apiKey,
    })
    expect(lastfm.authorizeUrl(token)).toBe(
      `https://www.last.fm/api/auth/?api_key=${LASTFM_TEST_CREDENTIALS.apiKey}&token=${token}`,
    )
  })

  it('turns an allowed token into a session', async () => {
    const { lastfm, ctx, calls } = client(() => json(fixtures.lastfmSession))
    const session = await lastfm.getSession('cf45fe5a3e3cebe168480a086d7fe481', ctx)
    expect(session).toEqual({
      userName: 'MyLastFMUsername',
      sessionKey: 'd580d57f32848f5dcf574d1ce18d78b2',
    })
    expect(expectSignedPost(calls[0])).toMatchObject({
      method: 'auth.getSession',
      token: 'cf45fe5a3e3cebe168480a086d7fe481',
    })
  })

  it('says when the user has not allowed the token yet, or it expired', async () => {
    const notYet = client(() =>
      json(
        { message: 'Unauthorized Token - This token has not been issued', error: 14 },
        { status: 403 },
      ),
    )
    const pending = await failure(notYet.lastfm.getSession('t', notYet.ctx))
    expect(pending).toMatchObject({ failure: 'refused', serviceCode: 14, code: 'AuthRequired' })
    const expired = client(() => json({ message: 'Token expired', error: 15 }))
    expect(await failure(expired.lastfm.getSession('t', expired.ctx))).toMatchObject({
      serviceCode: 15,
    })
  })

  it('refuses an API key Last.fm does not know (recorded answer)', async () => {
    const { lastfm, ctx } = client(() => json(fixtures.lastfmInvalidApiKey, { status: 403 }))
    const error = await failure(lastfm.getToken(ctx))
    expect(error).toMatchObject({ failure: 'refused', serviceCode: 10, service: 'lastfm' })
    expect(error.message).toBe('Last.fm answered with error 10 (invalid API key)')
  })

  it('takes an answer without a token or a session as unreadable', async () => {
    const { lastfm, ctx } = client(() => json({ session: { name: 'someone' } }))
    const error = await failure(lastfm.getSession('t', ctx))
    expect(error).toMatchObject({ failure: 'temporary', code: 'Parse' })
    const noToken = client(() => json({ token: 'has spaces in it' }))
    expect(await failure(noToken.lastfm.getToken(noToken.ctx))).toMatchObject({ code: 'Parse' })
  })
})

describe('LastfmScrobbleClient.updateNowPlaying', () => {
  it('sends the main artist, title, album, position and length in seconds, signed', async () => {
    const { lastfm, ctx, calls } = client(() => json(fixtures.lastfmNowPlaying))
    const { track } = creepScrobble()
    await lastfm.updateNowPlaying(
      LASTFM_TEST_SESSION_KEY,
      { ...track, artists: ['Radiohead', 'Someone Else'] },
      ctx,
    )
    expect(expectSignedPost(calls[0])).toEqual({
      method: 'track.updateNowPlaying',
      api_key: LASTFM_TEST_CREDENTIALS.apiKey,
      sk: LASTFM_TEST_SESSION_KEY,
      artist: 'Radiohead',
      track: 'Creep',
      album: 'Pablo Honey',
      trackNumber: '2',
      duration: '239',
      api_sig: expect.any(String),
      format: 'json',
    })
  })
})

describe('LastfmScrobbleClient.scrobble', () => {
  it('sends a batch in array notation, with start times in seconds', async () => {
    const { lastfm, ctx, calls } = client(() => json(fixtures.lastfmScrobbleTwoOneIgnored))
    const first = creepScrobble(T0 + 999)
    const second = { ...creepScrobble(T0 + 240_000), chosenByUser: false }
    delete second.track.album
    const report = await lastfm.scrobble(LASTFM_TEST_SESSION_KEY, [first, second], ctx)
    expect(report).toEqual({ accepted: 1, ignored: 1, ignoredCodes: [1] })
    const form = expectSignedPost(calls[0])
    expect(form).toMatchObject({
      method: 'track.scrobble',
      sk: LASTFM_TEST_SESSION_KEY,
      'artist[0]': 'Radiohead',
      'track[0]': 'Creep',
      'album[0]': 'Pablo Honey',
      'timestamp[0]': String(Math.floor(T0 / 1000)),
      'duration[0]': '239',
      'trackNumber[0]': '2',
      'artist[1]': 'Radiohead',
      'timestamp[1]': String((T0 + 240_000) / 1000),
      'chosenByUser[1]': '0',
    })
    expect(form).not.toHaveProperty('album[1]')
    expect(form).not.toHaveProperty('chosenByUser[0]')
  })

  it('reads the report of one scrobble, and counts an unreadable answer as accepted', async () => {
    const one = client(() => json(fixtures.lastfmScrobbleOne))
    expect(await one.lastfm.scrobble('sk', [creepScrobble()], one.ctx)).toEqual({
      accepted: 1,
      ignored: 0,
      ignoredCodes: [],
    })
    const unreadable = client(() => new Response('', { status: 200 }))
    expect(await unreadable.lastfm.scrobble('sk', [creepScrobble()], unreadable.ctx)).toEqual({
      accepted: 1,
      ignored: 0,
      ignoredCodes: [],
    })
  })

  it('sends nothing for no scrobbles and refuses more than Last.fm takes', async () => {
    const { lastfm, ctx, calls } = client(() => json(fixtures.lastfmScrobbleOne))
    expect(await lastfm.scrobble('sk', [], ctx)).toEqual({
      accepted: 0,
      ignored: 0,
      ignoredCodes: [],
    })
    const many = Array.from({ length: LASTFM_BATCH_SIZE + 1 }, () => creepScrobble())
    await expect(lastfm.scrobble('sk', many, ctx)).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(0)
  })
})

describe('scrobbleReport', () => {
  it('reads counts written as numbers or strings, and never more than were sent', () => {
    const answer = { scrobbles: { '@attr': { accepted: '3', ignored: '0' }, scrobble: [] } }
    expect(scrobbleReport(answer, 3)).toEqual({ accepted: 3, ignored: 0, ignoredCodes: [] })
    const odd = { scrobbles: { '@attr': { accepted: 9, ignored: 9 } } }
    expect(scrobbleReport(odd, 2)).toEqual({ accepted: 0, ignored: 2, ignoredCodes: [] })
    const noCounts = {
      scrobbles: { scrobble: [{ ignoredMessage: { code: '3' } }, { ignoredMessage: { code: 0 } }] },
    }
    expect(scrobbleReport(noCounts, 2)).toEqual({ accepted: 1, ignored: 1, ignoredCodes: [3] })
  })
})

describe('Last.fm errors', () => {
  it('sorts error codes by what the queue should do', () => {
    expect([9, 4, 10, 13, 14, 15, 26].map(lastfmFailureOf)).toEqual(Array(7).fill('refused'))
    expect([11, 16].map(lastfmFailureOf)).toEqual(['temporary', 'temporary'])
    expect(lastfmFailureOf(29)).toBe('rate-limited')
    expect([2, 3, 5, 6, 7, 8, 99].map(lastfmFailureOf)).toEqual(Array(7).fill('rejected'))
  })

  it('reads the error in the body whatever the HTTP status', async () => {
    const ok = client(() => json({ message: 'Invalid session key', error: 9 }))
    const error = await failure(ok.lastfm.scrobble('sk', [creepScrobble()], ok.ctx))
    expect(error).toMatchObject({ failure: 'refused', serviceCode: 9 })
    const offline = client(() => json({ message: 'Service Offline', error: 11 }, { status: 503 }))
    expect(
      await failure(offline.lastfm.scrobble('sk', [creepScrobble()], offline.ctx)),
    ).toMatchObject({ failure: 'temporary', serviceCode: 11 })
    const bad = client(() => json({ message: 'Missing parameter', error: 6 }, { status: 400 }))
    expect(await failure(bad.lastfm.scrobble('sk', [creepScrobble()], bad.ctx))).toMatchObject({
      failure: 'rejected',
      serviceCode: 6,
    })
  })

  it('never puts the service message, which could echo a parameter, in its own', async () => {
    const { lastfm, ctx } = client(() =>
      json({ message: `bad sk ${LASTFM_TEST_SESSION_KEY}`, error: 9 }),
    )
    const error = await failure(
      lastfm.updateNowPlaying(LASTFM_TEST_SESSION_KEY, creepScrobble().track, ctx),
    )
    expect(error.message).not.toContain(LASTFM_TEST_SESSION_KEY)
  })

  it('waits as long as a rate limit asks, holding the next requests too', async () => {
    vi.useFakeTimers({ now: T0 })
    const { lastfm, ctx, calls } = client(() =>
      json(
        { message: 'Rate limit exceeded', error: 29 },
        { status: 429, headers: { 'retry-after': '120' } },
      ),
    )
    const error = await failure(lastfm.scrobble('sk', [creepScrobble()], ctx))
    expect(error).toMatchObject({
      failure: 'rate-limited',
      code: 'RateLimited',
      retryAfterMs: 120_000,
    })
    // The next request fails at once, without reaching Last.fm.
    const held = await failure(lastfm.updateNowPlaying('sk', creepScrobble().track, ctx))
    expect(held).toMatchObject({ failure: 'rate-limited', retryAfterMs: 120_000 })
    expect(calls).toHaveLength(1)
  })

  it('takes an HTTP 429 without a body as a rate limit, and other statuses as temporary', async () => {
    const limited = client(() => new Response('', { status: 429 }))
    expect(await failure(limited.lastfm.getToken(limited.ctx))).toMatchObject({
      failure: 'rate-limited',
      serviceCode: 429,
      retryAfterMs: undefined,
    })
    const gateway = client(() => html(502))
    expect(await failure(gateway.lastfm.getToken(gateway.ctx))).toMatchObject({
      failure: 'temporary',
      serviceCode: 502,
      code: 'Unavailable',
    })
  })

  it("takes a network failure or a timeout as temporary, and a cancel as the caller's", async () => {
    const down = client(() => {
      throw new TypeError('Failed to fetch')
    })
    const error = await failure(down.lastfm.getToken(down.ctx))
    expect(error).toMatchObject({ failure: 'temporary', code: 'Network' })
    expect(isFxmError(error, 'Network')).toBe(true)

    const slow = new LastfmScrobbleClient(LASTFM_TEST_CREDENTIALS, {
      minIntervalMs: 0,
      timeoutMs: 50,
    })
    const timeout = await failure(slow.getToken(contextFor(hangingFetch)))
    expect(timeout.message).toBe('Last.fm did not answer within 50 ms')

    const controller = new AbortController()
    const pending = slow.getToken(contextFor(hangingFetch, controller.signal))
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
  })
})

describe('lastfmTarget', () => {
  it('scrobbles with the session, under Last.fm rules and batch size', async () => {
    const { lastfm, ctx, calls } = client(() => json(fixtures.lastfmScrobbleOne))
    const target = lastfmTarget(lastfm, LASTFM_TEST_SESSION_KEY)
    expect(target).toMatchObject({
      service: 'lastfm',
      rules: LASTFM_RULES,
      batchSize: 50,
      paused: false,
    })
    await target.submit([creepScrobble()], ctx)
    await target.nowPlaying(creepScrobble().track, ctx)
    expect(calls.map((call) => formOf(call).sk)).toEqual([
      LASTFM_TEST_SESSION_KEY,
      LASTFM_TEST_SESSION_KEY,
    ])
    expect(lastfmTarget(lastfm, 'sk', { paused: true }).paused).toBe(true)
    expect(target).not.toHaveProperty('account')
    expect(lastfmTarget(lastfm, 'sk', { account: 'sk' }).account).toBe('sk')
  })
})

describe('the pause between requests', () => {
  it('spaces requests by minIntervalMs', async () => {
    vi.useFakeTimers({ now: T0 })
    const service = fakeService(() => json(fixtures.lastfmToken))
    const lastfm = new LastfmScrobbleClient(LASTFM_TEST_CREDENTIALS)
    const ctx = contextFor(service.fetch)
    const both = Promise.all([lastfm.getToken(ctx), lastfm.getToken(ctx)])
    await vi.runAllTimersAsync()
    await both
    const [first, second] = service.calls
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBe(250)
  })
})
