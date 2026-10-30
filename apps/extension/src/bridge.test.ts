import { describe, expect, it, vi } from 'vitest'

const readYouTubeMusicAccountMock = vi.hoisted(() => vi.fn())
vi.mock('@fxm/sources/youtube/account', () => ({
  readYouTubeMusicAccount: readYouTubeMusicAccountMock,
}))

import {
  createBridge,
  type FetchLike,
  isPrivateTab,
  RATE_LIMIT,
  RATE_LIMIT_KEY,
  type SenderContext,
  SPOTIFY_SERVER_TIME_URL,
  spotifyTokenUrl,
  trustedSenderOrigin,
} from './bridge.ts'
import { fxmOrigins } from './config.ts'
import { MESSAGE } from './messages.ts'
import type { SettingsStore } from './settings.ts'
import type { MessageSender, StorageArea, WebExtApi } from './webext.ts'

const FXM = 'https://fxmusic.pages.dev'
const PAGE: SenderContext = { origin: FXM, privateTab: false }
const PRIVATE_PAGE: SenderContext = { origin: FXM, privateTab: true }
const RUNTIME_ID = 'fxm-connect-id'
const TOKEN_JSON = { accessToken: 'token', accessTokenExpirationTimestampMs: 1, isAnonymous: false }
const PARAMS = { reason: 'init', productType: 'web-player', totp: '123456', totpVer: '5' }

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const area: StorageArea = {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(names.filter((name) => name in data).map((n) => [n, data[n]]))
    },
    async set(items) {
      Object.assign(data, items)
    },
  }
  return { data, area }
}

function jsonFetch(body: unknown = TOKEN_JSON, status = 200) {
  return vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status }))
}

interface SetupOptions {
  login?: boolean
  /** Firefox's consent for the login (consent.ts); left out, as in Chromium. */
  consent?: boolean
  settings?: Pick<SettingsStore, 'read'>
  origins?: readonly string[]
  fetch?: FetchLike
  session?: StorageArea
  dnr?: WebExtApi['declarativeNetRequest']
  timeoutMs?: number
  maxResponseBytes?: number
  youtubeMusicLogin?: boolean
  cookies?: WebExtApi['cookies']
  permissions?: WebExtApi['permissions']
}

function setup(options: SetupOptions = {}) {
  const clock = { now: 1_000_000 }
  const fetch = options.fetch ?? jsonFetch()
  const settings = options.settings ?? {
    read: vi.fn(async () => ({
      spotifyLogin: options.login === true,
      spotifyLoginLocalhost: false,
      youtubeMusicLogin: options.youtubeMusicLogin === true,
    })),
  }
  const bridge = createBridge({
    runtimeId: RUNTIME_ID,
    origins: options.origins ?? fxmOrigins(false),
    settings,
    ...(options.consent !== undefined
      ? { consent: { granted: async () => options.consent === true } }
      : {}),
    session: options.session,
    dnr: options.dnr,
    fetch,
    cookies: options.cookies ?? { getAll: vi.fn(async () => []) },
    permissions: options.permissions ?? {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => true),
    },
    now: () => clock.now,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
  })
  return { bridge, fetch, clock, settings }
}

const token = (id: string | number = 'a') => ({ type: MESSAGE.spotifyToken, id, params: PARAMS })
const serverTime = (id: string | number = 'b') => ({ type: MESSAGE.spotifyServerTime, id })
const tabSender: MessageSender = { id: RUNTIME_ID, origin: FXM, tab: { id: 4 }, frameId: 0 }

