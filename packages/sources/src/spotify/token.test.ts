import { FxmError, type ProviderContext } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPOTIFY_CONFIG } from './config'
import { isSpotifyError } from './errors'
import {
  type Call,
  capabilities,
  contextFor,
  FAKE_SECRET,
  type FakeClock,
  type FakeSpotifyOptions,
  fakeClock,
  fakeSpotify,
  json,
  SECRET_URL,
} from './fixtures/testing'
import { SpotifyHttp } from './http'
import { createSecretProvider, deriveTotpKey } from './secret'
import { type SessionTokenSource, type SpotifyTokenParams, TokenManager } from './token'
import { totp } from './totp'

const MINUTE = 60_000
const KEY = deriveTotpKey(FAKE_SECRET.secret)

function setup(
  options: FakeSpotifyOptions & { session?: SessionTokenSource; clock?: FakeClock } = {},
) {
  const clock = options.clock ?? fakeClock()
  const spotify = fakeSpotify({ ...options, clock })
  const http = new SpotifyHttp({
    userAgent: DEFAULT_SPOTIFY_CONFIG.userAgent,
    now: clock.now,
    sleep: async () => {},
    random: () => 0,
  })
  const secrets = createSecretProvider({ sources: [{ url: SECRET_URL }], now: clock.now })
  const onSecretPause = vi.fn()
  const tokens = new TokenManager({
    config: DEFAULT_SPOTIFY_CONFIG,
    http,
    secrets,
    now: clock.now,
    onSecretPause,
    ...(options.session ? { session: options.session } : {}),
  })
  return { clock, spotify, tokens, onSecretPause, ctx: contextFor(spotify.fetch) }
}

/** A token answer from the fake token endpoint. */
function tokenAnswer(clock: FakeClock, token: string, lifetimeMs = 60 * MINUTE, anonymous = true) {
  return json({
    accessToken: token,
    accessTokenExpirationTimestampMs: clock.now() + lifetimeMs,
    isAnonymous: anonymous,
    clientId: 'fixture-client-id',
  })
}

