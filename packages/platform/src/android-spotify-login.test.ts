import { isFxmError, type ProviderContext } from '@fxm/core'
import { createSpotifyProvider } from '@fxm/sources/spotify'
import { describe, expect, it, vi } from 'vitest'
import {
  androidSpotifyLoginIfAvailable,
  createAndroidSpotifyLogin,
  FXM_SPOTIFY_LOGIN_PLUGIN,
  FXM_SPOTIFY_LOGIN_RATE_LIMIT,
  FXM_SPOTIFY_LOGIN_TOKEN_PARAMS,
  findFxmSpotifyLoginPlugin,
  fxmSpotifyLoginErrorCode,
  SpotifyLoginError,
  spotifyLoginWindowOf,
} from './android-spotify-login'
import { SPOTIFY_TOKEN_PARAM_FORMS } from './connect'
import { connectSessionSource } from './spotify-session'
import {
  createFakeFxmSpotifyLogin,
  type FakeFxmSpotifyLoginOptions,
  fxmSpotifyLoginError,
} from './testing/fake-spotify-login'

const PARAMS = {
  reason: 'transport',
  productType: 'web-player',
  totp: '123456',
  totpServer: '654321',
  totpVer: '61',
}

function setup(options: FakeFxmSpotifyLoginOptions = {}) {
  const plugin = createFakeFxmSpotifyLogin(options)
  return { plugin, login: createAndroidSpotifyLogin({ plugin }) }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure')
    },
    (error: unknown) => error,
  )
}

