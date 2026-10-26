import { isFxmError } from '@fxm/core'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestBudget, isBudgetError } from './budget'
import { type ConnectStatus, type ConnectWindow, createConnectClient } from './connect'
import { isCorsSimpleRequest } from './cors'
import { isRouteUnavailable, isTransportError, RouteUnavailableError } from './errors'
import { SIMPLE_CONTENT_TYPE } from './innertube'
import { createLiteTier, type KillSwitches } from './lite'
import { memoryStorage } from './storage'
import { createFakeClock, flushPromises } from './testing/fake-clock'
import { FAKE_CONNECT_FEATURES, installFakeConnect } from './testing/fake-connect'
import { createFakeSandbox, type FakeSandboxOptions } from './testing/fake-sandbox'
import { createWebTransport } from './web'

/** Messages travel on happy-dom's real timers, which a busy machine can slow down a lot. */
const PATIENCE = { timeout: 10_000 }

const SEARCH = 'https://music.youtube.com/youtubei/v1/search'
const PLAYER = 'https://www.youtube.com/youtubei/v1/player'
const MEDIA = 'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?itag=251&expire=1'
const GRAPHQL = 'https://api-partner.spotify.com/pathfinder/v2/query'
const STATION = 'https://www.last.fm/player/station/music/Radiohead?ajax=1'
const LYRICS = 'https://lrclib.net/api/get?track_name=Creep&artist_name=Radiohead'

const BODY = JSON.stringify({ context: { client: { clientName: 'WEB_REMIX' } }, query: 'creep' })

const connected = (features: readonly string[] = FAKE_CONNECT_FEATURES): ConnectStatus => ({
  state: 'present',
  version: '0.1.0',
  features,
})

interface TierOptions {
  connect?: ConnectStatus
  sandbox?: FakeSandboxOptions | false
  /** Whether to run the Lite self-test before the test starts. Default `true`. */
  check?: boolean
  killSwitches?: () => KillSwitches
  userHosts?: string[]
  respond?: (url: string, init: RequestInit) => Response
  reportLoginRequired?: boolean
}

async function tier(options: TierOptions = {}) {
  const clock = createFakeClock(Date.UTC(2026, 9, 25))
  const budget = createRequestBudget({ clock })
  const pageFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    options.respond ? options.respond(String(input), init ?? {}) : Response.json({ ok: true }),
  )
  const sandbox = options.sandbox === false ? undefined : createFakeSandbox(options.sandbox ?? {})
  const lite =
    sandbox === undefined
      ? undefined
      : createLiteTier({
          sandbox,
          clock,
          ...(options.killSwitches ? { killSwitches: options.killSwitches } : {}),
        })
  if (options.check !== false) await lite?.check()
  const connect = { status: options.connect }
  const transport = createWebTransport({
    fetch: pageFetch as typeof fetch,
    connect,
    budget,
    ...(lite ? { lite } : {}),
    ...(options.userHosts ? { userHosts: () => options.userHosts as string[] } : {}),
    ...(options.reportLoginRequired === undefined
      ? {}
      : { reportLoginRequired: options.reportLoginRequired }),
  })
  return { transport, pageFetch, sandbox, budget, clock, connect, lite }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

async function refusedAsUnsupported(promise: Promise<unknown>): Promise<boolean> {
  return isFxmError(await rejection(promise), 'Unsupported')
}

const innerTubeInit = (): RequestInit => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Goog-Visitor-Id': 'visitor',
    'X-YouTube-Client-Name': '67',
    Authorization: 'Bearer nope',
  },
  body: BODY,
})