describe('TokenManager, anonymous tokens', () => {
  it('sends the TOTP of the local and the server clock, with the secret version', async () => {
    const clock = fakeClock()
    const serverMs = clock.now() + 95_000
    const { spotify, tokens, ctx } = setup({
      clock,
      serverTime: () => json({ serverTime: Math.floor(serverMs / 1000) }),
    })
    const token = await tokens.get('anonymous', ctx)
    expect(token).toMatchObject({ accessToken: 'fixture-token-1', isAnonymous: true })
    const [call] = spotify.callsOf('token')
    const params = call?.url.searchParams
    expect(params?.get('reason')).toBe('init')
    expect(params?.get('productType')).toBe('web-player')
    expect(params?.get('totpVer')).toBe(String(FAKE_SECRET.version))
    expect(params?.get('totp')).toBe(await totp(KEY, clock.now()))
    expect(params?.get('totpServer')).toBe(await totp(KEY, Math.floor(serverMs / 1000) * 1000))
    expect(params?.get('totp')).not.toBe(params?.get('totpServer'))
    expect(call?.headers.get('accept')).toBe('application/json')
    expect(call?.headers.get('user-agent')).toBeNull()
  })

  it('sends a browser User-Agent from native transports', async () => {
    const { spotify, tokens } = setup()
    await tokens.get('anonymous', contextFor(spotify.fetch, { platform: 'android' }))
    for (const call of spotify.calls.filter((c) => c.kind !== 'secret')) {
      expect(call.headers.get('user-agent')).toMatch(/^Mozilla\/5\.0 .+Chrome\//u)
    }
  })

  it('falls back to the local clock when the server time is unavailable', async () => {
    const clock = fakeClock()
    const { spotify, tokens, ctx } = setup({
      clock,
      serverTime: () => json({ error: 'nope' }, { status: 404 }),
    })
    await tokens.get('anonymous', ctx)
    const params = spotify.callsOf('token')[0]?.url.searchParams
    expect(params?.get('totpServer')).toBe(await totp(KEY, clock.now()))
  })

  it('neither retries the server time nor pauses Spotify when it fails', async () => {
    const clock = fakeClock()
    const { spotify, tokens, ctx } = setup({
      clock,
      serverTime: () => json({}, { status: 503 }),
    })
    expect((await tokens.get('anonymous', ctx)).accessToken).toBe('fixture-token-1')
    expect(spotify.callsOf('server-time')).toHaveLength(1)
    const params = spotify.callsOf('token')[0]?.url.searchParams
    expect(params?.get('totpServer')).toBe(await totp(KEY, clock.now()))
  })

  it('keeps the token until a minute before it expires, then refreshes once', async () => {
    const { clock, spotify, tokens, ctx } = setup()
    const first = await tokens.get('anonymous', ctx)
    clock.advance(59 * MINUTE - 1)
    expect(await tokens.get('anonymous', ctx)).toBe(first)
    clock.advance(1)
    const [a, b, c] = await Promise.all([
      tokens.get('anonymous', ctx),
      tokens.get('anonymous', ctx),
      tokens.get('anonymous', ctx),
    ])
    expect(a.accessToken).toBe('fixture-token-2')
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(spotify.callsOf('token')).toHaveLength(2)
  })

  it('mints once for many concurrent first calls', async () => {
    const { spotify, tokens, ctx } = setup()
    await Promise.all(Array.from({ length: 10 }, () => tokens.get('anonymous', ctx)))
    expect(spotify.callsOf('token')).toHaveLength(1)
    expect(spotify.callsOf('secret')).toHaveLength(1)
  })

  it('uses a reused token that is already inside the margin until it expires', async () => {
    const clock = fakeClock()
    let n = 0
    const { spotify, tokens, ctx } = setup({
      clock,
      // Spotify hands out the same anonymous token until it expires.
      token: () => tokenAnswer(clock, `reused-${++n}`, 30_000),
    })
    await tokens.get('anonymous', ctx)
    clock.advance(29_000)
    await tokens.get('anonymous', ctx)
    expect(spotify.callsOf('token')).toHaveLength(1)
    clock.advance(1_000)
    await tokens.get('anonymous', ctx)
    expect(spotify.callsOf('token')).toHaveLength(2)
  })

  it('expires tokens on the local clock when the device clock is off', async () => {
    const clock = fakeClock()
    const skew = 2 * 60 * MINUTE
    const { tokens, ctx } = setup({
      clock,
      serverTime: () => json({ serverTime: Math.floor((clock.now() + skew) / 1000) }),
      token: () =>
        json({
          accessToken: 'skewed',
          accessTokenExpirationTimestampMs: clock.now() + skew + 60 * MINUTE,
          isAnonymous: true,
        }),
    })
    const token = await tokens.get('anonymous', ctx)
    expect(token.expiresAt).toBe(clock.now() + 60 * MINUTE)
  })

  it('drops a token on invalidate, but only the one that failed', async () => {
    const { spotify, tokens, ctx } = setup()
    const first = await tokens.get('anonymous', ctx)
    tokens.invalidate('anonymous', 'some-older-token')
    expect(await tokens.get('anonymous', ctx)).toBe(first)
    tokens.invalidate('anonymous', first.accessToken)
    expect((await tokens.get('anonymous', ctx)).accessToken).toBe('fixture-token-2')
    tokens.invalidate('anonymous')
    expect((await tokens.get('anonymous', ctx)).accessToken).toBe('fixture-token-3')
    expect(spotify.callsOf('token')).toHaveLength(3)
  })

  it('keeps using a valid token when a refresh fails', async () => {
    const clock = fakeClock()
    let fail = false
    const { tokens, ctx } = setup({
      clock,
      token: () => (fail ? json({}, { status: 503 }) : tokenAnswer(clock, 'still-good')),
    })
    const first = await tokens.get('anonymous', ctx)
    clock.advance(59 * MINUTE + 1)
    fail = true
    expect(await tokens.get('anonymous', ctx)).toBe(first)
    clock.advance(MINUTE)
    await expect(tokens.get('anonymous', ctx)).rejects.toMatchObject({ code: 'RateLimited' })
  })

  it('refuses answers without a usable or unexpired token', async () => {
    const clock = fakeClock()
    const empty = setup({ clock, token: () => json({ isAnonymous: true }) })
    await expect(empty.tokens.get('anonymous', empty.ctx)).rejects.toMatchObject({
      code: 'Parse',
      reason: 'bad-response',
    })
    const stale = setup({ clock, token: () => tokenAnswer(clock, 'old', -1) })
    await expect(stale.tokens.get('anonymous', stale.ctx)).rejects.toThrow(/expired token/u)
  })

  it('maps other token-endpoint answers to typed errors', async () => {
    const answers: Array<[number, string]> = [
      [403, 'client-rejected'],
      [404, 'http'],
    ]
    for (const [status, reason] of answers) {
      const { tokens, ctx } = setup({ token: () => json({}, { status }) })
      const error = await tokens.get('anonymous', ctx).catch((e: unknown) => e)
      expect(isSpotifyError(error, reason as never)).toBe(true)
    }
  })

  it('does not store a token minted before clear', async () => {
    const clock = fakeClock()
    let release: (() => void) | undefined
    let n = 0
    const { tokens, ctx } = setup({
      clock,
      token: () => {
        n += 1
        if (n > 1) return tokenAnswer(clock, 'from-after')
        return new Promise((resolve) => {
          release = () => resolve(tokenAnswer(clock, 'from-before'))
        })
      },
    })
    const pending = tokens.get('anonymous', ctx)
    await vi.waitFor(() => expect(release).toBeDefined())
    tokens.clear()
    release?.()
    expect((await pending).accessToken).toBe('from-before')
    expect((await tokens.get('anonymous', ctx)).accessToken).toBe('from-after')
  })
})

describe('TokenManager, secret failures', () => {
  it('fetches the secret again once when the TOTP is refused, then succeeds', async () => {
    const clock = fakeClock()
    let secretCalls = 0
    const { spotify, tokens, ctx } = setup({
      clock,
      secret: () => {
        secretCalls += 1
        return json(secretCalls === 1 ? { '6': [1, 2, 3] } : { '8': FAKE_SECRET.secret })
      },
      token: (params) =>
        params.get('totpVer') === '6'
          ? json(
              { totpVerExpired: 'error', error: { code: 400, message: 'Unauthorized request' } },
              { status: 400 },
            )
          : tokenAnswer(clock, 'with-new-secret'),
    })
    expect((await tokens.get('anonymous', ctx)).accessToken).toBe('with-new-secret')
    expect(spotify.callsOf('secret')).toHaveLength(2)
    expect(spotify.callsOf('token').map((c) => c.url.searchParams.get('totpVer'))).toEqual([
      '6',
      '8',
    ])
  })

  it('pauses minting after the TOTP is refused twice, and resumes on demand', async () => {
    const clock = fakeClock()
    const refuse = { value: true }
    const { spotify, tokens, onSecretPause, ctx } = setup({
      clock,
      token: () =>
        refuse.value
          ? json({ error: { code: 400, message: 'Unauthorized request' } }, { status: 400 })
          : tokenAnswer(clock, 'after-pause'),
    })
    const error = await tokens.get('anonymous', ctx).catch((e: unknown) => e)
    expect(isSpotifyError(error, 'secret-rejected')).toBe(true)
    expect((error as Error).message).toMatch(/refused the TOTP twice/u)
    expect(onSecretPause).toHaveBeenCalledWith(clock.now() + 5 * MINUTE)
    expect(tokens.secretPausedUntil).toBe(clock.now() + 5 * MINUTE)
    const requests = spotify.calls.length
    await expect(tokens.get('anonymous', ctx)).rejects.toThrow(/its TOTP secret stopped working/u)
    expect(spotify.calls).toHaveLength(requests)
    refuse.value = false
    clock.advance(5 * MINUTE)
    expect(tokens.secretPausedUntil).toBeUndefined()
    expect((await tokens.get('anonymous', ctx)).accessToken).toBe('after-pause')
    refuse.value = true
    tokens.invalidate('anonymous')
    await tokens.get('anonymous', ctx).catch(() => undefined)
    tokens.resumeSecret()
    expect(tokens.secretPausedUntil).toBeUndefined()
  })

  it('says when the secret version expired', async () => {
    const { tokens, ctx } = setup({
      token: () =>
        json(
          { totpVerExpired: 'error', totpValidUntil: '2025-10-18T09:00:00.000Z' },
          { status: 400 },
        ),
    })
    await expect(tokens.get('anonymous', ctx)).rejects.toThrow(/secret version expired/u)
  })

  it('reports an unreachable secret source', async () => {
    const { spotify, tokens, ctx } = setup({
      secret: () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')),
    })
    const error = await tokens.get('anonymous', ctx).catch((e: unknown) => e)
    expect(isSpotifyError(error, 'secret-unavailable')).toBe(true)
    expect(spotify.callsOf('token')).toHaveLength(0)
  })

  it('never puts a token, a TOTP or the secret in an error message', async () => {
    const clock = fakeClock()
    const { spotify, tokens, ctx } = setup({
      clock,
      token: () => json({ error: { code: 400 } }, { status: 400 }),
    })
    const error = (await tokens.get('anonymous', ctx).catch((e: unknown) => e)) as Error
    const codes = spotify
      .callsOf('token')
      .flatMap((c) => [
        c.url.searchParams.get('totp') ?? '',
        c.url.searchParams.get('totpServer') ?? '',
      ])
    for (const code of codes) expect(error.message).not.toContain(code)
    expect(error.message).not.toContain(String.fromCharCode(...FAKE_SECRET.secret))
  })
})

describe('TokenManager, account tokens', () => {
  function session(answer: (params: SpotifyTokenParams) => unknown, status = 200) {
    const calls: SpotifyTokenParams[] = []
    const source: SessionTokenSource = {
      requestToken: async (params) => {
        calls.push(params)
        return { status, json: answer(params) }
      },
    }
    return { source, calls }
  }

  const accountCtx = (s: ReturnType<typeof setup>): ProviderContext => ({
    ...s.ctx,
    capabilities: capabilities('account'),
  })

  it('asks the session source with reason=transport and the TOTP', async () => {
    const clock = fakeClock()
    const { source, calls } = session(() => ({
      accessToken: 'account-token',
      accessTokenExpirationTimestampMs: clock.now() + 60 * MINUTE,
      isAnonymous: false,
    }))
    const s = setup({ clock, session: source })
    const token = await s.tokens.get('account', accountCtx(s))
    expect(token).toMatchObject({ accessToken: 'account-token', isAnonymous: false })
    expect(calls[0]).toMatchObject({
      reason: 'transport',
      productType: 'web-player',
      totpVer: String(FAKE_SECRET.version),
      totp: await totp(KEY, clock.now()),
    })
    expect(s.spotify.callsOf('token')).toHaveLength(0)
  })

  it('reports a logged-out user once, then remembers it for a minute', async () => {
    const clock = fakeClock()
    const { source, calls } = session(() => ({
      accessToken: 'anonymous-anyway',
      accessTokenExpirationTimestampMs: clock.now() + 60 * MINUTE,
      isAnonymous: true,
    }))
    const s = setup({ clock, session: source })
    const ctx = accountCtx(s)
    const error = await s.tokens.get('account', ctx).catch((e: unknown) => e)
    expect(isSpotifyError(error, 'login-required')).toBe(true)
    await expect(s.tokens.get('account', ctx)).rejects.toMatchObject({ code: 'AuthRequired' })
    expect(calls).toHaveLength(1)
    clock.advance(MINUTE)
    await expect(s.tokens.get('account', ctx)).rejects.toMatchObject({ code: 'AuthRequired' })
    expect(calls).toHaveLength(2)
    s.tokens.clear('account')
    await s.tokens.get('account', ctx).catch(() => undefined)
    expect(calls).toHaveLength(3)
  })

  it('maps a 401 from the session source to login-required', async () => {
    const { source } = session(() => null, 401)
    const s = setup({ session: source })
    const error = await s.tokens.get('account', accountCtx(s)).catch((e: unknown) => e)
    expect(isSpotifyError(error, 'login-required')).toBe(true)
  })

  it('needs both a session source and the account capability', async () => {
    const plain = setup()
    const withoutSource = await plain.tokens
      .get('account', accountCtx(plain))
      .catch((e: unknown) => e)
    expect(isSpotifyError(withoutSource, 'account-unavailable')).toBe(true)
    const { source, calls } = session(() => ({}))
    const s = setup({ session: source })
    expect(s.tokens.hasSession(s.ctx)).toBe(false)
    const anonymousOnly = await s.tokens.get('account', s.ctx).catch((e: unknown) => e)
    expect(isSpotifyError(anonymousOnly, 'account-unavailable')).toBe(true)
    expect(calls).toHaveLength(0)
    expect(s.tokens.hasSession(accountCtx(s))).toBe(true)
  })

  it('passes errors of the session source through', async () => {
    const source: SessionTokenSource = {
      requestToken: () => Promise.reject(Object.assign(new Error('bridge timeout'), { code: 'x' })),
    }
    const s = setup({ session: source })
    await expect(s.tokens.get('account', accountCtx(s))).rejects.toThrow('bridge timeout')
  })

  it('remembers for a minute that the login is off, sparing the bridge', async () => {
    const clock = fakeClock()
    const requestToken = vi.fn<SessionTokenSource['requestToken']>(() =>
      Promise.reject(new FxmError('AuthRequired', 'login-disabled')),
    )
    const s = setup({ clock, session: { requestToken } })
    const ctx = accountCtx(s)
    await expect(s.tokens.get('account', ctx)).rejects.toThrow('login-disabled')
    await expect(s.tokens.get('account', ctx)).rejects.toMatchObject({ reason: 'login-required' })
    expect(requestToken).toHaveBeenCalledTimes(1)
    clock.advance(MINUTE)
    await expect(s.tokens.get('account', ctx)).rejects.toThrow('login-disabled')
    expect(requestToken).toHaveBeenCalledTimes(2)
  })
})

describe('TokenManager, aborts', () => {
  it('re-mints for a caller whose shared mint was aborted by another caller', async () => {
    const clock = fakeClock()
    let n = 0
    const { tokens, ctx } = setup({
      clock,
      token: (_params, call: Call) => {
        n += 1
        if (n > 1) return tokenAnswer(clock, `token-${n}`)
        // The first request waits until its caller gives up.
        return new Promise((_resolve, reject) => {
          const signal = call.init?.signal
          signal?.addEventListener('abort', () => reject(signal.reason))
        })
      },
    })
    const controller = new AbortController()
    const a = tokens.get('anonymous', { ...ctx, signal: controller.signal })
    const b = tokens.get('anonymous', ctx)
    await vi.waitFor(() => expect(n).toBe(1))
    controller.abort(new DOMException('stop', 'AbortError'))
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    expect((await b).accessToken).toBe('token-2')
  })
})
