import { describe, expect, it, vi } from 'vitest'
import { SpotifyClient } from './client'
import { DEFAULT_SPOTIFY_CONFIG } from './config'
import { isSpotifyError, type SpotifyErrorReason } from './errors'
import {
  contextFor,
  type FakeSpotifyOptions,
  fakeClock,
  fakeSpotify,
  fixtures,
  json,
  SECRET_URL,
} from './fixtures/testing'
import { SpotifyHttp } from './http'
import { OperationRegistry } from './operations'
import { createSpotifySecretProvider } from './secret'
import { TokenManager } from './token'

function setup(options: FakeSpotifyOptions = {}) {
  const clock = options.clock ?? fakeClock()
  const spotify = fakeSpotify({ ...options, clock })
  const http = new SpotifyHttp({
    userAgent: () => DEFAULT_SPOTIFY_CONFIG.userAgent,
    now: clock.now,
    sleep: async () => {},
  })
  const tokens = new TokenManager({
    config: () => DEFAULT_SPOTIFY_CONFIG,
    http,
    secrets: createSpotifySecretProvider({ sources: [{ url: SECRET_URL }], now: clock.now }),
    now: clock.now,
  })
  const operations = new OperationRegistry(DEFAULT_SPOTIFY_CONFIG)
  const onClientRejected = vi.fn()
  const client = new SpotifyClient({
    config: () => DEFAULT_SPOTIFY_CONFIG,
    http,
    tokens,
    operations,
    onClientRejected,
  })
  return { spotify, client, operations, onClientRejected, ctx: contextFor(spotify.fetch) }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a failure')
    },
    (error: unknown) => error as Error,
  )
}

