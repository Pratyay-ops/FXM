import { FxmError, isFxmError } from '@fxm/core'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECT_BRIDGE_TIMEOUT_MS,
  CONNECT_MARKER_ATTRIBUTE,
  CONNECT_PING_TIMEOUT_MS,
  CONNECT_REDIRECT_FIX_VERSION,
  CONNECT_SEEN_KEY,
  ConnectBridgeError,
  type ConnectClient,
  type ConnectStatus,
  type ConnectWindow,
  compareVersions,
  createConnectClient,
  hasConnectFeature,
  MIN_CONNECT_VERSION,
  needsRedirectFix,
  SPOTIFY_LOGIN_TEXT_VERSION,
  saysSpotifyLoginUnused,
} from './connect'
import { type KeyValueStorage, memoryStorage } from './storage'
import { createFakeClock } from './testing/fake-clock'
import { FAKE_CONNECT_FEATURES, installFakeConnect } from './testing/fake-connect'

/** Messages travel on happy-dom's real timers, which a busy machine can slow down a lot. */
const PATIENCE = { timeout: 10_000 }

const APP = 'https://fxmusic.pages.dev/app/'
const ORIGIN = 'https://fxmusic.pages.dev'

type Page = ConnectWindow & {
  happyDOM: { close(): Promise<void> }
  Event: typeof Event
  MessageEvent: typeof MessageEvent
  dispatchEvent(event: Event): boolean
}

const open: { close(): Promise<void> }[] = []
const clients: ConnectClient[] = []

function page(url = APP): Page {
  const window = new Window({ url }) as unknown as Page
  open.push(window.happyDOM)
  return window
}

