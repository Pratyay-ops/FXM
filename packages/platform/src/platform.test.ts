import { isFxmError } from '@fxm/core'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectWindow } from './connect'
import type { NativeHttp } from './native'
import { createPlatform, detectEnvironment, ENVIRONMENT_PLATFORMS } from './platform'
import { memoryStorage } from './storage'
import { installFakeConnect } from './testing/fake-connect'
import { createFakeSandbox } from './testing/fake-sandbox'

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'x' })

const pages: { happyDOM: { close(): Promise<void> } }[] = []
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.happyDOM.close()))
})

function page() {
  const window = new Window({ url: 'https://fxm-music.pages.dev/app/' })
  pages.push(window)
  return window as unknown as ConnectWindow
}

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
    expect(platform.context({ mode: 'all' }).fetch).toBe(platform.transport.fetch)
    expect(Object.keys(platform.context({ mode: 'all' })).sort()).toEqual([
      'capabilities',
      'fetch',
      'mode',
      'platform',
    ])
    await context.fetch(SEARCH, { method: 'POST', body: BODY })
    expect(platform.budget.snapshot().used).toBe(1)
    platform.dispose()
  })

  it('in Node: honours the Spotify login source and the user agent', async () => {
    const fetch = vi.fn(async () => Response.json({}))
    const platform = await createPlatform({
      environment: 'node',
      fetch: fetch as typeof globalThis.fetch,
      nativeSpotifyLogin: true,
      userAgent: 'Mozilla/5.0',
      userHosts: () => ['secrets.example.org'],
      storage: memoryStorage(),
    })
    expect(platform.capabilities.current.spotify).toBe('account')
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
    expect(platform.capabilities.current.youtube).toBe('simple')
    await platform.transport.fetch(SEARCH, { method: 'POST', body: BODY })
    expect(sandbox.requests).toHaveLength(1)
    // The self-test and the search both drew from the budget.
    expect(platform.budget.snapshot().used).toBe(2)
    killed = true
    expect((await platform.capabilities.refresh()).youtube).toBe('none')
    platform.dispose()
  })

  it('in a browser without sandbox documents: the Free tier', async () => {
    const platform = await createPlatform({ environment: 'browser', window: page() })
    expect(platform.lite).toBeUndefined()
    expect(platform.capabilities.current.youtube).toBe('none')
    platform.dispose()
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
        nativeSpotifyLogin: true,
        userAgent: 'Mozilla/5.0',
        userHosts: () => [],
        storage: memoryStorage(),
      })
      expect(platform.capabilities.current).toEqual({
        youtube: 'full',
        mediaBytes: true,
        spotify: 'account',
        fileSystem: true,
      })
      await platform.transport.fetch(SEARCH, { method: 'POST', body: BODY })
      expect(http).toHaveBeenCalledOnce()
      expect(http.mock.calls[0]?.[1].headers.origin).toBe('')
    },
  )
})