describe('SpotifyClient.query', () => {
  it('posts the persisted query with only the headers FXM Connect allows', async () => {
    const { spotify, client, ctx } = setup()
    const data = await client.query(
      'getTrack',
      { uri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r' },
      ctx,
    )
    expect(data).toHaveProperty('trackUnion')
    const [call] = spotify.callsOf('graphql')
    expect(call?.method).toBe('POST')
    expect(call?.operationName).toBe('getTrack')
    expect(call?.variables).toEqual({ uri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r' })
    expect(call?.sha256Hash).toBe(DEFAULT_SPOTIFY_CONFIG.operations.getTrack?.sha256Hash)
    expect(JSON.parse(String(call?.init?.body)).extensions.persistedQuery.version).toBe(1)
    expect(call?.token).toBe('fixture-token-1')
    const headerNames = [...(call?.headers.keys() ?? [])].sort()
    expect(headerNames).toEqual(['accept', 'authorization', 'content-type'])
    expect(call?.headers.get('content-type')).toBe('application/json;charset=UTF-8')
  })

  it('refreshes the token once after a 401 and repeats the call', async () => {
    const { spotify, client, ctx } = setup({
      graphql: {
        getTrack: (_variables, call) =>
          call.token === 'fixture-token-1'
            ? json(fixtures.error401, { status: 401 })
            : json(fixtures.getTrack),
      },
    })
    await client.query('getTrack', { uri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r' }, ctx)
    expect(spotify.callsOf('graphql').map((c) => c.token)).toEqual([
      'fixture-token-1',
      'fixture-token-2',
    ])
  })

  it('gives up with token-rejected after a second 401', async () => {
    const { spotify, client, ctx } = setup({
      graphql: { getTrack: () => json(fixtures.error401, { status: 401 }) },
    })
    const error = await failure(client.query('getTrack', { uri: 'x' }, ctx))
    expect(isSpotifyError(error, 'token-rejected')).toBe(true)
    expect(error).toMatchObject({ code: 'AuthRequired' })
    expect(spotify.callsOf('graphql')).toHaveLength(2)
    expect(error.message).not.toMatch(/fixture-token/u)
  })

  it('reports a refused User-Agent with its own error and no retry', async () => {
    const { spotify, client, onClientRejected, ctx } = setup({
      graphql: { getTrack: () => json(fixtures.error403Client, { status: 403 }) },
    })
    const error = await failure(client.query('getTrack', { uri: 'x' }, ctx))
    expect(isSpotifyError(error, 'client-rejected')).toBe(true)
    expect(error).toMatchObject({ code: 'Unsupported' })
    expect(error.message).toMatch(/browser User-Agent/u)
    expect(spotify.callsOf('graphql')).toHaveLength(1)
    expect(onClientRejected).toHaveBeenCalledTimes(1)
  })

  it('marks an operation broken after a 412 and stops calling it', async () => {
    const { spotify, client, operations, ctx } = setup({
      graphql: { getTrack: () => json('Invalid query hash', { status: 412 }) },
    })
    const error = await failure(client.query('getTrack', { uri: 'x' }, ctx))
    expect(isSpotifyError(error, 'operation-broken')).toBe(true)
    expect(operations.broken()).toEqual(['getTrack'])
    const again = await failure(client.query('getTrack', { uri: 'x' }, ctx))
    expect(isSpotifyError(again, 'operation-broken')).toBe(true)
    expect(spotify.callsOf('graphql')).toHaveLength(1)
    // Other operations still work.
    await client.query('getAlbum', { uri: 'x' }, ctx)
  })

  it('treats GraphQL validation errors as a broken operation', async () => {
    const { client, operations, ctx } = setup({
      graphql: { getTrack: () => json(fixtures.errorGraphql, { status: 400 }) },
    })
    const error = await failure(client.query('getTrack', {}, ctx))
    expect(isSpotifyError(error, 'operation-broken')).toBe(true)
    expect(operations.isAvailable('getTrack')).toBe(false)
  })

  const answers: Array<[string, () => Response, SpotifyErrorReason, string]> = [
    [
      'GraphQL errors without data',
      () => json({ errors: [{ message: 'Something failed', extensions: { code: 'INTERNAL' } }] }),
      'graphql',
      'Unavailable',
    ],
    [
      'GraphQL errors with a 400',
      () => json({ errors: [{ message: 'Bad input' }] }, { status: 400 }),
      'graphql',
      'Unavailable',
    ],
    [
      'a validation error inside a 200',
      () => json({ errors: [{ message: 'x', extensions: { code: 'VALIDATION_FAILED' } }] }),
      'operation-broken',
      'Unavailable',
    ],
    [
      'another 403',
      () => json({ error: { status: 403, message: 'Forbidden' } }, { status: 403 }),
      'forbidden',
      'Unavailable',
    ],
    ['a 404', () => json({}, { status: 404 }), 'not-found', 'NotFound'],
    ['a 400 without errors', () => new Response('bad', { status: 400 }), 'http', 'Unavailable'],
    ['malformed JSON', () => new Response('{"data":', { status: 200 }), 'bad-response', 'Parse'],
    ['an empty body', () => new Response('', { status: 200 }), 'bad-response', 'Parse'],
    ['data that is not an object', () => json({ data: [1, 2] }), 'bad-response', 'Parse'],
  ]

  for (const [name, answer, reason, code] of answers) {
    it(`maps ${name} to ${reason}`, async () => {
      const { client, ctx } = setup({ graphql: { getTrack: answer } })
      const error = await failure(client.query('getTrack', { uri: 'x' }, ctx))
      expect(isSpotifyError(error, reason)).toBe(true)
      expect(error).toMatchObject({ code })
    })
  }

  it('returns data even when GraphQL also reports errors', async () => {
    const { client, ctx } = setup({
      graphql: {
        getTrack: () => json({ data: { trackUnion: {} }, errors: [{ message: 'partial' }] }),
      },
    })
    expect(await client.query('getTrack', { uri: 'x' }, ctx)).toEqual({ trackUnion: {} })
  })

  it('uses the account token when asked', async () => {
    const { client, ctx } = setup()
    const error = await failure(client.query('home', {}, ctx, 'account'))
    expect(isSpotifyError(error, 'account-unsupported')).toBe(true)
  })
})

describe('SpotifyClient.spclient', () => {
  it('GETs JSON with the bearer token', async () => {
    const { spotify, client, ctx } = setup()
    const answer = await client.spclient(
      '/metadata/4/track/e666c6ccc4c7437f83552aa9bf4f2cfd?market=from_token',
      ctx,
    )
    expect(answer).toMatchObject({ name: 'Creep' })
    const [call] = spotify.callsOf('spclient')
    expect(call?.method).toBe('GET')
    expect(call?.url.searchParams.get('market')).toBe('from_token')
    expect([...(call?.headers.keys() ?? [])].sort()).toEqual(['accept', 'authorization'])
  })

  it('maps errors like the GraphQL calls', async () => {
    const cases: Array<[() => Response, SpotifyErrorReason]> = [
      [() => json({}, { status: 404 }), 'not-found'],
      [() => json(fixtures.error403Client, { status: 403 }), 'client-rejected'],
      [() => new Response('', { status: 200 }), 'bad-response'],
      [() => new Response('<html>', { status: 200 }), 'bad-response'],
    ]
    for (const [answer, reason] of cases) {
      const { client, ctx } = setup({ spclient: answer })
      const error = await failure(client.spclient('/metadata/4/track/abc', ctx))
      expect(isSpotifyError(error, reason)).toBe(true)
    }
  })

  it('refreshes once after a 401', async () => {
    const { spotify, client, ctx } = setup({
      spclient: (_path, call) =>
        call.token === 'fixture-token-1' ? json({}, { status: 401 }) : json({ ok: true }),
    })
    expect(await client.spclient('/x', ctx)).toEqual({ ok: true })
    expect(spotify.callsOf('spclient')).toHaveLength(2)
  })
})
