import { type FxmError, isFxmError, type ProviderContext } from '@fxm/core'
import { createPlatform } from '@fxm/platform'
import { createSpotifyProvider } from '@fxm/sources/spotify'
import { describe, expect, it, vi } from 'vitest'
import { DesktopCommandError } from './load-once'
import type { ShellBindings } from './shell'
import {
  createDesktopSpotifyLogin,
  SPOTIFY_COMMANDS,
  SPOTIFY_LOGIN_EVENT,
  SPOTIFY_PLUGIN,
  spotifyLoginError,
} from './spotify-login'

const HOUR = 3_600_000
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

/** An error as a Rust command answers it. */
const refusal = (code: string, message = code) => ({ code, message })

/** The forms Rust takes the token parameters in (`TokenParams::pairs`), FXM Connect's. */
const FORMS: Record<string, RegExp> = {
  reason: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/,
  productType: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/,
  totp: /^[0-9]{6,10}$/,
  totpServer: /^[0-9]{6,10}$/,
  totpVer: /^[0-9]{1,4}$/,
}

const PARAMS = {
  reason: 'transport',
  productType: 'web-player',
  totp: '123456',
  totpServer: '654321',
  totpVer: '61',
}

/**
 * The `fxm-spotify` plugin, faked: the token command checks the parameters as Rust does and
 * answers the token's fields only; the rest answer from `state`.
 */