function setup(options: { storage?: KeyValueStorage; url?: string } = {}) {
  const window = page(options.url)
  const clock = createFakeClock(Date.UTC(2026, 9, 25))
  const storage = options.storage ?? memoryStorage()
  const client = createConnectClient({ window, storage, clock })
  clients.push(client)
  return { window, clock, storage, client }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose()
  await Promise.all(open.splice(0).map((window) => window.close()))
})

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('detection', () => {
  it('finds no FXM Connect without the marker, at once and without a ping', async () => {
    const { window, client } = setup()
    const post = vi.spyOn(window, 'postMessage')
    expect(client.status).toBeUndefined()
    await expect(client.detect()).resolves.toEqual({ state: 'absent', features: [] })
    expect(post).not.toHaveBeenCalled()
  })

  it('finds a current FXM Connect, its version and features, and remembers it', async () => {
    const { window, client, storage } = setup()
    installFakeConnect(window, { version: '0.1.0' })
    const status = await client.detect()
    expect(status).toEqual({
      state: 'present',
      version: '0.1.0',
      features: [...FAKE_CONNECT_FEATURES],
    })
    expect(client.status).toEqual(status)
    expect(JSON.parse(storage.getItem(CONNECT_SEEN_KEY) as string)).toMatchObject({
      version: '0.1.0',
    })
  })

  it('accepts newer versions', async () => {
    const { window, client } = setup()
    installFakeConnect(window, { version: '1.2.3' })
    expect((await client.detect()).state).toBe('present')
  })

  it.each(['0.0.9', '0.0.10', '1.0-beta', 'x'])('marks version %s as outdated', async (version) => {
    const { window, client } = setup()
    installFakeConnect(window, { version })
    const status = await client.detect()
    expect(status).toMatchObject({ state: 'outdated', version })
    expect(hasConnectFeature(status, 'youtube')).toBe(false)
  })

  it('gives up after the ping timeout when the marker is there but nothing answers', async () => {
    const { window, client, clock } = setup()
    installFakeConnect(window, { answerPings: false })
    const detection = client.detect()
    clock.advance(CONNECT_PING_TIMEOUT_MS - 1)
    let settled = false
    void detection.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    clock.advance(1)
    await expect(detection).resolves.toEqual({ state: 'absent', features: [] })
  })

  it('reports an FXM Connect seen on this device before as missing, until forgotten', async () => {
    const storage = memoryStorage({
      [CONNECT_SEEN_KEY]: JSON.stringify({ version: '0.1.0', at: 1 }),
    })
    const { client } = setup({ storage })
    const seen: ConnectStatus[] = []
    client.subscribe((status) => seen.push(status))
    await expect(client.detect()).resolves.toEqual({
      state: 'missing',
      features: [],
      lastSeenVersion: '0.1.0',
    })
    client.forget()
    expect(client.status).toEqual({ state: 'absent', features: [] })
    expect(storage.getItem(CONNECT_SEEN_KEY)).toBeNull()
    expect(seen.map((status) => status.state)).toEqual(['missing', 'absent'])
  })

  it('ignores a malformed "seen" record', async () => {
    const storage = memoryStorage({ [CONNECT_SEEN_KEY]: '{"version":7}' })
    const { client } = setup({ storage })
    expect((await client.detect()).state).toBe('absent')
  })

  it('ignores spoofed and malformed pongs', async () => {
    const { window, client, clock } = setup()
    window.document.documentElement.setAttribute(CONNECT_MARKER_ATTRIBUTE, '0.1.0')
    const other = page('https://evil.example/')
    const pong = { type: 'fxm-connect:pong', version: '0.1.0', features: ['youtube'] }
    const detection = client.detect()
    const send = (data: unknown, init: { origin?: string; source?: unknown } = {}) =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data,
          origin: init.origin ?? ORIGIN,
          source: (init.source ?? window) as MessageEventSource,
        }),
      )
    send(pong, { source: other })
    send(pong, { origin: 'https://evil.example' })
    send(pong, { origin: 'https://preview.fxmusic.pages.dev' })
    send({ ...pong, version: 1 })
    send({ ...pong, version: '' })
    send({ ...pong, features: 'youtube' })
    send({ ...pong, features: [1] })
    send({ ...pong, features: Array.from({ length: 40 }, () => 'x') })
    send('fxm-connect:pong')
    send(null)
    clock.advance(CONNECT_PING_TIMEOUT_MS)
    await expect(detection).resolves.toEqual({ state: 'absent', features: [] })
  })

  it('accepts a pong that arrives after the timeout', async () => {
    const { window, client, clock } = setup()
    const connect = installFakeConnect(window, { answerPings: false })
    const detection = client.detect()
    clock.advance(CONNECT_PING_TIMEOUT_MS)
    expect((await detection).state).toBe('absent')
    connect.update({ answerPings: true })
    window.postMessage({ type: 'fxm-connect:ping' }, ORIGIN)
    await vi.waitFor(() => expect(client.status?.state).toBe('present'), PATIENCE)
  })

  it('detects again by itself when the marker appears, changes or goes away', async () => {
    const { window, client } = setup()
    const seen: ConnectStatus[] = []
    client.subscribe((status) => seen.push(status))
    expect((await client.detect()).state).toBe('absent')
    const connect = installFakeConnect(window, { version: '0.1.0' })
    await vi.waitFor(() => expect(client.status?.state).toBe('present'), PATIENCE)
    connect.update({ version: '0.2.0' })
    await vi.waitFor(() => expect(client.status?.version).toBe('0.2.0'), PATIENCE)
    connect.uninstall()
    await vi.waitFor(() => expect(client.status?.state).toBe('missing'), PATIENCE)
    expect(seen.map((status) => [status.state, status.version ?? status.lastSeenVersion])).toEqual([
      ['absent', undefined],
      ['present', '0.1.0'],
      ['present', '0.2.0'],
      ['missing', '0.2.0'],
    ])
  })

  it('runs once more for callers that come in while a detection runs', async () => {
    const { window, client } = setup()
    const connect = installFakeConnect(window)
    const first = client.detect()
    const second = client.detect()
    const third = client.detect()
    expect(third).toBe(second)
    await Promise.all([first, second])
    expect(connect.pings).toBe(2)
    expect((await second).state).toBe('present')
  })

  it('notifies listeners only of changes, and survives a failing one', async () => {
    const { window, client } = setup()
    installFakeConnect(window)
    const seen: string[] = []
    client.subscribe(() => {
      throw new Error('broken listener')
    })
    const unsubscribe = client.subscribe((status) => seen.push(status.state))
    await client.detect()
    await client.detect()
    unsubscribe()
    expect(seen).toEqual(['present'])
  })

  it('detects again when the page gets the focus back or becomes visible', async () => {
    const { window, client } = setup()
    const connect = installFakeConnect(window, { features: ['spotify'] })
    expect((await client.detect()).features).toEqual(['spotify'])
    // The user turned the Spotify login on in FXM Connect's options, in another tab.
    connect.update({ features: ['spotify', 'spotify-login'] })
    window.dispatchEvent(new window.Event('focus'))
    await vi.waitFor(() => expect(client.status?.features).toContain('spotify-login'), PATIENCE)
    connect.update({ features: ['spotify'] })
    Object.defineProperty(window.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    window.document.dispatchEvent(new window.Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.status?.features).toContain('spotify-login')
    Object.defineProperty(window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
    window.document.dispatchEvent(new window.Event('visibilitychange'))
    await vi.waitFor(() => expect(client.status?.features).toEqual(['spotify']), PATIENCE)
  })

  it('needs a window', () => {
    expect(() => createConnectClient()).toThrow(FxmError)
  })

  it('stops watching once disposed', async () => {
    const { window, client } = setup()
    client.dispose()
    client.dispose()
    const connect = installFakeConnect(window)
    window.dispatchEvent(new window.Event('focus'))
    window.document.dispatchEvent(new window.Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.status).toBeUndefined()
    expect(connect.pings).toBe(0)
  })
})