describe('finding the plugin', () => {
  const plugin = createFakeFxmSpotifyLogin()
  const app = (plugins: Record<string, unknown>, native = true) => ({
    Capacitor: { isNativePlatform: () => native, Plugins: plugins },
  })

  it('finds it only in the Android app, with every method', () => {
    expect(findFxmSpotifyLoginPlugin(app({ [FXM_SPOTIFY_LOGIN_PLUGIN]: plugin }))).toBe(plugin)
    expect(findFxmSpotifyLoginPlugin(app({ [FXM_SPOTIFY_LOGIN_PLUGIN]: plugin }, false))).toBe(
      undefined,
    )
    expect(findFxmSpotifyLoginPlugin(app({}))).toBeUndefined()
    const { requestToken: _left, ...partial } = plugin
    expect(findFxmSpotifyLoginPlugin(app({ [FXM_SPOTIFY_LOGIN_PLUGIN]: partial }))).toBe(undefined)
    expect(findFxmSpotifyLoginPlugin({})).toBeUndefined()
    // This test runs in Node, which is no Android app.
    expect(findFxmSpotifyLoginPlugin()).toBeUndefined()
    expect(androidSpotifyLoginIfAvailable()).toBeUndefined()
  })

  it('wraps the bridge’s plugin, and refuses to start without one', async () => {
    const login = androidSpotifyLoginIfAvailable(app({ [FXM_SPOTIFY_LOGIN_PLUGIN]: plugin }))
    expect(login).toBeDefined()
    await expect(login?.loginState()).resolves.toEqual({ loggedIn: false, available: true })
    let error: unknown
    try {
      createAndroidSpotifyLogin()
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })
})

describe('the token source', () => {
  it('asks for a token with the kept login, sending only the allow-listed parameters in order', async () => {
    const { plugin, login } = setup({ loggedIn: true })
    const answer = await login.requestToken({
      totpVer: '61',
      totp: '123456',
      reason: 'transport',
      productType: 'web-player',
      totpServer: '654321',
    })
    expect(answer).toMatchObject({ status: 200, json: { isAnonymous: false } })
    expect(plugin.tokenRequests).toEqual([PARAMS])
    expect(Object.keys(plugin.tokenRequests[0] ?? {})).toEqual([
      'reason',
      'productType',
      'totp',
      'totpServer',
      'totpVer',
    ])
  })

  it('passes Spotify’s answer on as it is, a refusal included', async () => {
    const { login } = setup({
      loggedIn: true,
      answer: () => ({ status: 400, json: { error: { code: 400 }, totpVerExpired: 'x' } }),
    })
    await expect(login.requestToken(PARAMS)).resolves.toEqual({
      status: 400,
      json: { error: { code: 400 }, totpVerExpired: 'x' },
    })
    const { login: notJson } = setup({
      loggedIn: true,
      answer: () => ({ status: 502, json: null }),
    })
    await expect(notJson.requestToken(PARAMS)).resolves.toEqual({ status: 502, json: null })
  })

  it('says AuthRequired while no login is kept, so the provider reports login-required', async () => {
    const { plugin, login } = setup()
    const error = await failure(login.requestToken(PARAMS))
    expect(isFxmError(error, 'AuthRequired')).toBe(true)
    expect(error).toBeInstanceOf(SpotifyLoginError)
    expect((error as SpotifyLoginError).loginCode).toBe('LOGGED_OUT')
    expect(plugin.tokenRequests).toEqual([])
  })

  it('refuses parameters outside the allow-list before asking the plugin', async () => {
    const { plugin, login } = setup({ loggedIn: true })
    for (const params of [
      { ...PARAMS, totp: '12345' },
      { ...PARAMS, totpVer: '12345' },
      { ...PARAMS, reason: 'transport&x=1' },
      { ...PARAMS, sp_dc: 'a-cookie' },
    ]) {
      const error = await failure(login.requestToken(params as typeof PARAMS))
      expect(isFxmError(error, 'Unsupported'), JSON.stringify(params)).toBe(true)
      expect((error as SpotifyLoginError).loginCode).toBe('BAD_REQUEST')
    }
    expect(plugin.calls).toEqual([])
  })

  it('checks the same forms as FXM Connect’s bridge', () => {
    expect(Object.fromEntries(FXM_SPOTIFY_LOGIN_TOKEN_PARAMS)).toEqual(SPOTIFY_TOKEN_PARAM_FORMS)
  })

  it('turns the plugin’s refusals into the errors the provider understands', async () => {
    const cases = [
      ['RATE_LIMITED', 'RateLimited'],
      ['NETWORK', 'Network'],
      ['TIMEOUT', 'Network'],
      ['TOO_LARGE', 'Parse'],
      ['BAD_REQUEST', 'Unsupported'],
      ['STORAGE', 'Unavailable'],
    ] as const
    for (const [code, fxmCode] of cases) {
      const { login } = setup({
        loggedIn: true,
        answer: () => {
          throw fxmSpotifyLoginError(code, 'refused', { retryAfterMs: 1500 })
        },
      })
      const error = await failure(login.requestToken(PARAMS))
      expect(isFxmError(error, fxmCode), code).toBe(true)
      expect(fxmSpotifyLoginErrorCode((error as SpotifyLoginError).cause)).toBe(code)
      expect((error as SpotifyLoginError).loginCode).toBe(code)
    }
    const { login } = setup({
      loggedIn: true,
      answer: () => {
        throw new Error('the bridge broke')
      },
    })
    const error = await failure(login.requestToken(PARAMS))
    expect(isFxmError(error, 'Network')).toBe(true)
    expect((error as SpotifyLoginError).loginCode).toBeUndefined()
  })

  it('rate limits like the native plugin, saying how long to wait', async () => {
    let now = 1_000_000
    const { login } = setup({ loggedIn: true, now: () => now })
    for (let i = 0; i < FXM_SPOTIFY_LOGIN_RATE_LIMIT.max; i++) {
      await login.requestToken(PARAMS)
      now += 1000
    }
    const error = await failure(login.requestToken(PARAMS))
    expect(isFxmError(error, 'RateLimited')).toBe(true)
    expect((error as SpotifyLoginError).retryAfterMs).toBe(
      FXM_SPOTIFY_LOGIN_RATE_LIMIT.windowMs - FXM_SPOTIFY_LOGIN_RATE_LIMIT.max * 1000,
    )
    now += FXM_SPOTIFY_LOGIN_RATE_LIMIT.windowMs
    await expect(login.requestToken(PARAMS)).resolves.toMatchObject({ status: 200 })
  })

  it('stops waiting when the caller aborts', async () => {
    let release: (() => void) | undefined
    const { plugin, login } = setup({
      loggedIn: true,
      answer: () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, json: {} })
        }),
    })
    const before = new AbortController()
    before.abort(new DOMException('gone', 'AbortError'))
    await expect(login.requestToken(PARAMS, { signal: before.signal })).rejects.toBe(
      before.signal.reason,
    )
    expect(plugin.calls).toEqual([])

    const during = new AbortController()
    const pending = login.requestToken(PARAMS, { signal: during.signal })
    await vi.waitFor(() => expect(plugin.calls).toEqual(['requestToken']))
    during.abort(new DOMException('stop', 'AbortError'))
    await expect(pending).rejects.toBe(during.signal.reason)
    release?.()
  })

  it('refuses an answer without a status', async () => {
    const { login } = setup({
      loggedIn: true,
      answer: () => ({ json: {} }) as never,
    })
    expect(isFxmError(await failure(login.requestToken(PARAMS)), 'Parse')).toBe(true)
  })
})