describe('trustedSenderOrigin', () => {
  it('accepts FXM Connect content scripts in the top frame of an FXM tab', () => {
    expect(trustedSenderOrigin(tabSender, RUNTIME_ID, [FXM])).toBe(FXM)
  })

  it('falls back to the sender URL when the browser gives no origin (Firefox)', () => {
    const sender = { id: RUNTIME_ID, url: `${FXM}/app/?q=1`, tab: { id: 4 }, frameId: 0 }
    expect(trustedSenderOrigin(sender, RUNTIME_ID, [FXM])).toBe(FXM)
  })

  it.each<[string, MessageSender]>([
    ['another extension', { ...tabSender, id: 'other-extension' }],
    ['an extension page', { id: RUNTIME_ID, origin: `chrome-extension://${RUNTIME_ID}` }],
    ['no tab', { id: RUNTIME_ID, origin: FXM, frameId: 0 }],
    ['an iframe', { ...tabSender, frameId: 3 }],
    ['another site', { ...tabSender, origin: 'https://evil.example' }],
    ['a look-alike host', { ...tabSender, origin: 'https://fxmusic.pages.dev.evil.example' }],
    ['an unparsable URL', { id: RUNTIME_ID, url: 'not a url', tab: { id: 4 }, frameId: 0 }],
  ])('rejects %s', (_label, sender) => {
    expect(trustedSenderOrigin(sender, RUNTIME_ID, [FXM])).toBeNull()
  })
})

describe('isPrivateTab', () => {
  it('flags incognito and private windows and Firefox containers', () => {
    expect(isPrivateTab({ id: 1, incognito: true })).toBe(true)
    expect(isPrivateTab({ id: 1, incognito: true, cookieStoreId: 'firefox-private' })).toBe(true)
    expect(isPrivateTab({ id: 1, incognito: false, cookieStoreId: 'firefox-container-2' })).toBe(
      true,
    )
  })

  it('accepts tabs of normal windows', () => {
    expect(isPrivateTab({ id: 1, incognito: false })).toBe(false)
    expect(isPrivateTab({ id: 1, incognito: false, cookieStoreId: 'firefox-default' })).toBe(false)
    expect(isPrivateTab({ id: 1 })).toBe(false)
    expect(isPrivateTab(undefined)).toBe(false)
  })
})

describe('spotifyTokenUrl', () => {
  it('builds the exact token endpoint with the parameters in a fixed order', () => {
    expect(spotifyTokenUrl({ totpVer: '5', reason: 'init', totp: '123456' })).toBe(
      'https://open.spotify.com/api/token?reason=init&totp=123456&totpVer=5',
    )
    expect(spotifyTokenUrl({})).toBe('https://open.spotify.com/api/token')
  })
})