describe('the Spotify session bridge', () => {
  async function present(bridge: Parameters<typeof installFakeConnect>[1] = {}) {
    const context = setup()
    const connect = installFakeConnect(context.window, {
      features: [...FAKE_CONNECT_FEATURES, 'spotify-login'],
      ...bridge,
    })
    await context.client.detect()
    return { ...context, connect }
  }

  it('relays a token request with exactly the allowed parameters', async () => {
    const { client, connect } = await present({
      bridge: () => ({ status: 200, json: { accessToken: 'token', isAnonymous: false } }),
    })
    const response = await client.spotifyToken({
      reason: 'init',
      productType: 'web-player',
      totp: '123456',
      totpServer: '654321',
      totpVer: '61',
    })
    expect(response).toEqual({ status: 200, json: { accessToken: 'token', isAnonymous: false } })
    const [request] = connect.bridgeRequests
    expect(request?.type).toBe('fxm-connect:spotify-token')
    expect(String(request?.id)).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/)
    expect(request?.params).toEqual({
      reason: 'init',
      productType: 'web-player',
      totp: '123456',
      totpServer: '654321',
      totpVer: '61',
    })
  })

  it('leaves out parameters that are not given', async () => {
    const { client, connect } = await present({ bridge: () => ({ status: 200, json: {} }) })
    await client.spotifyToken({ reason: 'init' })
    expect(connect.bridgeRequests[0]?.params).toEqual({ reason: 'init' })
  })

  it('relays a YouTube Music library request without credentials or parameters', async () => {
    const { client, connect } = await present({
      features: [...FAKE_CONNECT_FEATURES, 'youtube-music-login'],
      bridge: () => ({ status: 200, json: { accountId: 'UC-test', likedSongs: [] } }),
    })
    await expect(client.youtubeMusicLibrary()).resolves.toEqual({
      status: 200,
      json: { accountId: 'UC-test', likedSongs: [] },
    })
    expect(connect.bridgeRequests).toHaveLength(1)
    expect(connect.bridgeRequests[0]?.type).toBe(CONNECT_MESSAGE.youtubeMusicLibrary)
    expect(connect.bridgeRequests[0]?.params).toBeUndefined()
  })

  it('relays the server time, with a fresh ID for every request', async () => {
    const { client, connect } = await present({
      bridge: () => ({ status: 200, json: { serverTime: 1761400000 } }),
    })
    await expect(client.spotifyServerTime()).resolves.toEqual({
      status: 200,
      json: { serverTime: 1761400000 },
    })
    await client.spotifyServerTime()
    const [first, second] = connect.bridgeRequests
    expect(first?.type).toBe('fxm-connect:spotify-server-time')
    expect(first?.id).not.toBe(second?.id)
  })

  it.each([
    ['login-disabled', 'AuthRequired'],
    ['private-tab', 'AuthRequired'],
    ['bad-request', 'Unsupported'],
    ['unsupported', 'Unsupported'],
    ['rate-limited', 'RateLimited'],
    ['network-error', 'Network'],
    ['timeout', 'Network'],
    ['too-large', 'Parse'],
    ['unavailable', 'Network'],
    ['internal', 'Network'],
    ['something-new', 'Network'],
  ])('maps the %s error to %s', async (code, fxmCode) => {
    const { client } = await present({ bridge: () => ({ error: code }) })
    const error = await rejection(client.spotifyToken({ reason: 'init' }))
    expect(error).toBeInstanceOf(ConnectBridgeError)
    expect(isFxmError(error, fxmCode as never)).toBe(true)
    expect((error as ConnectBridgeError).connectCode).toBe(code)
    expect((error as ConnectBridgeError).retryAfterMs).toBe(
      code === 'rate-limited' ? 60_000 : undefined,
    )
  })

  it.each(['login-disabled', 'private-tab'])(
    'detects again after a %s reply, since the announced login is out of date',
    async (code) => {
      const { client, connect } = await present({ bridge: () => ({ error: code }) })
      const pings = connect.pings
      connect.update({ features: [...FAKE_CONNECT_FEATURES] })
      await rejection(client.spotifyToken({ reason: 'transport' }))
      await vi.waitFor(() => expect(client.status?.features).not.toContain('spotify-login'), {
        ...PATIENCE,
      })
      expect(connect.pings).toBe(pings + 1)
    },
  )

  it('times out when FXM Connect never answers', async () => {
    const { client, clock } = await present({ bridge: () => new Promise(() => {}) })
    const request = client.spotifyServerTime()
    await vi.waitFor(() => expect(clock.pendingTimers).toBe(1), PATIENCE)
    clock.advance(CONNECT_BRIDGE_TIMEOUT_MS)
    expect(isFxmError(await rejection(request), 'Network')).toBe(true)
  })

  it('stops waiting when the signal aborts', async () => {
    const { client, clock } = await present({ bridge: () => new Promise(() => {}) })
    const controller = new AbortController()
    const request = client.spotifyServerTime({ signal: controller.signal })
    await vi.waitFor(() => expect(clock.pendingTimers).toBe(1), PATIENCE)
    controller.abort(new Error('user left'))
    expect(((await rejection(request)) as Error).message).toBe('user left')
    expect(clock.pendingTimers).toBe(0)
    const signal = AbortSignal.abort(new Error('already'))
    expect(((await rejection(client.spotifyServerTime({ signal }))) as Error).message).toBe(
      'already',
    )
  })

  it('ignores replies to other requests and malformed replies', async () => {
    const { client, clock, window } = await present({ bridge: () => new Promise(() => {}) })
    const request = client.spotifyServerTime()
    await vi.waitFor(() => expect(clock.pendingTimers).toBe(1), PATIENCE)
    for (const reply of [
      { type: 'fxm-connect:response', id: 'someone-else', status: 200, json: {} },
      { type: 'fxm-connect:response', id: 7, status: 200, json: {} },
      { type: 'fxm-connect:error', id: null, code: 'internal' },
    ]) {
      window.postMessage(reply, ORIGIN)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    clock.advance(CONNECT_BRIDGE_TIMEOUT_MS)
    expect(isFxmError(await rejection(request), 'Network')).toBe(true)
  })

  it('ignores replies with the pending request’s ID that come from anywhere but the page', async () => {
    const { client, clock, window } = await present({ bridge: () => new Promise(() => {}) })
    const post = vi.spyOn(window, 'postMessage')
    let settled = false
    const request = client.spotifyToken({ reason: 'transport' })
    void request.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.waitFor(() => expect(post).toHaveBeenCalled(), PATIENCE)
    const id = (post.mock.calls[0]?.[0] as { id?: string } | undefined)?.id
    expect(typeof id).toBe('string')
    const other = page('https://evil.example/')
    const replies = [
      { type: 'fxm-connect:response', id, status: 200, json: { accessToken: 'forged' } },
      { type: 'fxm-connect:error', id, code: 'login-disabled' },
    ]
    const sources: { origin: string; source: unknown }[] = [
      { origin: 'https://evil.example', source: window },
      { origin: ORIGIN, source: other },
      { origin: 'null', source: window },
      { origin: ORIGIN, source: null },
    ]
    for (const data of replies) {
      for (const { origin, source } of sources) {
        window.dispatchEvent(
          new window.MessageEvent('message', {
            data,
            origin,
            source: source as MessageEventSource | null,
          }),
        )
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'fxm-connect:response', id, status: 200, json: { accessToken: 'real' } },
        origin: ORIGIN,
        source: window as unknown as MessageEventSource,
      }),
    )
    await expect(request).resolves.toEqual({ status: 200, json: { accessToken: 'real' } })
    expect(clock.pendingTimers).toBe(0)
  })

  it('ignores a reply with the right ID but a malformed body', async () => {
    const { client, clock, window } = await present({ bridge: () => new Promise(() => {}) })
    const post = vi.spyOn(window, 'postMessage')
    const request = client.spotifyServerTime()
    await vi.waitFor(() => expect(post).toHaveBeenCalled(), PATIENCE)
    const id = (post.mock.calls[0]?.[0] as { id?: string } | undefined)?.id
    window.postMessage({ type: 'fxm-connect:response', id, status: '200', json: {} }, ORIGIN)
    window.postMessage({ type: 'fxm-connect:response', id, status: 200 }, ORIGIN)
    window.postMessage({ type: 'fxm-connect:error', id, code: 5 }, ORIGIN)
    await new Promise((resolve) => setTimeout(resolve, 20))
    clock.advance(CONNECT_BRIDGE_TIMEOUT_MS)
    expect(isFxmError(await rejection(request), 'Network')).toBe(true)
  })

  it.each([
    ['an unknown parameter', { market: 'IN' }],
    ['a malformed TOTP', { totp: '12ab56' }],
    ['a non-string value', { totpVer: 61 }],
    ['an overlong reason', { reason: `a${'b'.repeat(40)}` }],
  ])('refuses %s without asking FXM Connect', async (_case, params) => {
    const { client, connect } = await present()
    const error = await rejection(client.spotifyToken(params as never))
    expect(isFxmError(error, 'Unsupported')).toBe(true)
    expect(connect.bridgeRequests).toEqual([])
  })

  it('refuses requests when FXM Connect is absent or outdated', async () => {
    const absent = setup()
    const post = vi.spyOn(absent.window, 'postMessage')
    expect(isFxmError(await rejection(absent.client.spotifyServerTime()), 'Unsupported')).toBe(true)
    expect(post).not.toHaveBeenCalled()

    const outdated = setup()
    installFakeConnect(outdated.window, { version: '0.0.1' })
    await outdated.client.detect()
    expect(isFxmError(await rejection(outdated.client.spotifyServerTime()), 'Unsupported')).toBe(
      true,
    )
  })

  it('rejects pending requests when disposed', async () => {
    const { client } = await present({ bridge: () => new Promise(() => {}) })
    const request = client.spotifyServerTime()
    await new Promise((resolve) => setTimeout(resolve, 5))
    client.dispose()
    expect(isFxmError(await rejection(request), 'Unsupported')).toBe(true)
    expect(isFxmError(await rejection(client.spotifyServerTime()), 'Unsupported')).toBe(true)
  })
})

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.1.0', 0],
    ['0.1', '0.1.0', 0],
    ['0.2.0', '0.1.9', 1],
    ['0.1.9', '0.2.0', -1],
    ['1.0.0.1', '1.0.0', 1],
    ['10.0.0', '9.9.9', 1],
  ])('compares %s with %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b) as number)).toBe(sign)
  })

  it('refuses what is not a dotted version', () => {
    expect(compareVersions('1.0-beta', '1.0')).toBeUndefined()
    expect(compareVersions('1.0', '')).toBeUndefined()
    expect(compareVersions('1.2.3.4.5', '1')).toBeUndefined()
  })

  it('knows the minimum version FXM Connect has today', () => {
    expect(compareVersions(MIN_CONNECT_VERSION, '0.1.0')).toBe(0)
  })

  it('knows which versions still say the Spotify login setting changes nothing', () => {
    // 0.1.0, the first release, says so; 0.2.0 describes the setting as the app uses it.
    expect(SPOTIFY_LOGIN_TEXT_VERSION).toBe('0.2.0')
    expect(saysSpotifyLoginUnused('0.1.0')).toBe(true)
    expect(saysSpotifyLoginUnused('0.1.9')).toBe(true)
    expect(saysSpotifyLoginUnused('0.2.0')).toBe(false)
    expect(saysSpotifyLoginUnused('1.0.0')).toBe(false)
    expect(saysSpotifyLoginUnused('dev')).toBe(false)
    expect(saysSpotifyLoginUnused(undefined)).toBe(false)
  })

  it('knows which versions lose googlevideo bytes after a redirect to another host', () => {
    // 0.2.1 answers googlevideo media with Access-Control-Allow-Origin: *.
    expect(CONNECT_REDIRECT_FIX_VERSION).toBe('0.2.1')
    expect(needsRedirectFix('0.1.0')).toBe(true)
    expect(needsRedirectFix('0.2.0')).toBe(true)
    expect(needsRedirectFix('0.2.1')).toBe(false)
    expect(needsRedirectFix('0.3.0')).toBe(false)
    expect(needsRedirectFix('dev')).toBe(false)
    expect(needsRedirectFix(undefined)).toBe(false)
  })
})

describe('hasConnectFeature', () => {
  it('needs a present FXM Connect that announced the feature', () => {
    const present: ConnectStatus = { state: 'present', version: '0.1.0', features: ['youtube'] }
    expect(hasConnectFeature(present, 'youtube')).toBe(true)
    expect(hasConnectFeature(present, 'spotify')).toBe(false)
    expect(hasConnectFeature({ ...present, state: 'outdated' }, 'youtube')).toBe(false)
    expect(hasConnectFeature(undefined, 'youtube')).toBe(false)
  })
})