describe('the login window', () => {
  it('opens, and keeps the login the user made there', async () => {
    const { plugin, login } = setup()
    await expect(login.loginState()).resolves.toEqual({ loggedIn: false, available: true })
    await expect(login.openLogin()).resolves.toEqual({ loggedIn: true, available: true })
    await expect(login.requestToken(PARAMS)).resolves.toMatchObject({ status: 200 })
    expect(plugin.calls).toEqual(['status', 'login', 'requestToken'])
  })

  it('keeps an earlier login when the user closes it, and none was made', async () => {
    const closed = setup({ window: () => false })
    await expect(closed.login.openLogin()).resolves.toEqual({ loggedIn: false, available: true })
    const kept = setup({ loggedIn: true, window: () => false })
    await expect(kept.login.openLogin()).resolves.toEqual({ loggedIn: true, available: true })
  })

  it('doesn’t open on a WebView without profiles', async () => {
    const { plugin, login } = setup({ available: false, window: () => true })
    await expect(login.openLogin()).resolves.toEqual({ loggedIn: false, available: false })
    expect(plugin.loggedIn).toBe(false)
  })

  it('says why it could not open, or could not keep the login', async () => {
    const busy = setup({
      window: () => {
        throw fxmSpotifyLoginError('BUSY')
      },
    })
    const error = await failure(busy.login.openLogin())
    expect(isFxmError(error, 'Unavailable')).toBe(true)
    expect((error as SpotifyLoginError).loginCode).toBe('BUSY')
    const storage = setup({
      window: () => {
        throw fxmSpotifyLoginError('STORAGE')
      },
    })
    expect(((await failure(storage.login.openLogin())) as SpotifyLoginError).loginCode).toBe(
      'STORAGE',
    )
  })

  it('logs out: the next token request needs a new login', async () => {
    const { plugin, login } = setup({ loggedIn: true })
    await login.logout()
    expect(plugin.loggedIn).toBe(false)
    expect(isFxmError(await failure(login.requestToken(PARAMS)), 'AuthRequired')).toBe(true)
  })

  it('is told apart from a source without one, such as FXM Connect’s bridge', () => {
    const { login } = setup()
    expect(spotifyLoginWindowOf(login)).toBe(login)
    const bridge = connectSessionSource({ spotifyToken: async () => ({ status: 200, json: {} }) })
    expect(spotifyLoginWindowOf(bridge)).toBeUndefined()
    expect(spotifyLoginWindowOf(undefined)).toBeUndefined()
    expect(spotifyLoginWindowOf(null)).toBeUndefined()
  })
})

describe('with the Spotify provider', () => {
  const SECRET = 'https://secrets.example.test/secret.json'
  const NOW = 1_800_000_000_000

  /** Spotify and the secret source, offline: what the provider asks besides the login. */
  function spotify() {
    const asked: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      asked.push(`${url.hostname}${url.pathname}`)
      if (url.href === SECRET) return Response.json({ '7': [70, 88, 77, 32, 102, 97, 107, 101] })
      if (url.pathname === '/api/server-time') {
        return Response.json({ serverTime: Math.floor(NOW / 1000) })
      }
      if (url.hostname === 'api-partner.spotify.com') {
        return Response.json({
          data: { me: { profile: { username: 'fixture-user', name: 'Fixture User' } } },
        })
      }
      if (url.pathname === '/api/token')
        throw new Error('The account token goes through the plugin')
      throw new TypeError(`offline: ${url.href}`)
    }) as typeof globalThis.fetch
    const ctx: ProviderContext = {
      fetch,
      platform: 'android',
      capabilities: { youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: true },
      mode: 'all',
    }
    return { asked, ctx }
  }

  it('gives the account its token on Android: logged out, then logged in through the window', async () => {
    const { plugin, login } = setup({ now: () => NOW })
    const provider = createSpotifyProvider({
      session: login,
      isAccountEnabled: () => true,
      secretSources: [{ url: SECRET }],
      now: () => NOW,
    })
    const { asked, ctx } = spotify()

    await expect(provider.status(ctx)).resolves.toEqual({ connected: false })
    expect(plugin.tokenRequests).toEqual([])

    await login.openLogin()
    provider.connect()
    await expect(provider.status(ctx)).resolves.toEqual({
      connected: true,
      displayName: 'Fixture User',
    })
    expect(plugin.tokenRequests).toHaveLength(1)
    expect(plugin.tokenRequests[0]).toMatchObject({
      reason: 'transport',
      productType: 'web-player',
      totpVer: '7',
    })
    // The token itself went through the plugin, never through the page's fetch.
    expect(asked).not.toContain('open.spotify.com/api/token')

    await login.logout()
    provider.disconnect()
    provider.connect()
    await expect(provider.status(ctx)).resolves.toEqual({ connected: false })
  })
})
