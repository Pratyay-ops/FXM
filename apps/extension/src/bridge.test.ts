import { describe, expect, it, vi } from 'vitest'
import {
  createBridge,
  type FetchLike,
  RATE_LIMIT,
  RATE_LIMIT_KEY,
  SPOTIFY_SERVER_TIME_URL,
  spotifyTokenUrl,
  trustedSenderOrigin,
} from './bridge.ts'
import { fxmOrigins } from './config.ts'
import { MESSAGE } from './messages.ts'
import type { MessageSender, StorageArea, WebExtApi } from './webext.ts'

const FXM = 'https://fxm-music.pages.dev'
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
  origins?: readonly string[]
  fetch?: FetchLike
  session?: StorageArea
  dnr?: WebExtApi['declarativeNetRequest']
  maxResponseBytes?: number
}

function setup(options: SetupOptions = {}) {
  const clock = { now: 1_000_000 }
  const fetch = options.fetch ?? jsonFetch()
  const local = memoryStorage(options.login ? { spotifyLogin: true } : {})
  const bridge = createBridge({
    runtimeId: RUNTIME_ID,
    origins: options.origins ?? fxmOrigins(false),
    storage: { local: local.area, session: options.session },
    dnr: options.dnr,
    fetch,
    now: () => clock.now,
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
  })
  return { bridge, fetch, clock }
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
    ['a look-alike host', { ...tabSender, origin: 'https://fxm-music.pages.dev.evil.example' }],
    ['an unparsable URL', { id: RUNTIME_ID, url: 'not a url', tab: { id: 4 }, frameId: 0 }],
  ])('rejects %s', (_label, sender) => {
    expect(trustedSenderOrigin(sender, RUNTIME_ID, [FXM])).toBeNull()
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
    expect(await bridge.handle(token(), FXM)).toEqual({
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
    const reply = await bridge.handle(token('t1'), FXM)
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
  })

  it('relays error statuses and non-JSON bodies as they are', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('<html>denied</html>', { status: 403 }))
    const { bridge } = setup({ login: true, fetch })
    expect(await bridge.handle(token(), FXM)).toEqual({
      type: MESSAGE.response,
      id: 'a',
      status: 403,
      json: null,
    })
  })

  it('rejects parameters outside the allow-list without any request', async () => {
    const { bridge, fetch } = setup({ login: true })
    const message = { type: MESSAGE.spotifyToken, id: 9, params: { reason: 'init', url: 'x' } }
    expect(await bridge.handle(message, FXM)).toEqual({
      type: MESSAGE.error,
      id: 9,
      code: 'bad-request',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Spotify server-time relay', () => {
  it('fetches the server time without credentials, even with the login toggle off', async () => {
    const { bridge, fetch } = setup({ fetch: jsonFetch({ serverTime: 1_800_000_000 }) })
    expect(await bridge.handle(serverTime('s'), FXM)).toEqual({
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
    expect(await offline.bridge.handle(serverTime(), FXM)).toMatchObject({ code: 'network-error' })

    const slow = setup({
      fetch: vi.fn<FetchLike>().mockRejectedValue(new DOMException('slow', 'TimeoutError')),
    })
    expect(await slow.bridge.handle(serverTime(), FXM)).toMatchObject({ code: 'timeout' })

    const big = setup({ fetch: jsonFetch({ padding: 'x'.repeat(100) }), maxResponseBytes: 64 })
    expect(await big.bridge.handle(serverTime(), FXM)).toMatchObject({ code: 'too-large' })
  })

  it('rejects unknown messages', async () => {
    const { bridge, fetch } = setup({ login: true })
    expect(await bridge.handle({ type: 'fxm-connect:fetch', id: 1, url: FXM }, FXM)).toEqual({
      type: MESSAGE.error,
      id: 1,
      code: 'unsupported',
    })
    expect(await bridge.handle('ping', FXM)).toEqual({
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
      expect(await bridge.handle(message, FXM)).toMatchObject({ type: MESSAGE.response, id: i })
    }
    expect(await bridge.handle(serverTime(10), FXM)).toEqual({
      type: MESSAGE.error,
      id: 10,
      code: 'rate-limited',
    })
    expect(fetch).toHaveBeenCalledTimes(10)
    clock.now += 60_000
    expect(await bridge.handle(serverTime(11), FXM)).toMatchObject({ type: MESSAGE.response })
  })

  it('does not count requests that were refused before any network access', async () => {
    const { bridge } = setup({ login: false })
    for (let i = 0; i < 20; i++) {
      expect(await bridge.handle(token(i), FXM)).toMatchObject({ code: 'login-disabled' })
    }
    expect(await bridge.handle(serverTime(), FXM)).toMatchObject({ type: MESSAGE.response })
  })

  it('survives the background being stopped and restarted', async () => {
    const session = memoryStorage()
    const first = setup({ session: session.area })
    for (let i = 0; i < 10; i++) await first.bridge.handle(serverTime(i), FXM)
    expect(session.data[RATE_LIMIT_KEY]).toHaveLength(10)

    const restarted = setup({ session: session.area })
    expect(await restarted.bridge.handle(serverTime(), FXM)).toMatchObject({
      code: 'rate-limited',
    })
    expect(restarted.fetch).not.toHaveBeenCalled()
  })
})

describe('ruleset switching (dev build)', () => {
  it('enables the ruleset of the localhost origin that connected', async () => {
    const dnr = { updateEnabledRulesets: vi.fn(async () => {}) }
    const { bridge } = setup({ origins: fxmOrigins(true), dnr })
    expect(await bridge.handle({ type: MESSAGE.activateOrigin }, 'http://localhost:4173')).toBe(
      null,
    )
    expect(dnr.updateEnabledRulesets).toHaveBeenCalledWith({
      enableRulesetIds: ['localhost_4173'],
      disableRulesetIds: ['localhost_5173'],
    })
  })

  it('never touches rulesets in the production build', async () => {
    const dnr = { updateEnabledRulesets: vi.fn(async () => {}) }
    const { bridge } = setup({ dnr })
    expect(await bridge.handle({ type: MESSAGE.activateOrigin }, FXM)).toBeNull()
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