describe('the Free tier (no FXM Connect, no Lite)', () => {
  it('fetches CORS-friendly hosts directly, without credentials or a page-set Origin', async () => {
    const { transport, pageFetch } = await tier({ sandbox: false })
    await transport.fetch(LYRICS, {
      headers: {
        Accept: 'application/json',
        Origin: 'https://evil.example',
        Cookie: 'a=b',
        'User-Agent': 'FXM/0.1 (+https://github.com/Pratyay-ops/FXM)',
      },
      credentials: 'include',
    })
    expect(pageFetch).toHaveBeenCalledOnce()
    const [url, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(LYRICS)
    expect(init.credentials).toBe('omit')
    expect(init.headers).toEqual({ accept: 'application/json' })
  })

  it.each([
    ['an InnerTube call', SEARCH],
    ['a YouTube page', 'https://www.youtube.com/sw.js_data'],
    ['googlevideo bytes', MEDIA],
    ['Spotify', GRAPHQL],
    ['a Last.fm station', STATION],
    ['an unknown host', 'https://example.com/'],
  ])('refuses %s with Unsupported', async (_case, url) => {
    const { transport, pageFetch } = await tier({ sandbox: false })
    expect(await refusedAsUnsupported(transport.fetch(url, innerTubeInit()))).toBe(true)
    expect(pageFetch).not.toHaveBeenCalled()
  })

  it('refuses InnerTube when InnerTube refused the Lite self-test', async () => {
    const { transport } = await tier({ sandbox: { selfTest: 'refused' } })
    expect(await refusedAsUnsupported(transport.fetch(SEARCH, innerTubeInit()))).toBe(true)
  })

  it('says what would open a closed route', async () => {
    const noLite = await tier({ sandbox: false })
    const innerTube = await rejection(noLite.transport.fetch(SEARCH, innerTubeInit()))
    expect(innerTube).toBeInstanceOf(RouteUnavailableError)
    expect(innerTube).toMatchObject({
      reason: 'route-closed',
      route: 'innertube',
      needs: ['connect', 'native'],
      connectFeature: 'youtube',
    })
    expect((innerTube as Error).message).toBe(
      'Reaching YouTube Music needs FXM Connect or the desktop or Android app',
    )
    const media = await rejection(noLite.transport.fetch(MEDIA))
    expect(media).toMatchObject({ route: 'googlevideo', connectFeature: 'googlevideo' })
    const unchecked = await tier({ check: false })
    expect(await rejection(unchecked.transport.fetch(SEARCH, innerTubeInit()))).toMatchObject({
      needs: ['connect', 'lite', 'native'],
    })
    const refused = await tier({ sandbox: { selfTest: 'refused' } })
    expect(await rejection(refused.transport.fetch(SEARCH, innerTubeInit()))).toMatchObject({
      needs: ['connect', 'native'],
    })
  })

  it('tells unknown hosts and malformed requests apart from closed routes', async () => {
    const { transport } = await tier()
    const unknown = await rejection(transport.fetch('https://example.com/'))
    expect(isTransportError(unknown, 'unknown-host')).toBe(true)
    expect(isRouteUnavailable(unknown)).toBe(false)
    const notJson = await rejection(transport.fetch(SEARCH, { method: 'POST', body: 'query=x' }))
    expect(isTransportError(notJson, 'bad-request')).toBe(true)
    const relative = await rejection(transport.fetch('/youtubei/v1/search'))
    expect(isTransportError(relative, 'bad-request')).toBe(true)
  })

  it('says which URLs it can reach right now, without drawing from the budget', async () => {
    const { transport, budget } = await tier({ sandbox: false })
    expect(transport.canReach(LYRICS)).toBe(true)
    expect(transport.canReach(new URL(LYRICS))).toBe(true)
    expect(transport.canReach(SEARCH)).toBe(false)
    expect(transport.canReach(STATION)).toBe(false)
    expect(transport.canReach('https://example.com/')).toBe(false)
    expect(transport.canReach('not a url')).toBe(false)
    expect(budget.snapshot().used).toBe(0)
  })
})

describe('the Lite tier (sandbox, no FXM Connect)', () => {
  it('sends InnerTube calls through the sandbox in the CORS-simple shape', async () => {
    const { transport, pageFetch, sandbox, budget } = await tier({
      sandbox: { respond: () => Response.json({ contents: 'results' }) },
    })
    const response = await transport.fetch(SEARCH, innerTubeInit())
    await expect(response.json()).resolves.toEqual({ contents: 'results' })
    expect(pageFetch).not.toHaveBeenCalled()
    const [request] = sandbox?.requests ?? []
    expect(request?.url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(request?.init.headers).toEqual({ 'content-type': SIMPLE_CONTENT_TYPE })
    expect(isCorsSimpleRequest('POST', Object.entries(request?.init.headers ?? {}))).toBe(true)
    expect(JSON.parse(request?.init.body ?? '{}').context.client.visitorData).toBe('visitor')
    expect(budget.snapshot().used).toBe(1)
  })

  it.each([
    ['a YouTube page', 'https://www.youtube.com/s/player/abc/base.js'],
    ['googlevideo bytes', MEDIA],
    ['Spotify', GRAPHQL],
    ['a Last.fm station', STATION],
  ])('still refuses %s', async (_case, url) => {
    const { transport, sandbox } = await tier()
    expect(await refusedAsUnsupported(transport.fetch(url))).toBe(true)
    expect(sandbox?.requests).toEqual([])
  })

  it('stops using the sandbox the moment the kill switch is set', async () => {
    let switches: KillSwitches = {}
    const { transport } = await tier({ killSwitches: () => switches })
    await expect(transport.fetch(SEARCH, innerTubeInit())).resolves.toBeInstanceOf(Response)
    switches = { lite: true }
    expect(await refusedAsUnsupported(transport.fetch(SEARCH, innerTubeInit()))).toBe(true)
  })

  it('draws no budget for a call the sandbox could never send', async () => {
    const { transport, budget } = await tier({ sandbox: false })
    await rejection(transport.fetch(SEARCH, innerTubeInit()))
    expect(budget.snapshot().used).toBe(0)
  })

  it('reaches InnerTube once the Lite self-test passes', async () => {
    const { transport, lite } = await tier({ check: false })
    expect(transport.canReach(SEARCH)).toBe(false)
    await lite?.check()
    expect(transport.canReach(SEARCH)).toBe(true)
  })

  it('checks the route again after waiting for a budget slot: a kill switch set meanwhile wins', async () => {
    let switches: KillSwitches = {}
    const { transport, sandbox, clock } = await tier({ killSwitches: () => switches })
    const bulk = transport.withPriority('bulk')
    await bulk(SEARCH, innerTubeInit())
    const waiting = rejection(bulk(SEARCH, innerTubeInit()))
    await flushPromises()
    switches = { lite: true }
    await clock.advanceAsync(5_000)
    expect(isRouteUnavailable(await waiting)).toBe(true)
    expect(sandbox?.requests).toHaveLength(1)
  })
})

describe('the Full tier (FXM Connect)', () => {
  it('sends InnerTube calls through the page in the CORS-simple shape, even with Lite ready', async () => {
    const { transport, pageFetch, sandbox } = await tier({ connect: connected() })
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox?.requests).toEqual([])
    const [url, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${SEARCH}?prettyPrint=false`)
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': SIMPLE_CONTENT_TYPE },
    })
    expect(Object.keys(init.headers as object)).toEqual(['content-type'])
  })

  it.each([
    ['a YouTube page', 'https://www.youtube.com/sw.js_data', { Accept: '*/*' }],
    ['googlevideo bytes', MEDIA, { Range: 'bytes=0-65535' }],
    ['Spotify', GRAPHQL, { Authorization: 'Bearer token', 'Content-Type': 'application/json' }],
    ['a Last.fm station', STATION, { Accept: 'application/json' }],
  ])('fetches %s through the page, keeping its own headers', async (_case, url, headers) => {
    const { transport, pageFetch } = await tier({ connect: connected() })
    await transport.fetch(url, { headers, credentials: 'include' })
    const [sentUrl, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(sentUrl).toBe(url)
    expect(init.credentials).toBe('omit')
    expect(init.headers).toEqual(
      Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    )
  })

  it.each([
    ['youtube', SEARCH],
    ['youtube', 'https://www.youtube.com/sw.js_data'],
    ['googlevideo', MEDIA],
    ['spotify', GRAPHQL],
    ['lastfm', STATION],
  ])('needs the %s feature for %s', async (feature, url) => {
    const features = FAKE_CONNECT_FEATURES.filter((name) => name !== feature)
    const { transport } = await tier({ connect: connected(features), sandbox: false })
    expect(await refusedAsUnsupported(transport.fetch(url, innerTubeInit()))).toBe(true)
  })

  it('opens no route for an outdated FXM Connect, but keeps the Lite tier', async () => {
    const outdated: ConnectStatus = { ...connected(), state: 'outdated' }
    const { transport, sandbox, pageFetch } = await tier({ connect: outdated })
    expect(await refusedAsUnsupported(transport.fetch(MEDIA))).toBe(true)
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox?.requests).toHaveLength(1)
    expect(pageFetch).not.toHaveBeenCalled()
  })

  it('follows FXM Connect’s status on every request', async () => {
    const { transport, connect } = await tier({ sandbox: false })
    expect(await refusedAsUnsupported(transport.fetch(MEDIA))).toBe(true)
    connect.status = connected()
    await expect(transport.fetch(MEDIA)).resolves.toBeInstanceOf(Response)
  })

  it('refuses a call queued for its slot when FXM Connect went away in the meantime', async () => {
    const { transport, connect, pageFetch, clock } = await tier({
      connect: connected(),
      sandbox: false,
    })
    const bulk = transport.withPriority('bulk')
    await bulk(SEARCH, innerTubeInit())
    const waiting = rejection(bulk('https://www.youtube.com/sw.js_data'))
    await flushPromises()
    connect.status = { state: 'missing', features: [], lastSeenVersion: '0.1.0' }
    await clock.advanceAsync(5_000)
    expect(isRouteUnavailable(await waiting)).toBe(true)
    expect(pageFetch).toHaveBeenCalledOnce()
  })

  it('forwards the body of a Request, such as a Spotify GraphQL query', async () => {
    const { transport, pageFetch } = await tier({ connect: connected() })
    const query = JSON.stringify({ operationName: 'searchDesktop', variables: { q: 'creep' } })
    await transport.fetch(
      new Request(GRAPHQL, {
        method: 'POST',
        body: query,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      }),
    )
    const [, init] = pageFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(query)
    expect(init.headers).toEqual({ 'content-type': 'application/json;charset=UTF-8' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('the request budget', () => {
  it('counts InnerTube and other YouTube requests, but not other hosts', async () => {
    const { transport, budget } = await tier({ connect: connected() })
    await transport.fetch(SEARCH, innerTubeInit())
    await transport.fetch('https://www.youtube.com/sw.js_data')
    await transport.fetch(MEDIA)
    await transport.fetch(LYRICS)
    expect(budget.snapshot().used).toBe(2)
  })

  it('pauses bulk work when InnerTube answers 429', async () => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => new Response('', { status: 429 }),
    })
    const response = await transport.fetch(SEARCH, innerTubeInit())
    expect(response.status).toBe(429)
    expect(budget.snapshot().lastBotCheck?.cause).toBe('rate-limited')
    expect(budget.snapshot().bulkPausedUntil).toBeDefined()
  })

  it('pauses bulk work when a YouTube page answers 429', async () => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => new Response('', { status: 429 }),
    })
    await transport.fetch('https://www.youtube.com/sw.js_data')
    expect(budget.snapshot().lastBotCheck?.cause).toBe('rate-limited')
  })

  it('pauses bulk work on LOGIN_REQUIRED from /player, and leaves the body readable', async () => {
    const player = {
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
      },
    }
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => Response.json(player),
    })
    const response = await transport.fetch(PLAYER, innerTubeInit())
    await expect(response.json()).resolves.toEqual(player)
    expect(budget.snapshot().lastBotCheck?.cause).toBe('login-required')
  })

  it('counts a LOGIN_REQUIRED in another language as a bot check', async () => {
    const player = {
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Melde dich an, um zu bestätigen, dass du kein Bot bist',
      },
    }
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => Response.json(player),
    })
    await transport.fetch(PLAYER, innerTubeInit())
    expect(budget.snapshot().lastBotCheck?.cause).toBe('login-required')
  })

  it('leaves LOGIN_REQUIRED to the stream resolver when told to', async () => {
    const player = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } }
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => Response.json(player),
      reportLoginRequired: false,
    })
    await transport.fetch(PLAYER, innerTubeInit())
    expect(budget.snapshot().lastBotCheck).toBeUndefined()
  })

  it.each([
    [
      'an age gate (any language)',
      {
        playabilityStatus: {
          status: 'LOGIN_REQUIRED',
          reason: 'Inicia sesión para confirmar tu edad',
          desktopLegacyAgeGateReason: 1,
        },
      },
    ],
    [
      'an age gate in English, without the age-gate field',
      {
        playabilityStatus: {
          status: 'LOGIN_REQUIRED',
          errorScreen: {
            playerErrorMessageRenderer: {
              reason: { simpleText: 'Sign in to confirm your age' },
              subreason: { runs: [{ text: 'This video may be inappropriate for some users.' }] },
            },
          },
        },
      },
    ],
    [
      'a private video',
      { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'This video is private' } },
    ],
  ])('does not count %s as a bot check', async (_case, player) => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => Response.json(player),
    })
    await transport.fetch(PLAYER, innerTubeInit())
    expect(budget.snapshot().lastBotCheck).toBeUndefined()
  })

  it.each([
    ['a playable /player response', PLAYER, { playabilityStatus: { status: 'OK' } }],
    ['LOGIN_REQUIRED elsewhere in /player', PLAYER, { note: 'LOGIN_REQUIRED' }],
    [
      'LOGIN_REQUIRED in a search result',
      SEARCH,
      { playabilityStatus: { status: 'LOGIN_REQUIRED' } },
    ],
  ])('reports nothing for %s', async (_case, url, body) => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => Response.json(body),
    })
    await transport.fetch(url, innerTubeInit())
    expect(budget.snapshot().lastBotCheck).toBeUndefined()
  })

  it('reports nothing when the /player body is not JSON or not OK', async () => {
    const answers = [
      new Response('LOGIN_REQUIRED but not JSON'),
      new Response('{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}', { status: 500 }),
    ]
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => answers.shift() as Response,
    })
    await transport.fetch(PLAYER, innerTubeInit())
    await transport.fetch(PLAYER, innerTubeInit())
    expect(budget.snapshot().lastBotCheck).toBeUndefined()
  })

  it('draws at the priority of the fetch it came through', async () => {
    const { transport, budget, clock } = await tier({ connect: connected() })
    expect(transport.withPriority('interactive')).toBe(transport.fetch)
    expect(transport.withPriority('bulk')).toBe(transport.withPriority('bulk'))
    await transport.withPriority('bulk')(SEARCH, innerTubeInit())
    let second = false
    void transport
      .withPriority('bulk')(SEARCH, innerTubeInit())
      .then(() => {
        second = true
      })
    await clock.advanceAsync(4_999)
    expect(second).toBe(false)
    await transport.withPriority('current-track')(SEARCH, innerTubeInit())
    await clock.advanceAsync(1)
    expect(second).toBe(true)
    expect(budget.snapshot().used).toBe(3)
  })

  it('refuses unknown priorities', async () => {
    const { transport } = await tier()
    expect(() => transport.withPriority('urgent' as never)).toThrow(RangeError)
    expect(() => transport.withPriority('urgent' as never)).toThrow(/Unknown request priority/)
  })

  it('rejects a bulk call at once while bulk work is paused, sending nothing', async () => {
    const { transport, budget, pageFetch } = await tier({ connect: connected() })
    budget.reportBotCheck('login-required')
    const error = await rejection(transport.withPriority('bulk')(SEARCH, innerTubeInit()))
    expect(isBudgetError(error, 'paused')).toBe(true)
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(30 * 60_000)
    expect(pageFetch).not.toHaveBeenCalled()
    // Playback goes on.
    await expect(
      transport.withPriority('current-track')(SEARCH, innerTubeInit()),
    ).resolves.toBeInstanceOf(Response)
  })

  it('lets a bulk call wait briefly for its turn, but not behind a queue', async () => {
    const { transport, budget, clock } = await tier({ connect: connected() })
    const bulk = transport.withPriority('bulk')
    await bulk(SEARCH, innerTubeInit())
    const second = bulk(SEARCH, innerTubeInit())
    const third = bulk(SEARCH, innerTubeInit())
    expect(isBudgetError(await rejection(third), 'spacing')).toBe(true)
    await clock.advanceAsync(5_000)
    await expect(second).resolves.toBeInstanceOf(Response)
    expect(budget.snapshot().used).toBe(2)
  })

  it('refuses at once when the signal is already aborted', async () => {
    const { transport, budget, pageFetch } = await tier({ connect: connected() })
    const signal = AbortSignal.abort(new Error('gone'))
    const error = await rejection(transport.fetch(SEARCH, { ...innerTubeInit(), signal }))
    expect((error as Error).message).toBe('gone')
    expect(budget.snapshot().used).toBe(0)
    expect(pageFetch).not.toHaveBeenCalled()
  })
})

describe('hosts the user added', () => {
  const INSTANCE = 'https://invidious.example.org:8443/api/v1/videos/x'

  it('go through the sandbox’s user-host document, GET only and without headers', async () => {
    const { transport, sandbox, pageFetch } = await tier({
      userHosts: [' Invidious.Example.org:8443 '],
      sandbox: { userHost: () => Response.json({ title: 'x' }) },
    })
    const response = await transport.fetch(INSTANCE, { headers: { Authorization: 'x' } })
    await expect(response.json()).resolves.toEqual({ title: 'x' })
    expect(sandbox?.userHostRequests).toEqual([{ url: INSTANCE, init: { method: 'GET' } }])
    await transport.fetch(INSTANCE, { method: 'HEAD', signal: new AbortController().signal })
    expect(sandbox?.userHostRequests[1]?.init.method).toBe('HEAD')
    expect(pageFetch).not.toHaveBeenCalled()
    expect(
      await refusedAsUnsupported(transport.fetch(INSTANCE, { method: 'POST', body: 'x' })),
    ).toBe(true)
  })

  it('are refused without the sandbox documents, and when not added', async () => {
    const withoutDocument = await tier({ userHosts: ['invidious.example.org:8443'] })
    expect(await refusedAsUnsupported(withoutDocument.transport.fetch(INSTANCE))).toBe(true)
    const notAdded = await tier({ sandbox: { userHost: () => Response.json({}) } })
    expect(await refusedAsUnsupported(notAdded.transport.fetch(INSTANCE))).toBe(true)
    const plainHttp = await tier({
      userHosts: ['invidious.example.org'],
      sandbox: { userHost: () => Response.json({}) },
    })
    expect(
      await refusedAsUnsupported(plainHttp.transport.fetch('http://invidious.example.org/')),
    ).toBe(true)
  })
})

describe('redirects', () => {
  /** A response the browser got after following redirects to `url`. */
  function landedAt(url: string, body: BodyInit | null = '{}'): Response {
    const response = new Response(body)
    Object.defineProperty(response, 'redirected', { value: true })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }

  it('accepts a response that ended on a host of the same class', async () => {
    const { transport } = await tier({
      respond: () => landedAt('https://ia800300.us.archive.org/1/items/x/01.flac'),
    })
    const response = await transport.fetch('https://archive.org/download/x/01.flac')
    expect(response.status).toBe(200)
  })

  it.each([
    ['outside the host table', 'https://evil.example/x'],
    ['on a host of another class', 'https://www.youtube.com/sw.js_data'],
  ])('refuses a response that ended %s', async (_case, url) => {
    const { transport } = await tier({ respond: () => landedAt(url) })
    const error = await rejection(transport.fetch('https://archive.org/download/x/01.flac'))
    expect(isTransportError(error, 'redirect')).toBe(true)
    expect((error as Error).message).not.toContain('?')
  })

  it('counts a detour to Google’s "unusual traffic" page as a bot check', async () => {
    const { transport, budget } = await tier({
      connect: connected(),
      respond: () => landedAt('https://www.google.com/sorry/index?continue=x', '<html>'),
    })
    const error = await rejection(transport.fetch(SEARCH, innerTubeInit()))
    expect(isFxmError(error, 'BotCheck')).toBe(true)
    expect(budget.snapshot().lastBotCheck?.cause).toBe('rate-limited')
  })

  it('ignores responses that were not redirected, or say nothing about it', async () => {
    const unredirected = new Response('{}')
    Object.defineProperty(unredirected, 'url', { value: 'https://evil.example/' })
    const { transport } = await tier({ respond: () => unredirected })
    await expect(transport.fetch(LYRICS)).resolves.toBe(unredirected)
    const { transport: other } = await tier({ respond: () => landedAt('') })
    await expect(other.fetch(LYRICS)).resolves.toBeInstanceOf(Response)
  })
})

describe('defaults', () => {
  it('uses the global fetch when given none', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    try {
      const transport = createWebTransport({ budget: createRequestBudget() })
      await transport.fetch(LYRICS)
      expect(spy).toHaveBeenCalledOnce()
      expect(transport.budget.snapshot().used).toBe(0)
      expect(await refusedAsUnsupported(transport.fetch(SEARCH, innerTubeInit()))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('all three tiers against the fake FXM Connect and the fake sandbox', () => {
  const pages: { happyDOM: { close(): Promise<void> } }[] = []
  afterEach(async () => {
    await Promise.all(pages.splice(0).map((page) => page.happyDOM.close()))
  })

  async function page(pass: boolean) {
    const window = new Window({ url: 'https://fxmusic.pages.dev/app/' })
    pages.push(window)
    const view = window as unknown as ConnectWindow
    const connect = createConnectClient({ window: view, storage: memoryStorage() })
    const sandbox = createFakeSandbox({ selfTest: pass ? 'pass' : 'refused' })
    const lite = createLiteTier({ sandbox })
    await lite.check()
    const pageFetch = vi.fn(async () => Response.json({}))
    const transport = createWebTransport({
      fetch: pageFetch as typeof fetch,
      connect,
      lite,
      budget: createRequestBudget(),
    })
    return { view, connect, sandbox, pageFetch, transport }
  }

  it('Free only: no YouTube, Spotify or Last.fm, free sources direct', async () => {
    const { connect, transport, pageFetch } = await page(false)
    expect((await connect.detect()).state).toBe('absent')
    await transport.fetch(LYRICS)
    expect(pageFetch).toHaveBeenCalledOnce()
    for (const url of [SEARCH, MEDIA, GRAPHQL, STATION]) {
      expect(await refusedAsUnsupported(transport.fetch(url, innerTubeInit()))).toBe(true)
    }
    connect.dispose()
  })

  it('Lite: InnerTube through the sandbox, nothing else of YouTube, Spotify or Last.fm', async () => {
    const { connect, transport, sandbox, pageFetch } = await page(true)
    await connect.detect()
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox.requests).toHaveLength(1)
    expect(pageFetch).not.toHaveBeenCalled()
    for (const url of [MEDIA, GRAPHQL, STATION]) {
      expect(await refusedAsUnsupported(transport.fetch(url))).toBe(true)
    }
    connect.dispose()
  })

  it('Full: everything through the page, and back to Lite when FXM Connect goes away', async () => {
    const { view, connect, transport, sandbox, pageFetch } = await page(true)
    const extension = installFakeConnect(view)
    expect((await connect.detect()).state).toBe('present')
    for (const url of [SEARCH, MEDIA, GRAPHQL, STATION]) {
      await transport.fetch(url, url === SEARCH ? innerTubeInit() : {})
    }
    expect(pageFetch).toHaveBeenCalledTimes(4)
    expect(sandbox.requests).toEqual([])
    extension.uninstall()
    await vi.waitFor(() => expect(connect.status?.state).toBe('missing'), PATIENCE)
    await transport.fetch(SEARCH, innerTubeInit())
    expect(sandbox.requests).toHaveLength(1)
    expect(await refusedAsUnsupported(transport.fetch(MEDIA))).toBe(true)
    connect.dispose()
  })
})