function fakePlugin(now = () => Date.now()) {
  const state = { loggedIn: false, loginAnswer: true }
  const failures = new Map<string, unknown>()
  const handlers = new Map<string, (event: { payload: unknown }) => void>()
  const calls: { command: string; args: Record<string, unknown> }[] = []
  let releaseListen: (() => void) | undefined
  const listenGate = { hold: false }
  let release: (() => void) | undefined
  const tokenGate = { hold: false }
  const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args })
    const prefix = `plugin:${SPOTIFY_PLUGIN}|`
    if (!command.startsWith(prefix)) throw new Error(`${command} not allowed`)
    const name = command.slice(prefix.length)
    const failure = failures.get(name)
    if (failure !== undefined) {
      failures.delete(name)
      throw failure
    }
    switch (name) {
      case SPOTIFY_COMMANDS.status:
        return { loggedIn: state.loggedIn }
      case SPOTIFY_COMMANDS.login:
        state.loggedIn = state.loginAnswer
        return { loggedIn: state.loggedIn }
      case SPOTIFY_COMMANDS.logout:
        state.loggedIn = false
        return null
      case SPOTIFY_COMMANDS.token: {
        if (tokenGate.hold) await new Promise<void>((resolve) => (release = resolve))
        const params = args.params as Record<string, string>
        for (const [key, value] of Object.entries(params)) {
          const form = FORMS[key]
          if (form === undefined || !form.test(value)) throw refusal('bad-request')
        }
        if (!state.loggedIn) throw refusal('logged-out', 'You are not logged in to Spotify in FXM')
        return {
          status: 200,
          json: {
            accessToken: 'BQ-desktop-account',
            accessTokenExpirationTimestampMs: now() + HOUR,
            isAnonymous: false,
          },
        }
      }
      default:
        throw new Error(`no command ${name}`)
    }
  })
  const bindings: ShellBindings = {
    invoke: invoke as unknown as ShellBindings['invoke'],
    listen: vi.fn(async (event, handler) => {
      if (listenGate.hold) await new Promise<void>((resolve) => (releaseListen = resolve))
      handlers.set(event, handler as (event: { payload: unknown }) => void)
      return () => {
        handlers.delete(event)
      }
    }) as ShellBindings['listen'],
  }
  return {
    bindings,
    state,
    calls,
    invoke,
    listenGate,
    tokenGate,
    releaseListen: () => releaseListen?.(),
    releaseToken: () => release?.(),
    failNext(command: string, error: unknown) {
      failures.set(command, error)
    },
    emit(payload: unknown) {
      handlers.get(SPOTIFY_LOGIN_EVENT)?.({ payload })
    },
    hasListener: () => handlers.has(SPOTIFY_LOGIN_EVENT),
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the desktop Spotify session', () => {
  it('asks Rust for a token with the provider’s parameters and answers its fields', async () => {
    const plugin = fakePlugin()
    plugin.state.loggedIn = true
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    const answer = await login.session.requestToken({ ...PARAMS, extra: 'x' } as typeof PARAMS)
    expect(answer).toEqual({
      status: 200,
      json: {
        accessToken: 'BQ-desktop-account',
        accessTokenExpirationTimestampMs: expect.any(Number),
        isAnonymous: false,
      },
    })
    // Only the parameters Rust takes, and the browser agent.
    expect(plugin.calls).toEqual([
      { command: `plugin:${SPOTIFY_PLUGIN}|token`, args: { params: PARAMS, userAgent: SAFARI } },
    ])
  })

  it('says why it got no token, as the provider reads it', async () => {
    const plugin = fakePlugin()
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    const loggedOut = await login.session.requestToken(PARAMS).catch((e: unknown) => e)
    expect(isFxmError(loggedOut, 'AuthRequired')).toBe(true)
    const cases: [unknown, string][] = [
      [refusal('rate-limited'), 'RateLimited'],
      [refusal('keychain'), 'Unsupported'],
      [refusal('network'), 'Network'],
      [refusal('too-large'), 'Parse'],
      [refusal('bad-request'), 'Parse'],
      ['plugin:fxm-spotify|token not allowed by ACL', 'Unsupported'],
    ]
    for (const [error, code] of cases) {
      plugin.failNext(SPOTIFY_COMMANDS.token, error)
      const thrown = await login.session.requestToken(PARAMS).catch((e: unknown) => e)
      expect(isFxmError(thrown), String(error)).toBe(true)
      expect((thrown as FxmError).code, String(error)).toBe(code)
      expect((thrown as FxmError).cause).toBe(error)
    }
    expect(spotifyLoginError(refusal('logged-out', 'No login')).message).toBe('No login')
  })

  it('refuses an answer without a status', async () => {
    const plugin = fakePlugin()
    plugin.invoke.mockResolvedValueOnce({ json: {} } as never)
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    const error = await login.session.requestToken(PARAMS).catch((e: unknown) => e)
    expect(isFxmError(error, 'Parse')).toBe(true)
  })

  it('stops waiting when the provider cancels', async () => {
    const plugin = fakePlugin()
    plugin.state.loggedIn = true
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    const before = new AbortController()
    before.abort(new DOMException('gone', 'AbortError'))
    await expect(
      login.session.requestToken(PARAMS, { signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(plugin.calls).toEqual([])
    plugin.tokenGate.hold = true
    const during = new AbortController()
    const pending = login.session.requestToken(PARAMS, { signal: during.signal })
    await flush()
    during.abort(new DOMException('cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ message: 'cancelled' })
    plugin.releaseToken()
  })

  it('sends the webview’s agent completed to a browser’s when none is given', async () => {
    const plugin = fakePlugin()
    plugin.state.loggedIn = true
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings })
    await login.session.requestToken(PARAMS)
    const sent = plugin.calls[0]?.args.userAgent
    expect(typeof sent).toBe('string')
    expect(sent as string).toMatch(/^Mozilla\/5\.0 \(/)
  })
})

describe('the desktop Spotify login', () => {
  it('logs in through the login window, says so, and logs out', async () => {
    const plugin = fakePlugin()
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    expect(await login.status()).toBe(false)
    expect(await login.login()).toBe(true)
    expect(plugin.calls.at(-1)).toEqual({
      command: `plugin:${SPOTIFY_PLUGIN}|login`,
      args: { userAgent: SAFARI },
    })
    expect(await login.status()).toBe(true)
    await login.logout()
    expect(await login.status()).toBe(false)
    plugin.state.loginAnswer = false
    expect(await login.login()).toBe(false)
  })

  it('says why the window didn’t open, or the store failed', async () => {
    const plugin = fakePlugin()
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    plugin.failNext(SPOTIFY_COMMANDS.login, refusal('not-focused', 'Not in front'))
    const error = await login.login().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopCommandError)
    expect(error).toMatchObject({ code: 'not-focused', message: 'Not in front' })
    plugin.failNext(SPOTIFY_COMMANDS.status, refusal('keychain', 'No Secret Service'))
    await expect(login.status()).rejects.toMatchObject({ code: 'keychain' })
    plugin.failNext(SPOTIFY_COMMANDS.logout, 'not allowed')
    await expect(login.logout()).rejects.toMatchObject({ code: 'unknown' })
  })

  it('passes on changes of the login, and nothing malformed', async () => {
    const plugin = fakePlugin()
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    const changes: boolean[] = []
    const stop = login.onChange((loggedIn) => changes.push(loggedIn))
    await flush()
    plugin.emit({ loggedIn: true })
    plugin.emit({ loggedIn: 'yes' })
    plugin.emit(null)
    plugin.emit({ loggedIn: false })
    expect(changes).toEqual([true, false])
    stop()
    expect(plugin.hasListener()).toBe(false)
    // Stopped before Tauri's listen answered: it stops as soon as it does.
    plugin.listenGate.hold = true
    const early = login.onChange(() => changes.push(true))
    early()
    plugin.releaseListen()
    await flush()
    expect(plugin.hasListener()).toBe(false)
  })
})

describe('the desktop Spotify login in FXM', () => {
  it('makes Spotify `account` on the desktop platform, and is its session', async () => {
    const plugin = fakePlugin()
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    const platform = await createPlatform({
      environment: 'tauri',
      nativeHttp: async () => new Response('{}'),
      spotifySession: login.session,
    })
    expect(platform.capabilities.current.spotify).toBe('account')
    expect(platform.spotifySession).toBe(login.session)
    platform.dispose()
  })

  it('serves the Spotify provider’s account token, whose parameters Rust accepts', async () => {
    const now = () => Date.UTC(2026, 9, 26, 12)
    const plugin = fakePlugin(now)
    plugin.state.loggedIn = true
    const login = createDesktopSpotifyLogin({ bindings: plugin.bindings, userAgent: SAFARI })
    const secretUrl = 'https://secrets.example.test/secret.json'
    const tokens: string[] = []
    // Spotify's server time and the profile, as pathfinder answers them.
    const spotifyFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url)
      if (url.pathname === '/api/server-time') {
        return Response.json({ serverTime: Math.floor(now() / 1000) })
      }
      if (url.pathname.includes('pathfinder')) {
        const headers = new Headers(init?.headers)
        tokens.push(headers.get('authorization') ?? '')
        const body = JSON.parse(String(init?.body)) as { operationName?: string }
        if (body.operationName === 'profileAttributes') {
          return Response.json({ data: { me: { profile: { name: 'Fixture User' } } } })
        }
      }
      return new Response('not found', { status: 404 })
    }
    const provider = createSpotifyProvider({
      session: login.session,
      isAccountEnabled: () => true,
      secretSources: [{ url: secretUrl }],
      secretFetch: async () => Response.json({ 7: [70, 88, 77, 32, 102, 97, 107, 101] }),
      now,
    })
    const ctx: ProviderContext = {
      fetch: spotifyFetch,
      platform: 'desktop',
      capabilities: { youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: true },
      mode: 'all',
    }
    expect(await provider.status(ctx)).toEqual({ connected: true, displayName: 'Fixture User' })
    expect(tokens).toEqual(['Bearer BQ-desktop-account'])
    const sent = plugin.calls.find((call) => call.command.endsWith('|token'))?.args.params
    expect(sent).toMatchObject({ reason: 'transport', productType: 'web-player', totpVer: '7' })
    // Logged out, the provider sees the account as not connected.
    await login.logout()
    const fresh = createSpotifyProvider({
      session: login.session,
      isAccountEnabled: () => true,
      secretSources: [{ url: secretUrl }],
      secretFetch: async () => Response.json({ 7: [70, 88, 77, 32, 102, 97, 107, 101] }),
      now,
    })
    expect(await fresh.status(ctx)).toEqual({ connected: false })
  })
})
