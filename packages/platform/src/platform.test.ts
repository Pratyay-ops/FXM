import { FxmError, isFxmError } from '@fxm/core'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FXM_SPOTIFY_LOGIN_PLUGIN, spotifyLoginWindowOf } from './android-spotify-login'
import type { SelfTestResult } from './lite'
import type { NativeHttp } from './native'
import {
  createPlatform,
  detectEnvironment,
  ENVIRONMENT_PLATFORMS,
  type PlatformWindow,
} from './platform'
import type { SessionTokenSource } from './spotify-session'
import { memoryStorage } from './storage'
import { installFakeConnect } from './testing/fake-connect'
import { createFakeSandbox } from './testing/fake-sandbox'
import { createFakeFxmSpotifyLogin } from './testing/fake-spotify-login'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'x' })

const pages: { happyDOM: { close(): Promise<void> } }[] = []
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.happyDOM.close()))
})

/** Messages travel on happy-dom's real timers, which a busy machine can slow down a lot. */
const PATIENCE = { timeout: 10_000 }

function page() {
  const window = new Window({ url: 'https://fxmusic.pages.dev/app/' })
  pages.push(window)
  return window as unknown as PlatformWindow
}

const session = (): SessionTokenSource => ({
  requestToken: async () => ({ status: 200, json: { accessToken: 'token' } }),
})