describe('Spotify token relay', () => {
  it('refuses while "Use my Spotify login" is off, without any request', async () => {
    const { bridge, fetch } = setup()
    expect(await bridge.handle(token(), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'a',
      code: 'login-disabled',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches the token with the browser session and returns only status and JSON', async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify(TOKEN_JSON), {
          status: 200,
          headers: { 'set-cookie': 'sp_t=secret', 'content-type': 'application/json' },
        }),
    )
    const { bridge } = setup({ login: true, fetch })
    const reply = await bridge.handle(token('t1'), PAGE)
    expect(reply).toEqual({ type: MESSAGE.response, id: 't1', status: 200, json: TOKEN_JSON })
    expect(Object.keys(reply ?? {})).toEqual(['type', 'id', 'status', 'json'])
    expect(JSON.stringify(reply)).not.toContain('secret')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(
      'https://open.spotify.com/api/token?reason=init&productType=web-player&totp=123456&totpVer=5',
    )
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('relays error statuses and non-JSON bodies as they are', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('<html>denied</html>', { status: 403 }))
    const { bridge } = setup({ login: true, fetch })
    expect(await bridge.handle(token(), PAGE)).toEqual({
      type: MESSAGE.response,
      id: 'a',
      status: 403,
      json: null,
    })
  })

  it('refuses private windows and containers, whose cookies differ from the login it would use', async () => {
    const { bridge, fetch } = setup({ login: true })
    expect(await bridge.handle(token('p'), PRIVATE_PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'p',
      code: 'private-tab',
    })
    expect(await bridge.handle({ type: MESSAGE.loginStatus }, PRIVATE_PAGE)).toEqual({
      type: MESSAGE.loginStatus,
      enabled: false,
    })
    expect(fetch).not.toHaveBeenCalled()
    // The server time needs no cookies, so private tabs still get it.
    expect(await bridge.handle(serverTime('t'), PRIVATE_PAGE)).toMatchObject({
      type: MESSAGE.response,
    })
  })

  it('reports login-disabled first when the toggle is off, even in a private tab', async () => {
    const { bridge } = setup()
    expect(await bridge.handle(token(), PRIVATE_PAGE)).toMatchObject({ code: 'login-disabled' })
  })

  it('rejects parameters outside the allow-list without any request', async () => {
    const { bridge, fetch } = setup({ login: true })
    const message = { type: MESSAGE.spotifyToken, id: 9, params: { reason: 'init', url: 'x' } }
    expect(await bridge.handle(message, PAGE)).toEqual({
      type: MESSAGE.error,
      id: 9,
      code: 'bad-request',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("Firefox's consent for the login", () => {
  it('serves tokens only while Firefox reports the consent as granted', async () => {
    const withdrawn = setup({ login: true, consent: false })
    expect(await withdrawn.bridge.handle(token('w'), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'w',
      code: 'login-disabled',
    })
    expect(await withdrawn.bridge.handle({ type: MESSAGE.loginStatus }, PAGE)).toEqual({
      type: MESSAGE.loginStatus,
      enabled: false,
    })
    expect(withdrawn.fetch).not.toHaveBeenCalled()
    // The server time needs no login, so it needs no consent either.
    expect(await withdrawn.bridge.handle(serverTime('t'), PAGE)).toMatchObject({
      type: MESSAGE.response,
    })

    const granted = setup({ login: true, consent: true })
    expect(await granted.bridge.handle(token('g'), PAGE)).toMatchObject({
      type: MESSAGE.response,
      id: 'g',
    })
  })

  it('never turns the login on by itself: the setting still decides', async () => {
    const { bridge, fetch } = setup({ login: false, consent: true })
    expect(await bridge.handle(token(), PAGE)).toMatchObject({ code: 'login-disabled' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("Spotify login status (the pong's spotify-login feature)", () => {
  it('reports whether token requests would be served', async () => {
    const status = { type: MESSAGE.loginStatus }
    expect(await setup({ login: true }).bridge.handle(status, PAGE)).toEqual({
      type: MESSAGE.loginStatus,
      enabled: true,
    })
    expect(await setup().bridge.handle(status, PAGE)).toEqual({
      type: MESSAGE.loginStatus,
      enabled: false,
    })
  })

  it('reports the login off when the settings cannot be read', async () => {
    const settings = { read: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable')) }
    expect(await setup({ settings }).bridge.handle({ type: MESSAGE.loginStatus }, PAGE)).toEqual({
      type: MESSAGE.loginStatus,
      enabled: false,
    })
  })

  it('reads the setting afresh for every request, so turning it off applies at once', async () => {
    const values = [true, false]
    const settings = {
      read: vi.fn(async () => ({
        spotifyLogin: values.shift() === true,
        spotifyLoginLocalhost: false,
        youtubeMusicLogin: false,
      })),
    }
    const { bridge, fetch } = setup({ settings })
    expect(await bridge.handle(token('first'), PAGE)).toMatchObject({ type: MESSAGE.response })
    expect(await bridge.handle(token('second'), PAGE)).toMatchObject({ code: 'login-disabled' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('localhost pages (dev build)', () => {
  const LOCALHOST: SenderContext = { origin: 'http://localhost:5173', privateTab: false }
  const devSetup = (spotifyLogin: boolean, spotifyLoginLocalhost: boolean) =>
    setup({
      origins: fxmOrigins(true),
      settings: {
        read: vi.fn(async () => ({
          spotifyLogin,
          spotifyLoginLocalhost,
          youtubeMusicLogin: false,
        })),
      },
    })

  it('need their own opt-in before they get the Spotify login', async () => {
    const { bridge, fetch } = devSetup(true, false)
    expect(await bridge.handle(token('local'), LOCALHOST)).toEqual({
      type: MESSAGE.error,
      id: 'local',
      code: 'login-disabled',
    })
    expect(await bridge.handle({ type: MESSAGE.loginStatus }, LOCALHOST)).toEqual({
      type: MESSAGE.loginStatus,
      enabled: false,
    })
    expect(fetch).not.toHaveBeenCalled()
    // The production origin is not affected.
    expect(await bridge.handle(token('prod'), PAGE)).toMatchObject({ type: MESSAGE.response })
  })

  it('get it with both opt-ins, and never with the localhost one alone', async () => {
    expect(await devSetup(true, true).bridge.handle(token(), LOCALHOST)).toMatchObject({
      type: MESSAGE.response,
    })
    expect(await devSetup(false, true).bridge.handle(token(), LOCALHOST)).toMatchObject({
      code: 'login-disabled',
    })
  })
})

describe('YouTube Music account bridge', () => {
  const request = (id: string | number = 'ytm-1') => ({
    type: MESSAGE.youtubeMusicLibrary,
    id,
  })

  it('is disabled by default and does not inspect browser cookies', async () => {
    const getAll = vi.fn(async () => [])
    const { bridge } = setup({ cookies: { getAll }, permissions: { contains: async () => true } })
    expect(await bridge.handle(request(), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'ytm-1',
      code: 'login-disabled',
    })
    expect(getAll).not.toHaveBeenCalled()
  })

  it('requires the optional cookies permission and Firefox consent', async () => {
    const getAll = vi.fn(async () => [])
    const noPermission = setup({
      youtubeMusicLogin: true,
      cookies: { getAll },
      permissions: { contains: async () => false },
    })
    expect(await noPermission.bridge.handle(request(), PAGE)).toMatchObject({
      type: MESSAGE.error,
      code: 'login-disabled',
    })
    const noConsent = setup({
      youtubeMusicLogin: true,
      consent: false,
      cookies: { getAll },
      permissions: { contains: async () => true },
    })
    expect(await noConsent.bridge.handle(request('consent'), PAGE)).toMatchObject({
      type: MESSAGE.error,
      id: 'consent',
      code: 'login-disabled',
    })
    expect(getAll).not.toHaveBeenCalled()
  })

  it('refuses private and container tabs before reading their cookies', async () => {
    const getAll = vi.fn(async () => [{ name: 'SAPISID', value: 'not-for-private' }])
    const { bridge } = setup({
      youtubeMusicLogin: true,
      cookies: { getAll },
      permissions: { contains: async () => true },
    })
    expect(await bridge.handle(request(), PRIVATE_PAGE)).toMatchObject({
      type: MESSAGE.error,
      code: 'private-tab',
    })
    expect(getAll).not.toHaveBeenCalled()
  })

  it('distinguishes a signed-out YouTube Music session', async () => {
    const { bridge } = setup({
      youtubeMusicLogin: true,
      cookies: { getAll: async () => [{ name: 'PREF', value: 'f6=400' }] },
      permissions: { contains: async () => true },
    })
    expect(await bridge.handle(request('signed-out'), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'signed-out',
      code: 'not-signed-in',
    })
  })

  it('returns normalized music metadata and never returns browser cookies', async () => {
    readYouTubeMusicAccountMock.mockResolvedValueOnce({
      likedTracks: [],
      savedTracks: [],
      playlists: [],
      savedAlbums: [],
      followedArtists: [],
    })
    const cookie = {
      name: 'SAPISID',
      value: 'private-sapisid-value',
      domain: '.youtube.com',
      path: '/',
      secure: true,
      httpOnly: true,
    }
    const getAll = vi.fn(async () => [cookie])
    const { bridge } = setup({
      youtubeMusicLogin: true,
      cookies: { getAll },
      permissions: { contains: async () => true },
    })
    const reply = await bridge.handle(request('ok'), PAGE)
    expect(reply).toMatchObject({
      type: MESSAGE.response,
      id: 'ok',
      status: 200,
      json: {
        likedTracks: [],
        savedTracks: [],
        playlists: [],
        savedAlbums: [],
        followedArtists: [],
      },
    })
    expect((reply as { json: { account: string } }).json.account).toMatch(/^[a-f0-9]{24}$/u)
    expect(JSON.stringify(reply)).not.toContain('private-sapisid-value')
    expect(readYouTubeMusicAccountMock).toHaveBeenCalledOnce()
    expect(getAll).toHaveBeenCalledWith({ url: 'https://music.youtube.com/' })
  })
})

describe('Spotify server-time relay', () => {
  it('fetches the server time without credentials, even with the login toggle off', async () => {
    const { bridge, fetch } = setup({ fetch: jsonFetch({ serverTime: 1_800_000_000 }) })
    expect(await bridge.handle(serverTime('s'), PAGE)).toEqual({
      type: MESSAGE.response,
      id: 's',
      status: 200,
      json: { serverTime: 1_800_000_000 },
    })
    expect(fetch).toHaveBeenCalledWith(
      SPOTIFY_SERVER_TIME_URL,
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    )
  })
})

describe('failures', () => {
  it('reports network errors, timeouts and oversized responses', async () => {
    const offline = setup({ fetch: vi.fn<FetchLike>().mockRejectedValue(new TypeError('offline')) })
    expect(await offline.bridge.handle(serverTime(), PAGE)).toMatchObject({ code: 'network-error' })

    const slow = setup({
      fetch: vi.fn<FetchLike>().mockRejectedValue(new DOMException('slow', 'TimeoutError')),
    })
    expect(await slow.bridge.handle(serverTime(), PAGE)).toMatchObject({ code: 'timeout' })

    const big = setup({ fetch: jsonFetch({ padding: 'x'.repeat(100) }), maxResponseBytes: 64 })
    expect(await big.bridge.handle(serverTime(), PAGE)).toMatchObject({ code: 'too-large' })
  })

  it('aborts a request that outlives the timeout', async () => {
    // Settles only when the bridge's own signal aborts, as a hanging server would.
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const { bridge } = setup({ fetch, timeoutMs: 10 })
    expect(await bridge.handle(serverTime('slow'), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'slow',
      code: 'timeout',
    })
  })

  it('refuses a response whose declared length is too large, without reading it', async () => {
    // One byte of body: only the Content-Length header can make this response too large.
    const fetch = vi.fn<FetchLike>(
      async () => new Response('1', { headers: { 'content-length': '1000' } }),
    )
    const { bridge } = setup({ fetch, maxResponseBytes: 64 })
    expect(await bridge.handle(serverTime('declared'), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'declared',
      code: 'too-large',
    })
  })

  it('answers internal, with the request ID, when the settings cannot be read', async () => {
    const settings = { read: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable')) }
    const { bridge, fetch } = setup({ settings })
    expect(await bridge.handle(token('broken'), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 'broken',
      code: 'internal',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects unknown messages', async () => {
    const { bridge, fetch } = setup({ login: true })
    expect(await bridge.handle({ type: 'fxm-connect:fetch', id: 1, url: FXM }, PAGE)).toEqual({
      type: MESSAGE.error,
      id: 1,
      code: 'unsupported',
    })
    expect(await bridge.handle('ping', PAGE)).toEqual({
      type: MESSAGE.error,
      id: null,
      code: 'bad-request',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('rate limit', () => {
  it('allows about ten requests a minute across both relays', async () => {
    const { bridge, fetch, clock } = setup({ login: true })
    expect(RATE_LIMIT).toEqual({ max: 10, windowMs: 60_000 })
    for (let i = 0; i < 10; i++) {
      const message = i % 2 === 0 ? token(i) : serverTime(i)
      expect(await bridge.handle(message, PAGE)).toMatchObject({ type: MESSAGE.response, id: i })
    }
    expect(await bridge.handle(serverTime(10), PAGE)).toEqual({
      type: MESSAGE.error,
      id: 10,
      code: 'rate-limited',
    })
    expect(fetch).toHaveBeenCalledTimes(10)
    clock.now += 60_000
    expect(await bridge.handle(serverTime(11), PAGE)).toMatchObject({ type: MESSAGE.response })
  })

  it('does not count requests that were refused before any network access', async () => {
    const { bridge } = setup({ login: false })
    for (let i = 0; i < 20; i++) {
      expect(await bridge.handle(token(i), PAGE)).toMatchObject({ code: 'login-disabled' })
    }
    expect(await bridge.handle(serverTime(), PAGE)).toMatchObject({ type: MESSAGE.response })
  })

  it('survives the background being stopped and restarted', async () => {
    const session = memoryStorage()
    const first = setup({ session: session.area })
    for (let i = 0; i < 10; i++) await first.bridge.handle(serverTime(i), PAGE)
    expect(session.data[RATE_LIMIT_KEY]).toHaveLength(10)

    const restarted = setup({ session: session.area })
    expect(await restarted.bridge.handle(serverTime(), PAGE)).toMatchObject({
      code: 'rate-limited',
    })
    expect(restarted.fetch).not.toHaveBeenCalled()
  })
})

describe('ruleset switching (dev build)', () => {
  it('enables the ruleset of the localhost origin that connected', async () => {
    const dnr = { updateEnabledRulesets: vi.fn(async () => {}) }
    const { bridge } = setup({ origins: fxmOrigins(true), dnr })
    expect(
      await bridge.handle(
        { type: MESSAGE.activateOrigin },
        { origin: 'http://localhost:4173', privateTab: false },
      ),
    ).toBe(null)
    expect(dnr.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: ['localhost_4173'],
      disableRulesetIds: ['localhost_5173'],
    })
  })

  it('never touches rulesets in the production build', async () => {
    const dnr = { updateEnabledRulesets: vi.fn(async () => {}) }
    const { bridge } = setup({ dnr })
    expect(await bridge.handle({ type: MESSAGE.activateOrigin }, PAGE)).toBeNull()
    expect(dnr.updateEnabledRulesets).not.toHaveBeenCalled()
  })
})

describe('runtime.onMessage listener', () => {
  it('ignores untrusted senders and never answers them', () => {
    const { bridge, fetch } = setup({ login: true })
    const sendResponse = vi.fn()
    const sender = { ...tabSender, origin: 'https://evil.example' }
    expect(bridge.listener(token(), sender, sendResponse)).toBe(false)
    expect(sendResponse).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tells the bridge whether the sender tab is private', async () => {
    const { bridge, fetch } = setup({ login: true })
    const sendResponse = vi.fn()
    const sender = { ...tabSender, tab: { id: 4, incognito: true } }
    expect(bridge.listener(token('i'), sender, sendResponse)).toBe(true)
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        type: MESSAGE.error,
        id: 'i',
        code: 'private-tab',
      }),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('answers internal without an ID when a background task fails', async () => {
    const dnr = { updateEnabledRulesets: vi.fn().mockRejectedValue(new Error('quota')) }
    const { bridge } = setup({ origins: fxmOrigins(true), dnr })
    const sendResponse = vi.fn()
    const sender = { ...tabSender, origin: 'http://localhost:5173' }
    expect(bridge.listener({ type: MESSAGE.activateOrigin }, sender, sendResponse)).toBe(true)
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        type: MESSAGE.error,
        id: null,
        code: 'internal',
      }),
    )
  })

  it('answers trusted senders asynchronously', async () => {
    const { bridge } = setup({ login: true })
    const sendResponse = vi.fn()
    expect(bridge.listener(token('z'), tabSender, sendResponse)).toBe(true)
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        type: MESSAGE.response,
        id: 'z',
        status: 200,
        json: TOKEN_JSON,
      }),
    )
  })
})