describe('detectEnvironment', () => {
  it.each([
    ['tauri', { __TAURI_INTERNALS__: {}, window: {}, document: {} }],
    ['capacitor', { Capacitor: { isNativePlatform: () => true }, window: {}, document: {} }],
    ['browser', { Capacitor: { isNativePlatform: () => false }, window: {}, document: {} }],
    ['browser', { window: {}, document: {}, process: { versions: { node: '22' } } }],
    ['node', { process: { versions: { node: '22.20.0' } } }],
  ])('recognizes %s', (environment, globals) => {
    expect(detectEnvironment(globals)).toBe(environment)
  })

  it('refuses anything else, such as a web worker', () => {
    let error: unknown
    try {
      detectEnvironment({ self: {} })
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })

  it('knows this test runs in Node', () => {
    expect(detectEnvironment()).toBe('node')
  })

  it('maps each environment to a provider platform', () => {
    expect(ENVIRONMENT_PLATFORMS).toEqual({
      browser: 'web',
      tauri: 'desktop',
      capacitor: 'android',
      node: 'desktop',
    })
  })
})

describe('createPlatform', () => {
  it('in Node: full access, and provider contexts with the right fetch', async () => {
    const fetch = vi.fn(async () => Response.json({}))
    const platform = await createPlatform({ fetch: fetch as typeof globalThis.fetch })
    expect(platform.environment).toBe('node')
    expect(platform.platform).toBe('desktop')
    expect(platform.capabilities.current).toEqual({
      youtube: 'full',
      mediaBytes: true,
      spotify: 'anonymous',
      fileSystem: true,
    })
    expect(platform.connect).toBeUndefined()
    expect(platform.lite).toBeUndefined()
    const controller = new AbortController()
    const context = platform.context({
      mode: 'music',
      priority: 'current-track',
      locale: 'en-IN',
      region: 'IN',
      signal: controller.signal,
    })
    expect(context).toMatchObject({
      platform: 'desktop',
      mode: 'music',
      locale: 'en-IN',
      region: 'IN',
      signal: controller.signal,
    })
    expect(context.fetch).toBe(platform.transport.withPriority('current-track'))
    const plain = platform.context({ mode: 'all', priority: 'interactive' })
    expect(plain.fetch).toBe(platform.transport.fetch)
    expect(Object.keys(plain).sort()).toEqual(['capabilities', 'fetch', 'mode', 'platform'])
    await context.fetch(SEARCH, { method: 'POST', body: BODY })
    expect(platform.budget.snapshot().used).toBe(1)
    platform.dispose()
  })

  it('in Node: honours the Spotify login source and the user agent', async () => {
    const fetch = vi.fn(async () => Response.json({}))
    const spotifySession = session()
    const platform = await createPlatform({
      environment: 'node',
      fetch: fetch as typeof globalThis.fetch,
      spotifySession,
      userAgent: 'Mozilla/5.0',
      userHosts: () => ['secrets.example.org'],
      storage: memoryStorage(),
    })
    expect(platform.capabilities.current.spotify).toBe('account')
    expect(platform.spotifySession).toBe(spotifySession)
    await platform.transport.fetch('https://secrets.example.org/s.json')
    await platform.transport.fetch('https://open.spotify.com/api/server-time')
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(calls[1]?.[1].headers).toEqual({ 'user-agent': 'Mozilla/5.0' })
  })

  it('in a browser with FXM Connect: full access through the page', async () => {
    const window = page()
    installFakeConnect(window)
    const fetch = vi.fn(async () => Response.json({}))
    const platform = await createPlatform({
      environment: 'browser',
      window,
      fetch: fetch as typeof globalThis.fetch,
      sandbox: createFakeSandbox(),
    })
    expect(platform.platform).toBe('web')
    expect(platform.connect?.status?.state).toBe('present')
    expect(platform.capabilities.current).toMatchObject({ youtube: 'full', spotify: 'anonymous' })
    expect(platform.lite?.ready).toBe(false)
    await platform.transport.fetch(SEARCH, { method: 'POST', body: BODY })
    expect(fetch).toHaveBeenCalledOnce()
    platform.dispose()
  })

  it('in a browser without FXM Connect: the Lite tier, or nothing once it is switched off', async () => {
    const sandbox = createFakeSandbox()
    let killed = false
    const platform = await createPlatform({
      environment: 'browser',
      window: page(),
      storage: memoryStorage(),
      sandbox,
      killSwitches: () => ({ lite: killed }),
      userHosts: () => [],
    })
    expect(platform.connect?.status?.state).toBe('absent')
    // The self-test runs in the background; the capabilities follow when it passes.
    await vi.waitFor(() => expect(platform.capabilities.current.youtube).toBe('simple'), PATIENCE)
    await platform.transport.fetch(SEARCH, { method: 'POST', body: BODY })
    expect(sandbox.requests).toHaveLength(1)
    // The self-test and the search both drew from the budget.
    expect(platform.budget.snapshot().used).toBe(2)
    killed = true
    expect((await platform.capabilities.refresh()).youtube).toBe('none')
    platform.dispose()
  })

  it('in a browser, resolves without waiting for a Lite self-test that never ends', async () => {
    const pending: { signal: AbortSignal | undefined }[] = []
    const sandbox = createFakeSandbox({
      selfTest: (options) =>
        new Promise<SelfTestResult>(() => {
          pending.push({ signal: options?.signal })
        }),
    })
    const platform = await createPlatform({
      environment: 'browser',
      window: page(),
      storage: memoryStorage(),
      sandbox,
    })
    expect(platform.capabilities.current.youtube).toBe('none')
    expect(platform.lite?.state).toBe('checking')
    await vi.waitFor(() => expect(pending).toHaveLength(1), PATIENCE)
    platform.dispose()
    expect(pending[0]?.signal?.aborted).toBe(true)
    expect(platform.lite?.ready).toBe(false)
  })

  it('in a browser without sandbox documents: the Free tier', async () => {
    const platform = await createPlatform({ environment: 'browser', window: page() })
    expect(platform.lite).toBeUndefined()
    expect(platform.capabilities.current.youtube).toBe('none')
    platform.dispose()
  })

  it('in a browser: the Spotify login goes through FXM Connect’s bridge', async () => {
    const window = page()
    const extension = installFakeConnect(window, {
      features: ['spotify', 'spotify-login'],
      bridge: (request) => ({ status: 200, json: { echoed: request.params } }),
    })
    const platform = await createPlatform({
      environment: 'browser',
      window,
      storage: memoryStorage(),
    })
    expect(platform.capabilities.current.spotify).toBe('account')
    const controller = new AbortController()
    await expect(
      platform.spotifySession?.requestToken(
        { reason: 'transport', productType: 'web-player' },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({
      status: 200,
      json: { echoed: { reason: 'transport', productType: 'web-player' } },
    })
    await platform.spotifySession?.requestToken({ reason: 'init' })
    expect(extension.bridgeRequests.map((request) => request.type)).toEqual([
      'fxm-connect:spotify-token',
      'fxm-connect:spotify-token',
    ])
    platform.dispose()
  })

  it('passes the bot checks providers notice on to the budget, and nothing else', async () => {
    const platform = await createPlatform({
      environment: 'node',
      fetch: vi.fn(async () => Response.json({})) as typeof globalThis.fetch,
    })
    expect(platform.report(new FxmError('RateLimited', 'Spotify said slow down'))).toBe(false)
    expect(platform.report(new Error('boom'))).toBe(false)
    expect(platform.budget.snapshot().bulkPausedUntil).toBeUndefined()
    expect(platform.report(new FxmError('BotCheck', 'unusual traffic'))).toBe(true)
    expect(platform.budget.snapshot()).toMatchObject({
      pauseLevel: 1,
      lastBotCheck: { cause: 'login-required' },
    })
  })

  it('in a browser, needs a window', async () => {
    let error: unknown
    try {
      await createPlatform({ environment: 'browser' })
    } catch (caught) {
      error = caught
    }
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })

  it.each([
    ['tauri', 'desktop', '7.2'],
    ['capacitor', 'android', '6.2'],
  ] as const)(
    'in %s before its native HTTP: the stub, which reaches no YouTube',
    async (environment, platformName, stage) => {
      const webFetch = vi.fn(async () => Response.json({}))
      const platform = await createPlatform({
        environment,
        fetch: webFetch as typeof fetch,
        storage: memoryStorage(),
      })
      expect(platform.platform).toBe(platformName)
      expect(platform.capabilities.current).toEqual({
        youtube: 'none',
        mediaBytes: false,
        spotify: 'unreachable',
        fileSystem: true,
      })
      await platform.transport.fetch('https://lrclib.net/api/get')
      expect(webFetch).toHaveBeenCalledOnce()
      await expect(
        platform.transport.fetch(SEARCH, { method: 'POST', body: BODY }),
      ).rejects.toThrow(stage)
    },
  )

  it.each(['tauri', 'capacitor'] as const)(
    'in %s with its native HTTP: full access',
    async (environment) => {
      const http = vi.fn<NativeHttp>(async () => Response.json({}))
      const platform = await createPlatform({
        environment,
        nativeHttp: http,
        spotifySession: session(),
        userAgent: 'Mozilla/5.0',
        userHosts: () => [],
        storage: memoryStorage(),
        reportLoginRequired: false,
      })
      expect(platform.capabilities.current).toEqual({
        youtube: 'full',
        mediaBytes: true,
        spotify: 'account',
        fileSystem: true,
      })
      await platform.transport.fetch(SEARCH, { method: 'POST', body: BODY })
      expect(http).toHaveBeenCalledOnce()
      expect(http.mock.calls[0]?.[1].origin).toBeNull()
      expect(platform.spotifySession).toBeDefined()
    },
  )

  describe('on Android, the Spotify login window (stage 6.5)', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    const native = { nativeHttp: vi.fn<NativeHttp>(async () => Response.json({})) }

    it('is the login source when the app has its plugin, so Spotify is account', async () => {
      const plugin = createFakeFxmSpotifyLogin({ loggedIn: true })
      vi.stubGlobal('Capacitor', {
        isNativePlatform: () => true,
        Plugins: { [FXM_SPOTIFY_LOGIN_PLUGIN]: plugin },
      })
      const platform = await createPlatform({
        environment: 'capacitor',
        ...native,
        storage: memoryStorage(),
      })
      expect(platform.capabilities.current.spotify).toBe('account')
      expect(spotifyLoginWindowOf(platform.spotifySession)).toBeDefined()
      await expect(
        platform.spotifySession?.requestToken({ reason: 'transport', totp: '123456' }),
      ).resolves.toMatchObject({ status: 200 })
      expect(plugin.tokenRequests).toEqual([{ reason: 'transport', totp: '123456' }])
    })

    it('gives way to a source the app passes, and is none without the plugin', async () => {
      vi.stubGlobal('Capacitor', {
        isNativePlatform: () => true,
        Plugins: { [FXM_SPOTIFY_LOGIN_PLUGIN]: createFakeFxmSpotifyLogin() },
      })
      const given = session()
      const passed = await createPlatform({
        environment: 'capacitor',
        ...native,
        spotifySession: given,
        storage: memoryStorage(),
      })
      expect(passed.spotifySession).toBe(given)

      vi.stubGlobal('Capacitor', { isNativePlatform: () => true, Plugins: {} })
      const without = await createPlatform({
        environment: 'capacitor',
        ...native,
        storage: memoryStorage(),
      })
      expect(without.spotifySession).toBeUndefined()
      expect(without.capabilities.current.spotify).toBe('anonymous')
      // The desktop app never picks up the Android plugin.
      vi.stubGlobal('Capacitor', {
        isNativePlatform: () => true,
        Plugins: { [FXM_SPOTIFY_LOGIN_PLUGIN]: createFakeFxmSpotifyLogin() },
      })
      const desktop = await createPlatform({
        environment: 'tauri',
        ...native,
        storage: memoryStorage(),
      })
      expect(desktop.spotifySession).toBeUndefined()
    })
  })
})
